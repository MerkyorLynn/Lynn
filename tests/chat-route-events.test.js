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

  it("suppresses pseudo-tool XML and recovers for Brain default model text", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳天气如何" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: '<web_search>\n深圳 2026年4月28日 天气预报\n</web_search>',
      },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      noticeKey: "status.defaultModelRecoveringToolExecution",
    }));
    expect(clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("")).not.toContain("<web_search>");
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

  it("suppresses pseudo bash XML even after a real tool call already ran", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "移动下载文件夹的 pdf 文件到 pdf 文件夹" }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /Users/licheng/Downloads | head" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /Users/licheng/Downloads | head" },
      result: { output: "a.pdf\nb.pdf\n" },
      isError: false,
    }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: [
          "好的，我来执行。先创建 PDF 文件夹，然后移动所有 PDF 文件。",
          "",
          "<bash>",
          "mkdir -p \"/Users/licheng/Downloads/pdf\"",
          "find \"/Users/licheng/Downloads\" -maxdepth 1 -type f -iname \"*.pdf\" -exec mv {} \"/Users/licheng/Downloads/pdf/\" \\;",
          "</bash>",
        ].join("\n"),
      },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<bash>");
    expect(visibleText).not.toContain("mkdir -p");
  });

  it("suppresses fragmented pseudo web_search XML across streaming chunks", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳会下雨吗？" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "<web_search>" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "\n深圳 2026年4月28日 天气预报\n" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "</web_search>" },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<web_search>");
    expect(visibleText).not.toContain("深圳 2026年4月28日 天气预报");
  });

  it("retries when a real tool ran but the assistant only says it will continue executing", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "把 /tmp/lynn-pdf-move-test 文件夹里的 pdf 文件移动到这个文件夹下新建的 pdf 文件夹里";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /tmp/lynn-pdf-move-test" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /tmp/lynn-pdf-move-test" },
      result: { output: "a.pdf\nb.PDF\nnote.txt\n" },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "找到 2 个 PDF 文件（`a.pdf` 和 `b.PDF`），开始创建文件夹并移动。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      reason: "tool_continuation",
    }));
    expect(hub.send).toHaveBeenCalledTimes(2);
    const retryPrompt = hub.send.mock.calls.at(-1)?.[0] || "";
    expect(retryPrompt).toContain("继续调用真实工具");
    expect(retryPrompt).toContain("没有继续调用真实工具完成任务");
    expect(retryPrompt).toContain(prompt);
  });

  // [TOOL-FAILED-FALLBACK v1 · 2026-04-28] 工具失败 + 短开场句:必须再给一轮机会让模型给"基于常识/无法核实"的兜底答
  // 复现 V8 T08 case:live_news 工具失败,模型只回 "两个任务一起处理。" 9c → 用户拿到无意义短答
  it("retries when a tool failed and the assistant only produced a short throat-clearing lead-in", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "【T08】给今天科技/AI 领域 2 条重要新闻,每条含发生日期、来源链接、为什么重要。";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI 新闻" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI 新闻" },
      result: { error: "fetch failed" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "两个任务一起处理。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      reason: "tool_failed_fallback",
    }));
    expect(hub.send).toHaveBeenCalledTimes(2);
    const retryPrompt = hub.send.mock.calls.at(-1)?.[0] || "";
    expect(retryPrompt).toContain("工具失败");
    expect(retryPrompt).toContain("不要再次调用工具");
    expect(retryPrompt).toContain("live_news");
    expect(retryPrompt).toContain(prompt);
  });

  // 同源 case:工具调用成功但模型只回 "好的" 这种 < 30c 短句也兜底
  it("retries when a tool failed and the assistant produced a sub-30-char generic answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "今日金价多少?";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_stock",
      toolName: "stock_market",
      args: { query: "今日金价" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_stock",
      toolName: "stock_market",
      args: { query: "今日金价" },
      result: { error: "rate limit" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "好的。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      reason: "tool_failed_fallback",
    }));
  });

  // [TOOL-FAILED-FALLBACK v1.1 · 2026-04-28] 0c case (V8 v7 T08):工具失败 + 模型 0 文本
  it("retries when a tool failed and the assistant produced ZERO text (T08 case)", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "【T08】今日科技 AI 新闻 2 条";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI" },
      result: { error: "fetch failed" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
    // 模型产 0 文本 → 直接 turn_end 第二次(deferred 后)
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      reason: "tool_failed_fallback",
    }));
    expect(hub.send).toHaveBeenCalledTimes(2);
    const retryPrompt = hub.send.mock.calls.at(-1)?.[0] || "";
    expect(retryPrompt).toContain("工具失败");
    expect(retryPrompt).toContain("live_news");
  });

  // 反向 case:工具成功 + 短答应该 NOT 触发 fallback (避免误伤)
  it("does NOT trigger tool_failed_fallback when the tool succeeded with a short answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天上海天气?" }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_w",
      toolName: "weather",
      args: { city: "shanghai" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_w",
      toolName: "weather",
      args: { city: "shanghai" },
      result: { output: "晴 22°C" },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "上海今天晴 22°C。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    const retryEvents = clients[0].sent.filter((e) => e.type === "turn_retry" && e.reason === "tool_failed_fallback");
    expect(retryEvents).toHaveLength(0);
  });

  // [INTERNAL-RETRY-CROSS-PROMPT-FENCE v1 · 2026-04-28] V8 v6 T05/T06 跨测污染修复
  // 旧行为:T05 空答 → 调度 internal retry → T05 ws 关闭 → T06 ws 连同 session 时 retry 还在跑
  //         → "Lynn 还在说话" 错误 + retry 的 text_delta 仍 broadcast 到 T06 → T05 答案串到 T06
  // 新行为:T06 进来时检测到 streamSource==='internal_retry' → 视为可释放 → 中止旧 retry → T06 走新流
  it("aborts an in-flight internal retry when a new user prompt arrives mid-retry", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.abortSessionByPath = vi.fn(async () => true);
    // 关键:让 hub.send 的第一次调用挂起(模拟 retry 仍在跑)
    let firstCallResolve;
    const sends = [];
    hub.send = vi.fn((prompt, ctx) => {
      sends.push({ prompt, ctx });
      if (sends.length === 1) {
        // 第 1 次发送:用户 T05 prompt,挂起让我们手工触发 empty_reply
        return Promise.resolve();
      }
      if (sends.length === 2) {
        // 第 2 次:internal retry 触发,挂起模拟它在跑
        return new Promise((resolve) => { firstCallResolve = resolve; });
      }
      // 第 3 次:T06 新 prompt 应能正常 send 出去
      return Promise.resolve();
    });

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    // T05 prompt
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "T05 在上海做晚餐" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));

    // T05 模型给 turn_end 但没有任何文本 → empty_reply 路径触发 internal retry
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
    await Promise.resolve();
    await Promise.resolve();

    // 应该已发起 retry(第 2 次 hub.send)
    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2), { timeout: 1000 });

    // 验证 turn_retry 事件被 broadcast
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_retry",
      reason: "empty_reply",
    }));

    // 此时 retry 还在跑,模拟 isSessionStreaming=true(第 2 个 hub.send 还没 resolve)
    engine.isSessionStreaming = vi.fn(() => true);

    // T06 进来发新 prompt
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "T06 推荐电影" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(engine.abortSessionByPath).toHaveBeenCalled(), { timeout: 1000 });

    // 关键断言:旧 retry 被中止 → 没收到 "Lynn 还在说话" 错误
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("还在说话"),
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("still"),
    }));

    // 让旧 retry 的 hub.send promise 解掉,清理悬挂
    firstCallResolve?.();
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

  // Brain 默认仍保留自主工具判断；但天气/金价/新闻这类实时直答必须有本地证据兜底，
  // 否则远端模型一旦输出伪 web_search，用户只能看到“未检索到明确证据”。
  it("injects local realtime prefetch for brain weather turns", async () => {
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
    expect(reportResearchMock.buildReportResearchContext).toHaveBeenCalled();
  });

  it("does not inject local prefetch for non-realtime brain turns", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let eventsBeforeModelCall = [];
    hub.send = vi.fn(async () => {
      eventsBeforeModelCall = [...clients[0].sent];
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("generic");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成研究预取】");
    reportResearchMock.buildReportResearchContext.mockClear();

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我写一个普通研究计划" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    expect(eventsBeforeModelCall).not.toContainEqual(expect.objectContaining({ type: "tool_start" }));
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
