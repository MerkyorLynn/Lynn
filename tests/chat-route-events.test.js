import { Hono } from "hono";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportResearchMock = vi.hoisted(() => ({
  buildReportResearchContext: vi.fn(),
  buildDirectResearchAnswer: vi.fn(),
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
      createSession: vi.fn(async () => ({
        sessionManager: { getSessionFile: () => "/sessions/current.jsonl" },
      })),
      resolveModelOverrides: vi.fn((model) => model),
      abortAllStreaming: vi.fn(async () => 0),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      isSessionStreaming: vi.fn(() => false),
      promptSession: vi.fn(),
      steerSession: vi.fn(() => false),
      abortSession: vi.fn(() => false),
      cwd: process.cwd(),
    };
    reportResearchMock.buildReportResearchContext.mockResolvedValue("");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("");
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
    hub.send = vi.fn(() => new Promise(() => {}));

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请执行终端命令 echo hi" }),
    }, connections[0].client);

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
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "请修改 sample.txt" }),
      }, connections[0].client);

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
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我查一下深圳天气" }),
    }, connections[0].client);

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

  it("aborts the first silent Brain tool turn after the 25s grace window", async () => {
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

  // [BYOK-EQUALITY · 2026-04-27 night] brain 模式下不再做本地预取 —— 工具决策权全交 brain/模型自己判断,
  // 跟 BYOK 走同一套自主判断路径。测试反转:验证 brain 模式 prefetch 被 SKIP,事件流里没有 tool_start。
  it("does NOT inject local prefetch when running on brain (lets brain own tool routing)", async () => {
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

    // 关键:brain 模式不该出现本地 prefetch 的 tool_start/tool_end —— 那些应该让 brain 端真实调工具产生
    expect(eventsBeforeModelCall).not.toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "weather",
    }));
    expect(eventsBeforeModelCall).not.toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "weather",
    }));
    // buildReportResearchContext 也不该被调(brain 路径完全跳过本地预取)
    expect(reportResearchMock.buildReportResearchContext).not.toHaveBeenCalled();
  });

  // 保留对非 brain (BYOK) 路径的 prefetch 覆盖 —— 当前实现 chat.js:1338 仅 gate 在 isBrain,
  // 非 brain provider 仍走 prefetch。后续如果决定全 provider 都移除,这条改成 .skip 即可。
  it("still injects local prefetch as a tool stage for non-brain providers (BYOK path)", async () => {
    engine.currentModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
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

  it("creates a session on the first prompt when currentSessionPath is empty", async () => {
    engine.currentSessionPath = "";
    engine.createSession = vi.fn(async () => ({
      sessionManager: { getSessionFile: () => "/sessions/new.jsonl" },
    }));
    reportResearchMock.inferReportResearchKind.mockReturnValue("market_weather_brief");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成综合工具预取】");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("数据快照\n- AAPL：$273.05");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请同时看一下今天 AAPL 最新价和上海天气" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(engine.createSession).toHaveBeenCalled());

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "market_weather_brief",
      sessionPath: "/sessions/new.jsonl",
    }));
    await vi.waitFor(() => {
      expect(
        clients[0].sent.some((evt) => evt.type === "text_delta"
          && evt.sessionPath === "/sessions/new.jsonl"
          && String(evt.delta || "").includes("AAPL")),
      ).toBe(true);
    });
  });

  it("suppresses hallucinated tool-progress XML that only flushes at turn end", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我查一下今天金价" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "正在核对资料。<lynn_tool_progress event=\"start\" name=\"web_search\"></lynn_tool_progress>今天金价偏强。",
      },
    }, "/sessions/current.jsonl");

    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "tool_progress",
    }));

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");

    expect(visibleText).toContain("正在核对资料。");
    expect(visibleText).toContain("今天金价偏强。");
    expect(visibleText).not.toContain("<lynn_tool_progress");
  });

  it("still aborts a silent Brain turn even after local prefetch has evidence", async () => {
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
      await vi.advanceTimersByTimeAsync(25_001);

      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
    } finally {
      vi.useRealTimers();
    }
  });

  // [BYOK-EQUALITY · 2026-04-27 night] retry-after-prefetch 仅适用于 prefetch 还在的路径(非 brain)。
  // 改 provider=openai 来保留这条覆盖。后续若全 provider 都移除 prefetch,这条改 .skip 即可。
  it("still retries pending-tool text after local prefetch evidence (non-brain path)", async () => {
    engine.currentModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
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
