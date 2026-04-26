import { Hono } from "hono";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportResearchMock = vi.hoisted(() => ({
  buildReportResearchContext: vi.fn(),
  inferReportResearchKind: vi.fn(),
}));

vi.mock("../server/chat/report-research-context.js", () => reportResearchMock);

import { createChatRoute } from "../server/routes/chat.js";

function makeWebSocketHarness() {
  const clients = [];
  const connections = [];
  const upgradeWebSocket = (factory) => (c) => {
    const client = {
      readyState: 1,
      sent: [],
      close: vi.fn(),
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    clients.push(client);
    const handlers = factory(c);
    connections.push({ client, handlers });
    handlers.onOpen?.({}, client);
    return new Response(null, { status: 200 });
  };
  return { clients, connections, upgradeWebSocket };
}

describe("chat route event forwarding", () => {
  let subscribed;
  let hub;
  let engine;
  let app;
  let clients;
  let connections;
  let editRollbackStore;

  beforeEach(() => {
    subscribed = null;
    hub = {
      subscribe: vi.fn((handler) => {
        subscribed = handler;
        return () => {};
      }),
    };
    engine = {
      currentSessionPath: "/sessions/current.jsonl",
      abortAllStreaming: vi.fn(async () => 0),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      isSessionStreaming: vi.fn(() => false),
      promptSession: vi.fn(),
      steerSession: vi.fn(() => false),
      abortSession: vi.fn(() => false),
      cwd: process.cwd(),
    };
    reportResearchMock.buildReportResearchContext.mockResolvedValue("");
    reportResearchMock.inferReportResearchKind.mockReturnValue("");
    const wsHarness = makeWebSocketHarness();
    clients = wsHarness.clients;
    connections = wsHarness.connections;
    const route = createChatRoute(engine, hub, { upgradeWebSocket: wsHarness.upgradeWebSocket });
    editRollbackStore = route.editRollbackStore;
    app = new Hono();
    app.route("", route.wsRoute);
  });

  it("forwards tool_authorization events to websocket clients", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);
    expect(typeof subscribed).toBe("function");

    subscribed({
      type: "tool_authorization",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      reason: "blocked",
      description: "needs confirmation",
      category: "elevated_command",
      identifier: "sudo",
    }, "/sessions/current.jsonl");

    expect(clients).toHaveLength(1);
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_authorization",
      sessionPath: "/sessions/current.jsonl",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      category: "elevated_command",
    }));
  });

  it("captures edit snapshots and emits rollbackId on file_diff events", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lynn-chat-route-"));
    const filePath = path.join(tmpDir, "sample.txt");
    try {
      await fsPromises.writeFile(filePath, "before\n", "utf8");
      engine.getSessionByPath = vi.fn(() => ({
        sessionManager: { getCwd: () => tmpDir },
        messages: [],
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
      }, "/sessions/current.jsonl");

      await fsPromises.writeFile(filePath, "after\n", "utf8");

      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
        result: { details: { diff: "@@ -1 +1 @@\n-before\n+after" } },
        isError: false,
      }, "/sessions/current.jsonl");

      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "file_diff",
        rollbackId: "call_123",
        filePath: "sample.txt",
      }));

      expect(editRollbackStore.get("call_123")).toEqual(expect.objectContaining({
        rollbackId: "call_123",
        filePath,
        originalContent: "before\n",
      }));
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts security_mode updates", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    subscribed({ type: "security_mode", mode: "safe" }, "/sessions/current.jsonl");

    expect(clients[0].sent).toContainEqual({ type: "security_mode", mode: "safe" });
  });

  it("does not trigger pseudo-tool recovery for Brain default model text", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: 'web_search(query="深圳天气")',
      },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      noticeKey: "status.defaultModelRecoveringToolExecution",
    }));
  });

  it("still triggers pseudo-tool recovery for non-Brain model text", async () => {
    engine.currentModel = { id: "kimi-k2.5", provider: "moonshot", name: "Kimi K2.5" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: 'web_search(query="深圳天气")',
      },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      noticeKey: "status.recoveringToolExecution",
    }));
  });

  it("aborts the first silent Brain tool turn after the grace window", async () => {
    vi.useFakeTimers();
    let rejectSend;
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise((resolve, reject) => {
        rejectSend = reject;
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "请执行终端命令 echo hi" }),
      }, connections[0].client);

      await vi.advanceTimersByTimeAsync(24_999);
      expect(engine.abortSessionByPath).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");

      rejectSend?.(new Error("aborted"));
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows local prefetch as a real tool stage before asking the model to summarize", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let eventsBeforeModelCall = [];
    hub.send = vi.fn(async () => {
      eventsBeforeModelCall = [...clients[0].sent];
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "weather",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "weather",
      success: true,
      sessionPath: "/sessions/current.jsonl",
    }));
  });

  it("does not abort a silent Brain turn after local prefetch has evidence", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));
      reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
      reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
      }, connections[0].client);

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_001);

      expect(engine.abortSessionByPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retries pending-tool text after local prefetch evidence", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let modelCallCount = 0;
    hub.send = vi.fn(async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        subscribed({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "我来搜索一下天气资料。",
          },
        }, "/sessions/current.jsonl");
        subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
      }
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2));

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      sessionPath: "/sessions/current.jsonl",
    }));
  });
});
