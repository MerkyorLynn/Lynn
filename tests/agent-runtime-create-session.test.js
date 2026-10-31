import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLynnAgentSession } from "../core/agent-runtime/create-session.js";
import { SessionManager } from "../core/agent-runtime/session-manager.js";
import { createSessionResourceLoader } from "../core/session-resource-loader.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

function failingSseResponse(chunks, error = new Error("stream disconnected after content")) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
          return;
        }
        controller.error(error);
      },
    }),
  };
}

async function waitFor(condition, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

describe("createLynnAgentSession native runtime", () => {
  let tempDir;
  let originalFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-native-runtime-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sends source-preservation instructions without rewriting the user's material", async () => {
    const prompt = "整理行动项：Morgan 后天交初稿，我本周联系合作方，审批时间待定。";
    globalThis.fetch = vi.fn(async () => sseResponse(['data: {"choices":[{"delta":{"content":"材料已整理。"}}]}\n\n', "data: [DONE]\n\n"]));
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      resourceLoader: createSessionResourceLoader({ baseResourceLoader: { getAppendSystemPrompt: () => "Keep source facts intact." }, sessionEntry: {}, effectiveModel: null, getAgent: () => ({}), getHomeCwd: () => null }),
      model: { id: "test-model", provider: "test-provider", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });
    await session.prompt(prompt);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const system = body.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    expect(system).toContain("Keep source facts intact.");
    expect(system).toContain("保留所有事项、实体、负责人（包括第一人称）、时间和不确定性");
    expect(system).toContain("除非用户要求换算日期，否则保留原文相对时间");
    expect(system).toContain("用户要求核验或执行时，仍由模型选择适合的工具与参数");
    expect(body.messages).toContainEqual(expect.objectContaining({ role: "user", content: prompt }));
  });

  it.each(["brain", "test-provider"])("forwards Brain tool progress only from a trusted model transport: %s", async (provider) => {
    globalThis.fetch = vi.fn(async () => sseResponse([
      'data: {"object":"lynn.tool_progress","tool_progress":{"name":"weather","event":"end","ok":true,"args_summary":"顺德大良","summary":"预报已核验","details":["provider: cma"]}}\n\n',
      'data: {"choices":[{"delta":{"content":"天气已核验。"}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: { id: "test-model", provider, api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });
    const events = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("查询天气");
    const progress = events.filter((event) => event.type === "tool_progress");
    if (provider === "brain") {
      expect(progress).toEqual([expect.objectContaining({ source: "brain", name: "weather", event: "end", ok: true, argsSummary: "顺德大良", summary: "预报已核验", details: ["provider: cma"] })]);
    } else {
      expect(progress).toEqual([]);
    }
  });

  it("retains full Brain tool evidence when a later round invokes a client tool", async () => {
    const serverCall = { id: "server-weather", type: "function", function: { name: "weather", arguments: '{"city":"顺德大良"}' } };
    const sourceResult = "顺德大良预报：明晚晴。provider: cma。完整来源结果。";
    globalThis.fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (globalThis.fetch.mock.calls.length === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ object: "lynn.tool_progress", tool_progress: { event: "end", name: "weather", ok: true, tool_call: serverCall, result: sourceResult } })}\n\n`,
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"client-read","function":{"name":"read_note","arguments":"{}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      expect(body.messages).toContainEqual(expect.objectContaining({ role: "tool", name: "weather", tool_call_id: serverCall.id, content: sourceResult }));
      expect(body.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: [serverCall] }));
      expect(body.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "client-read" }));
      return sseResponse(['data: {"choices":[{"delta":{"content":"预报与本地记录均已核验。"}}]}\n\n', "data: [DONE]\n\n"]);
    });
    const manager = SessionManager.create(tempDir, tempDir);
    const localTool = vi.fn(async () => ({ content: [{ type: "text", text: "本地记录" }] }));
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "brain", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
      tools: [{ name: "read_note", description: "read local note", parameters: { type: "object", properties: {} }, execute: localTool }],
    });
    await session.prompt("查询预报并读取本地记录");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(localTool).toHaveBeenCalledTimes(1);
    expect(manager.buildSessionContext().messages).toContainEqual(expect.objectContaining({ role: "tool", name: "weather", content: sourceResult }));
  });

  it("queues follow-up prompts while a turn is streaming instead of recursing or throwing", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
    });

    session.isStreaming = true;
    await expect(session.followUp("queued message")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    session.isStreaming = false;
    session.drainPendingPrompts();
    await waitFor(() => fetchMock.mock.calls.length === 1);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages.at(-1)).toMatchObject({
      role: "user",
      content: "queued message",
    });
  });

  it("quarantines an aborted tool result from the next turn", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"slow-1\",\"function\":{\"name\":\"slow_find\",\"arguments\":\"{}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"SECOND_OK\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    let toolStarted = false;
    const events = [];
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [{
        name: "slow_find",
        description: "slow cancellable tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async (_id, _params, runtime) => {
          toolStarted = true;
          await new Promise((resolve, reject) => {
            runtime.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
          return { content: [{ type: "text", text: "LATE_RESULT" }] };
        }),
      }],
    });
    session.subscribe((event) => events.push(event));

    const firstTurn = session.prompt("first turn");
    await waitFor(() => toolStarted);
    session.abort();
    const secondTurn = session.prompt("second turn");
    await Promise.all([firstTurn, secondTurn]);

    const messages = manager.buildSessionContext().messages;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("LATE_RESULT");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "SECOND_OK" });
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(0);
  });

  it("drops nameless streamed tool calls instead of executing empty tool cards", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"query\\\":\\\"世界杯\\\"}\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"工具证据已整理。\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [{
        name: "web_search",
        description: "search",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => ({ content: [{ type: "text", text: "should not run" }] })),
      }],
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("世界杯");

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    const messages = manager.buildSessionContext().messages;
    expect(messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("Tool not found");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "工具证据已整理。",
    });
  });

  it("exposes deliverable tools only when the current turn explicitly asks for a file", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"已回答。\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [
        { name: "read", description: "read", parameters: { type: "object", properties: {} } },
        { name: "create_artifact", description: "artifact", parameters: { type: "object", properties: {} } },
        { name: "create-report", description: "report", parameters: { type: "object", properties: {} } },
      ],
    });

    await session.prompt("帮我整理一个赛博朋克小说的世界观设定表");
    await session.prompt("把刚才的内容导出成 PDF 报告");

    const firstTools = JSON.parse(fetchMock.mock.calls[0][1].body).tools.map((tool) => tool.function.name);
    const secondTools = JSON.parse(fetchMock.mock.calls[1][1].body).tools.map((tool) => tool.function.name);
    expect(firstTools).toEqual(["read"]);
    expect(secondTools).toEqual(["read", "create_artifact", "create-report"]);
  });

  it("exposes image mutation tools only when the current turn explicitly asks for visual output", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"已回答。\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [
        { name: "read", description: "read", parameters: { type: "object", properties: {} } },
        { name: "flux-studio.generate_image", description: "generate", parameters: { type: "object", properties: {} } },
        { name: "flux-studio_edit_image", description: "edit", parameters: { type: "object", properties: {} } },
        { name: "view_image", description: "view", parameters: { type: "object", properties: {} } },
      ],
    });

    await session.prompt("给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威");
    await session.prompt("为这个人物生成一张小说封面图片");

    const firstTools = JSON.parse(fetchMock.mock.calls[0][1].body).tools.map((tool) => tool.function.name);
    const secondTools = JSON.parse(fetchMock.mock.calls[1][1].body).tools.map((tool) => tool.function.name);
    expect(firstTools).toEqual(["read", "view_image"]);
    expect(secondTools).toEqual(["read", "flux-studio.generate_image", "flux-studio_edit_image", "view_image"]);
  });

  it("exposes todo only for explicit task state changes or operational agent work", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"已回答。\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [
        { name: "read", description: "read", parameters: { type: "object", properties: {} } },
        { name: "todo", description: "todo", parameters: { type: "object", properties: {} } },
      ],
    });

    await session.prompt("帮一个两周项目拆 OKR，目标是上线一个后端回归测试工具");
    await session.prompt("把买牛奶加入我的待办");
    await session.prompt("修复这个仓库的登录 bug，测试通过后提交代码");

    const toolNames = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).tools.map((tool) => tool.function.name));
    expect(toolNames).toEqual([
      ["read"],
      ["read", "todo"],
      ["read", "todo"],
    ]);
  });

  it("does not expose Brain-managed tools to the local native runtime for Brain models", async () => {
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "brain-router",
        provider: "brain",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [
        { name: "read", description: "read file", parameters: { type: "object", properties: {} } },
        { name: "web_search", description: "brain-owned search", parameters: { type: "object", properties: {} } },
      ],
      customTools: [
        { name: "web-search", description: "local search skill must not run for Brain", parameters: { type: "object", properties: {} } },
        { name: "stock_market", description: "brain-owned quote", parameters: { type: "object", properties: {} } },
        { name: "present-files", description: "local helper", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(session.getActiveToolNames()).toEqual(["read", "present-files"]);
  });

  it("uses a one-turn Brain override without changing the persisted session model", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"Brain fallback answer\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const localModel = {
      id: "local-qwen",
      provider: "local-llamacpp",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:65530/v1",
      apiKey: "local-key",
    };
    const brainModel = {
      id: "brain-router",
      provider: "brain",
      api: "openai-completions",
      baseUrl: "https://brain.example.test/v1",
      apiKey: "brain-key",
    };
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: localModel,
      tools: [
        { name: "read", description: "read file", parameters: { type: "object", properties: {} } },
        { name: "web_search", description: "brain-owned search", parameters: { type: "object", properties: {} } },
      ],
    });

    await session.prompt("retry via Brain", { modelOverride: brainModel });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://brain.example.test/v1/chat/completions");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.tools.map((tool) => tool.function.name)).toEqual(["read"]);
    expect(session.model).toMatchObject({ id: "local-qwen", provider: "local-llamacpp" });
    expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Brain fallback answer",
    });
  });

  it("clears a one-turn model override before draining a queued follow-up", async () => {
    let releaseFirst;
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return await new Promise((resolve) => {
          releaseFirst = () => resolve(sseResponse([
            "data: {\"choices\":[{\"delta\":{\"content\":\"fallback done\"}}]}\n\n",
            "data: [DONE]\n\n",
          ]));
        });
      }
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"local follow-up\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]);
    });
    globalThis.fetch = fetchMock;
    const localModel = {
      id: "local-qwen",
      provider: "local-llamacpp",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:65530/v1",
    };
    const brainModel = {
      id: "brain-router",
      provider: "brain",
      api: "openai-completions",
      baseUrl: "https://brain.example.test/v1",
    };
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: localModel,
    });

    const firstTurn = session.prompt("first", { modelOverride: brainModel });
    await waitFor(() => fetchMock.mock.calls.length === 1);
    await session.followUp("second");
    releaseFirst();
    await firstTurn;
    await waitFor(() => fetchMock.mock.calls.length === 2);

    expect(fetchMock.mock.calls[0][0]).toBe("https://brain.example.test/v1/chat/completions");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:65530/v1/chat/completions");
  });

  it("exposes step_execute to Brain and local planners but not Step itself", async () => {
    const registry = {
      getAll: () => [
        { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
        { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
      ],
    };
    const { session: dsSession } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      modelRegistry: registry,
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
      customTools: [{ name: "web-search", description: "search", parameters: { type: "object", properties: {} } }],
    });
    expect(dsSession.getActiveToolNames()).toContain("step_execute");

    const { session: stepSession } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      modelRegistry: registry,
      model: { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
    });
    expect(stepSession.getActiveToolNames()).not.toContain("step_execute");

    const { session: brainSession } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      modelRegistry: registry,
      model: { id: "brain-router", provider: "brain", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "brain" },
    });
    expect(brainSession.getActiveToolNames()).toContain("step_execute");
  });

  it("lets Brain planners call step_execute while keeping Brain-managed tools filtered", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "brain-router" && fetchMock.mock.calls.length === 1) {
        const toolNames = body.tools.map((tool) => tool.function.name);
        expect(toolNames).toContain("step_execute");
        expect(toolNames).not.toContain("web_search");
        expect(toolNames).not.toContain("stock_market");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_step\",\"function\":{\"name\":\"step_execute\",\"arguments\":\"{\\\"task\\\":\\\"整理今晚世界杯比赛场次\\\",\\\"context\\\":\\\"用户问今晚世界杯有几场比赛\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        expect(body.tools).toBeUndefined();
        expect(JSON.stringify(body.messages)).toContain("整理今晚世界杯比赛场次");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"今晚共有 4 场比赛。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "brain-router") {
        expect(JSON.stringify(body.messages)).toContain("Step 3.7 Flash 执行结果");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"根据 Step 执行结果，今晚世界杯共有 4 场比赛。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "brain-router", provider: "brain", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "brain" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
        ],
      },
      model: { id: "brain-router", provider: "brain", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "brain" },
      customTools: [
        { name: "web_search", description: "brain-owned search", parameters: { type: "object", properties: {} } },
        { name: "stock_market", description: "brain-owned quote", parameters: { type: "object", properties: {} } },
        { name: "present-files", description: "local helper", parameters: { type: "object", properties: {} } },
      ],
    });

    await session.prompt("今晚世界杯有几场比赛");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const visibleText = manager.buildSessionContext().messages.at(-1).content;
    expect(visibleText).toBe("根据 Step 执行结果，今晚世界杯共有 4 场比赛。");
  });

  it("lets DeepSeek delegate a subtask to StepFun via step_execute without exposing tools to Step", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash" && fetchMock.mock.calls.length === 1) {
        expect(body.tools.map((tool) => tool.function.name)).toContain("step_execute");
        expect(JSON.stringify(body.messages)).toContain("step_execute");
        expect(JSON.stringify(body.messages)).toContain("Step 3.7 Flash 高速执行器");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_step\",\"function\":{\"name\":\"step_execute\",\"arguments\":\"{\\\"task\\\":\\\"整理昨晚世界杯比分\\\",\\\"context\\\":\\\"已有搜索结果：墨西哥2-0南非\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        expect(body.tools).toBeUndefined();
        expect(JSON.stringify(body.messages)).toContain("整理昨晚世界杯比分");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"昨晚世界杯比分：墨西哥 2-0 南非。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "deepseek-v4-flash") {
        expect(JSON.stringify(body.messages)).toContain("Step 3.7 Flash 执行结果");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"根据 Step 执行结果，昨晚墨西哥 2-0 南非。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
        ],
      },
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("Step 3.7 Flash 执行结果");
    expect(serialized).toContain("根据 Step 执行结果，昨晚墨西哥 2-0 南非。");
  });

  it("executes a Brain-managed tool call from the original fallback tool set when Brain still emits one", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_weather\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"location\\\":\\\"深圳\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"深圳天气已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `weather:${params.location}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "brain-router",
        provider: "brain",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      customTools: [{
        name: "weather",
        description: "weather",
        parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
        execute,
      }],
    });

    expect(session.getActiveToolNames()).toEqual([]);
    await session.prompt("深圳明天天气");

    expect(execute).toHaveBeenCalledWith("call_weather", { location: "深圳" }, expect.any(Object));
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("weather:深圳");
    expect(serialized).toContain("深圳天气已整理。");
    expect(serialized).not.toContain("Tool not found");
  });

  it("does not leak literal Tool not found text when a requested tool is unavailable", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_rate\",\"function\":{\"name\":\"exchange_rate\",\"arguments\":\"{\\\"pair\\\":\\\"USD/CNY\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
    });

    await session.prompt("美元人民币汇率现在多少？");

    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).not.toContain("Tool not found");
    expect(serialized).toContain("模型这次没有返回可见内容");
  });

  it("resolves underscore tool calls to hyphenated runtime tool aliases", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"世界杯昨晚比赛结果\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"昨晚比赛结果已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      "call_search",
      { query: "世界杯昨晚比赛结果" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("search:世界杯昨晚比赛结果");
    expect(serialized).toContain("昨晚比赛结果已整理。");
    expect(serialized).not.toContain("Tool not found");
  });

  it("executes Qwen-style XML tool calls emitted as local 27B assistant content", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"<tool_call>{\\\"name\\\":\\\"web_search\\\",\\\"arguments\\\":{\\\"query\\\":\\\"深圳今天暴雨预警\\\"}}</tool_call>\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"深圳预警信息已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (fetchMock.mock.calls.length === 1) {
        expect(body.model).toBe("qwen36-27b-dsv4pro-coding-q4-mtp");
        expect(body.tools.map((tool) => tool.function.name)).toContain("web-search");
        expect(body.tool_choice).toBe("auto");
      }
      return responses.shift();
    });
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "qwen36-27b-dsv4pro-coding-q4-mtp",
        provider: "local-qwen35-9b-q4km-imatrix",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:18099/v1",
        apiKey: "local",
        reasoning: true,
        compat: { thinkingFormat: "qwen", text_tool_calls: true },
      },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("查一下深圳今天有没有暴雨预警");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^call_qwen_/),
      { query: "深圳今天暴雨预警" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("search:深圳今天暴雨预警");
    expect(serialized).toContain("深圳预警信息已整理。");
    expect(serialized).not.toContain("<tool_call>");
  });

  it("executes legacy function_call deltas from OpenAI-compatible local providers", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"深圳天气\\\"}\"}}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"天气结果已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "local-openai-compatible",
        provider: "local-qwen35-9b-q4km-imatrix",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:18099/v1",
        apiKey: "local",
      },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("深圳天气");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^call_0_/),
      { query: "深圳天气" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("search:深圳天气");
    expect(serialized).toContain("天气结果已整理。");
  });

  it("normalizes concatenated web_fetch arguments to the final URL object", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fetch\",\"function\":{\"name\":\"web_fetch\",\"arguments\":\"{\\\"query\\\":\\\"世界杯 比分\\\"}{\\\"query\\\":\\\"World Cup scores\\\"}{\\\"url\\\":\\\"https://example.com/match\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"抓取结果已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `fetch:${params.url}:${params.query || ""}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      customTools: [{
        name: "web-fetch",
        description: "fetch",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        execute,
      }],
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(execute).toHaveBeenCalledWith(
      "call_fetch",
      { url: "https://example.com/match" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("fetch:https://example.com/match:");
    expect(serialized).not.toContain("World Cup scores");
  });

  it("reroutes query-only web_fetch calls to web_search when available", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fetch\",\"function\":{\"name\":\"web_fetch\",\"arguments\":\"{\\\"query\\\":\\\"世界杯 比分\\\"}{\\\"query\\\":\\\"世界杯昨晚比分\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"搜索结果已整理。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const fetchExecute = vi.fn(async () => ({ content: [{ type: "text", text: "should-not-run" }] }));
    const searchExecute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      customTools: [
        {
          name: "web-fetch",
          description: "fetch",
          parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          execute: fetchExecute,
        },
        {
          name: "web-search",
          description: "search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute: searchExecute,
        },
      ],
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchExecute).not.toHaveBeenCalled();
    expect(searchExecute).toHaveBeenCalledWith(
      "call_fetch",
      { query: "世界杯昨晚比分" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("search:世界杯昨晚比分");
    expect(serialized).toContain("\"name\":\"web-search\"");
  });

  it("does not persist or render assistant draft text from a tool-call turn", async () => {
    const responses = [
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"草稿不应显示。\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"旧查询\\\"}{\\\"query\\\":\\\"新查询\\\"}{\\\"limit\\\":3}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"最终答案只出现一次。\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}:${params.limit}` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "custom-router",
        provider: "custom-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
        execute,
      }],
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      "call_search",
      { query: "新查询", limit: 3 },
      expect.any(Object),
    );

    const visibleText = events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      .map((event) => event.assistantMessageEvent.text || event.assistantMessageEvent.delta || "")
      .join("");
    expect(visibleText).toBe("最终答案只出现一次。");

    const messages = manager.buildSessionContext().messages;
    const toolCallAssistant = messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(toolCallAssistant).toMatchObject({ role: "assistant", content: "" });
    expect(JSON.stringify(messages)).not.toContain("草稿不应显示");
    expect(JSON.stringify(messages)).toContain("search:新查询:3");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "最终答案只出现一次。",
    });
  });

  it("with explicit cross-provider opt-in: hands empty DeepSeek responses to StepFun instead of ending with an empty fallback", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      if (body.model === "step-3.7-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"Step 已接管并给出答案。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("今晚世界杯有几场比赛");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stepBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stepBody.model).toBe("step-3.7-flash");
    expect(stepBody.tools).toBeUndefined();
    expect(stepBody.messages.at(-1).content).toContain("上一模型没有返回可见正文");
    expect(events.some((event) => event.type === "provider_meta" && event.activeProvider === "step-3.7-flash")).toBe(true);
    const visibleText = events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      .map((event) => event.assistantMessageEvent.text || event.assistantMessageEvent.delta || "")
      .join("");
    expect(visibleText).toBe("Step 已接管并给出答案。");
    expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Step 已接管并给出答案。",
    });
  });

  it("with explicit cross-provider opt-in: hands aborted DeepSeek requests to StepFun instead of ending with aborted", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (body.model === "step-3.7-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"Step 已接管超时请求。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("今晚世界杯有几场比赛");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stepBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stepBody.model).toBe("step-3.7-flash");
    expect(stepBody.tools).toBeUndefined();
    expect(stepBody.messages.at(-1).content).toContain("上一模型请求失败");
    expect(events.some((event) => event.type === "provider_meta" && event.activeProvider === "step-3.7-flash")).toBe(true);
    expect(events.some((event) => event.assistantMessageEvent?.type === "error" && event.assistantMessageEvent.error === "aborted")).toBe(false);
    const visibleText = events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      .map((event) => event.assistantMessageEvent.text || event.assistantMessageEvent.delta || "")
      .join("");
    expect(visibleText).toBe("Step 已接管超时请求。");
    expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Step 已接管超时请求。",
    });
  });

  it("with explicit cross-provider opt-in: hands timed out DeepSeek requests to StepFun instead of ending the turn", async () => {
    const previousModelTimeout = process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
    const previousFallbackTimeout = process.env.LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS;
    process.env.LYNN_MODEL_CALL_TIMEOUT_MS = "10";
    process.env.LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS = "1000";

    try {
      const fetchMock = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.model === "deepseek-v4-flash") {
          await new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            }, { once: true });
          });
        }
        if (body.model === "step-3.7-flash") {
          return sseResponse([
            "data: {\"choices\":[{\"delta\":{\"content\":\"世界杯半决赛在北京时间 7月10日和7月11日。\"}}]}\n\n",
            "data: [DONE]\n\n",
          ]);
        }
        throw new Error(`unexpected model ${body.model}`);
      });
      globalThis.fetch = fetchMock;
      const manager = SessionManager.create(tempDir, tempDir);
      const events = [];

      const { session } = await createLynnAgentSession({
        cwd: tempDir,
        sessionManager: manager,
        modelRegistry: {
          getAll: () => [
            { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
            { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
            { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
          ],
        },
        model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
      });
      session.subscribe((event) => events.push(event));

      await session.prompt("世界杯半决赛在哪一天？");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const stepBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(stepBody.model).toBe("step-3.7-flash");
      expect(stepBody.tools).toBeUndefined();
      expect(stepBody.messages.at(-1).content).toContain("上一模型请求失败");
      expect(events.some((event) => event.type === "provider_meta" && event.activeProvider === "step-3.7-flash")).toBe(true);
      const visibleText = events
        .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
        .map((event) => event.assistantMessageEvent.text || event.assistantMessageEvent.delta || "")
        .join("");
      expect(visibleText).toContain("7月10日");
      expect(visibleText).toContain("7月11日");
      expect(visibleText).not.toContain("aborted");
      expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "世界杯半决赛在北京时间 7月10日和7月11日。",
      });
    } finally {
      if (previousModelTimeout === undefined) delete process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
      else process.env.LYNN_MODEL_CALL_TIMEOUT_MS = previousModelTimeout;
      if (previousFallbackTimeout === undefined) delete process.env.LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS;
      else process.env.LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS = previousFallbackTimeout;
    }
  });

  it("with explicit cross-provider opt-in: does not leak stale World Cup not-started answers when fallback can answer", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"截至2026年6月18日，2026世界杯正赛要到2026年6月20日才开赛，所以目前还没有正赛比分。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"已经出的比分包括：墨西哥 2-0 南非，加拿大 1-1 波黑。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
    });

    await session.prompt("2026世界杯已经出的赛事比分");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stepBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stepBody.model).toBe("step-3.7-flash");
    const finalContent = manager.buildSessionContext().messages.at(-1).content;
    expect(finalContent).toContain("墨西哥 2-0 南非");
    expect(finalContent).toContain("加拿大 1-1 波黑");
    expect(finalContent).not.toContain("还没有正赛比分");
    expect(finalContent).not.toContain("才开赛");
  });

  it("with explicit cross-provider opt-in: summarizes successful tool evidence with StepFun when the planner keeps calling tools", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"世界杯昨晚比分\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"根据工具结果，比分已整理。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "tool:墨西哥2-0南非" }] }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenCalledTimes(2);
    const stepBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(stepBody.model).toBe("step-3.7-flash");
    expect(stepBody.tools).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).tools).toBeUndefined();
    expect(stepBody.messages.at(-1).content).toContain("上一模型已经完成多轮工具调用但没有形成最终回复");
    expect(JSON.stringify(stepBody.messages)).toContain("tool:墨西哥2-0南非");
    expect(stepBody.messages.some((message) => message.role === "tool")).toBe(true);
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("tool:墨西哥2-0南非");
    expect(serialized).toContain("根据工具结果，比分已整理。");
    expect(serialized).not.toContain("工具链已执行多轮但没有形成最终回复");
  });

  it("with explicit cross-provider opt-in: lets StepFun take over tools when the planner returns empty without evidence", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      if (body.model === "step-3.7-flash" && Array.isArray(body.tools)) {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"世界杯昨晚比分\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"Step 根据搜索证据整理了比分。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async (_id, params) => ({
      content: [{ type: "text", text: `search:${params.query}:墨西哥2-0南非` }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("世界杯昨晚比赛结果");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const stepToolBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stepToolBody.model).toBe("step-3.7-flash");
    expect(stepToolBody.tools?.map((tool) => tool.function.name)).toContain("web-search");
    expect(stepToolBody.messages.at(-1).content).toContain("必要时调用一次最相关工具");
    const stepFinalBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(stepFinalBody.tools).toBeUndefined();
    expect(stepFinalBody.messages.at(-1).content).toContain("不要再调用工具");
    expect(JSON.stringify(stepFinalBody.messages)).toContain("search:世界杯昨晚比分:墨西哥2-0南非");
    expect(stepFinalBody.messages.some((message) => message.role === "tool")).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "call_search",
      { query: "世界杯昨晚比分" },
      expect.any(Object),
    );
    const serialized = JSON.stringify(manager.buildSessionContext().messages);
    expect(serialized).toContain("search:世界杯昨晚比分:墨西哥2-0南非");
    expect(serialized).toContain("Step 根据搜索证据整理了比分。");
    expect(serialized).not.toContain("工具链已执行多轮但没有形成最终回复");
  });

  it("does not manufacture an evidence answer when every model stays empty", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"世界杯昨晚比分\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash" || body.model === "glm-5-turbo") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "tool:美国4-1巴拉圭" }] }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "glm" },
        ],
      },
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("世界杯昨晚比赛结果");

    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).not.toContain("tool:美国4-1巴拉圭");
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("tool:美国4-1巴拉圭");
    expect(finalMessage.content).not.toContain("我能从工具证据中确认");
    expect(finalMessage.content).not.toContain("我已经拿到工具结果");
    expect(finalMessage.content).not.toContain("接管总结模型");
    expect(finalMessage.content).not.toContain("error.searchFollowupHint");
    expect(finalMessage.content).toContain("工具链已执行多轮但没有形成最终回复");
    expect(finalMessage.content).toContain("请缩小问题范围后重试");
  });

  it("preserves long sports evidence for models without synthesizing an answer after failure", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"昨晚世界杯最新比赛结果\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash" || body.model === "glm-5-turbo") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const evidence = [
      "搜索提示：这是体育比分/赛果类问题。优先参考专业体育来源。",
      "📋 综合答案：",
      "本届世界杯，首支出局球队诞生(2026-06-20)：北京时间20日凌晨，巴西队3-0战胜海地队，海地两连败提前出局。",
      "早啊！新闻来了(2026-06-20)：北京时间20日凌晨，美国队2比0战胜澳大利亚队，小组赛第二轮拿到关键三分。",
      "世界杯小组赛第二轮开战(2026-06-19)：苏格兰对阵摩洛哥、土耳其对阵巴拉圭等比赛继续进行。",
      "error.searchFollowupHint",
    ].join("\n");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: evidence }] }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "glm" },
        ],
      },
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("昨晚世界杯最新的比赛结果");

    expect(execute).toHaveBeenCalledTimes(3);
    const finalRequest = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.messages.some(message => message.role === "tool" && message.content === evidence)).toBe(true);
    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).not.toContain("我能从工具证据中确认");
    expect(finalMessage.content).not.toContain("巴西队3-0战胜海地队");
    expect(finalMessage.content).not.toContain("美国队2比0战胜澳大利亚队");
    expect(finalMessage.content).not.toContain("error.searchFollowupHint");
    expect(finalMessage.content).toContain("工具链已执行多轮但没有形成最终回复");
    expect(finalMessage.content).toContain("请缩小问题范围后重试");
  });

  it("does not turn scraped page chrome into a final answer when evidence has no facts", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"查一下深圳今天有没有暴雨预警\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash" || body.model === "mimo-v2.5-pro" || body.model === "glm-5-turbo") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const noisyEvidence = [
      "来源: weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijian/index.html (html→text)",
      "您当前的浏览器版本过低，请升级到IE10及以上或采用360，QQ等浏览器，并选择急速模式版。",
      "网站支持IPv6 (https://www.sz.gov.cn/) 繁體 (javascript:szqbl.chscht.run()) English (/en) 手机版 (/mobile)",
      "数据开放 (https://opendata.sz.gov.cn/data/dataSet/toDataSet/dept/9) 无障碍阅读 (javascript:void(0)) 进入关怀版 热门搜...",
    ].join("\n");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: noisyEvidence }] }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "http://127.0.0.1:65537/v1", apiKey: "mimo" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "glm" },
        ],
      },
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("查一下深圳今天有没有暴雨预警");

    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).toContain("没有形成最终回复");
    expect(finalMessage.content).not.toContain("浏览器版本过低");
    expect(finalMessage.content).not.toContain("javascript");
    expect(finalMessage.content).not.toContain("weather.sz.gov.cn");
  });

  it("with explicit cross-provider opt-in: lets the model assess full evidence without heuristic re-querying", async () => {
    let stepToolDelegationSeen = false;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"查一下深圳今天有没有暴雨预警\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash" && JSON.stringify(body.tools || []).includes("web")) {
        stepToolDelegationSeen = true;
        expect(JSON.stringify(body.messages)).toContain("必要时调用一次最相关工具");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_step_search\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"深圳暴雨预警\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash") {
        const serializedMessages = JSON.stringify(body.messages);
        expect(serializedMessages).toContain("暴雨橙色预警");
        expect(serializedMessages).toContain("浏览器版本过低");
        expect(serializedMessages).toContain("javascript:szqbl");
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"深圳今天有暴雨橙色预警，需关注官方预警。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const noisyEvidence = [
      "来源: weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijian/index.html (html→text)",
      "您当前的浏览器版本过低，请升级到IE10及以上或采用360，QQ等浏览器，并选择急速模式版。",
      "网站支持IPv6 (https://www.sz.gov.cn/) 繁體 (javascript:szqbl.chscht.run()) English (/en) 手机版 (/mobile)",
      "数据开放 (https://opendata.sz.gov.cn/data/dataSet/toDataSet/dept/9) 无障碍阅读 (javascript:void(0)) 进入关怀版 热门搜...",
    ].join("\n");
    const usefulEvidence = "深圳市气象台2026年6月20日10:00发布暴雨橙色预警，当前仍生效；预计3小时内有50毫米以上强降雨。";
    let executeCount = 0;
    const execute = vi.fn(async () => {
      executeCount += 1;
      return { content: [{ type: "text", text: executeCount === 1 ? noisyEvidence : usefulEvidence }] };
    });
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "https://cloud-65537.example/v1", apiKey: "mimo" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
      customTools: [{
        name: "web-search",
        description: "search",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute,
      }],
    });

    await session.prompt("查一下深圳今天有没有暴雨预警");

    expect(stepToolDelegationSeen).toBe(false);
    expect(execute).toHaveBeenCalledTimes(3);
    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).toContain("暴雨橙色预警");
    expect(finalMessage.content).not.toContain("浏览器版本过低");
    expect(finalMessage.content).not.toContain("javascript");
  });

  it("lets the original model produce a final answer from complete measured evidence", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash" && !body.tools) {
        expect(JSON.stringify(body.messages)).toContain("1 USD = 6.7844 CNY");
        return sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "1 USD = 6.7844 CNY，来源为工具返回的日度参考值。" } }] })}\n\n`, "data: [DONE]\n\n"]);
      }
      if (body.model === "deepseek-v4-flash") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_rate\",\"function\":{\"name\":\"exchange_rate\",\"arguments\":\"{\\\"pair\\\":\\\"USD/CNY\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      if (body.model === "step-3.7-flash" || body.model === "mimo-v2.5-pro" || body.model === "glm-5-turbo") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "美元兑人民币：1 USD = 6.7844 CNY，数据来源 open.er-api.com，更新时间为 2026 年 6 月 20 日 00:02 UTC。" }],
    }));
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "step" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "http://127.0.0.1:65537/v1", apiKey: "mimo" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "http://127.0.0.1:65532/v1", apiKey: "glm" },
        ],
      },
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "ds" },
      customTools: [{
        name: "exchange-rate",
        description: "rate",
        parameters: { type: "object", properties: { pair: { type: "string" } }, required: ["pair"] },
        execute,
      }],
    });

    await session.prompt("美元人民币汇率现在多少？");

    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).toContain("1 USD = 6.7844 CNY");
    expect(finalMessage.content).not.toContain("我能从工具证据中确认");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).model).toBe("deepseek-v4-flash");
  });

  it("deduplicates repeated final assistant text before persisting the turn", async () => {
    const repeated = "目前美元兑人民币汇率约为 1 USD = 6.7844 CNY，数据来源 open.er-api.com，更新时间为 2026 年 6 月 20 日 00:02 UTC。";
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: repeated + repeated } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });

    await session.prompt("美元人民币汇率现在多少？");

    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content.match(/1 USD = 6\.7844 CNY/g)).toHaveLength(1);
  });

  it("turns content-only reflect scaffolding into one tool-free visible-answer continuation", async () => {
    const hidden = `<reflect>${"internal planning ".repeat(30)}</reflect>`;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (fetchMock.mock.calls.length === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(300) } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: hidden } }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      }
      expect(body.tools || []).toHaveLength(0);
      expect(JSON.stringify(body.messages)).toContain("只返回了内部推理");
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "先保存劳动合同、工资和考勤记录，再固定书面辞退通知与沟通记录；以上仅为一般信息，不构成正式法律意见。" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });

    await session.prompt("劳动合同试用期被突然辞退，我应该先收集什么材料？不要当正式法律意见");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage.content).toContain("书面辞退通知");
    expect(finalMessage.content).not.toContain("<reflect>");
    expect(finalMessage.content).not.toContain("internal planning");
  });

  it.each([
    ["Slow stream completed.", "stop"],
    ["yes", "stop"],
    ["你好，世界", undefined],
    ["42", undefined],
  ])("keeps complete short answer %s without a continuation (%s)", async (answer, finishReason) => {
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(980) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: finishReason }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });

    await session.prompt("把 hello world 翻译成中文");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(manager.buildSessionContext().messages.at(-1)?.content).toBe(answer);
  });

  it("does not append a no-remaining-content marker when a continuation probe finds nothing", async () => {
    const original = "陈默，三十六岁，前结构工程师。左手食指有一道浅疤，斜切入";
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(491) } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: original }, finish_reason: "length" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]);
      }
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "无剩余正文。" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });

    await session.prompt("给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(manager.buildSessionContext().messages.at(-1)?.content).toBe(original);
  });

  it("emits only normalized visible text from a buffered tool-capable model response", async () => {
    const raw = "<reflect>internal planning only</reflect>最终只显示这句。";
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("请给我一个普通回答");

    const visible = events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
      .map((event) => event.assistantMessageEvent.delta)
      .join("");
    expect(visible).toBe("最终只显示这句。");
    expect(manager.buildSessionContext().messages.at(-1)?.content).toBe("最终只显示这句。");
  });

  it("keeps a complete streamed partial answer when the provider disconnects before DONE", async () => {
    const complete = "搬家前先确认日期和预算，再预约搬家公司、按房间打包并单独保管证件；搬家当天复核水电表和箱数，入住后及时修改地址。";
    const fetchMock = vi.fn(async () => failingSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: complete } }] })}\n\n`,
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "primary", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "p" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "http://127.0.0.1:65531/v1", apiKey: "m" },
        ],
      },
      model: { id: "primary", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "p" },
    });

    await session.prompt("下个月搬家，帮我按时间线列一个不容易漏事的待办清单");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant", content: complete });
    expect(finalMessage.content).not.toContain("工具证据");
  });

  it("with explicit cross-provider opt-in: rejects invented tool-evidence claims when the turn ran no tools", async () => {
    const invented = "根据本轮已执行工具返回的证据，当前能确认：已经完成搬家清单并核对全部项目。";
    const replacement = "搬家清单应按确认日期、预约车辆、分类打包、交接读表和修改地址五个阶段安排。";
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const content = body.model === "primary" ? invented : replacement;
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    });
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      modelRegistry: {
        getAll: () => [
          { id: "primary", provider: "test", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "p" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "m" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "primary", provider: "test", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "p" },
    });

    await session.prompt("下个月搬家，帮我按时间线列一个不容易漏事的待办清单");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("mimo-v2.5-pro");
    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage.content).toBe(replacement);
    expect(finalMessage.content).not.toContain("工具证据");
  });

  it("drops stale process lead-in after a corrected final answer boundary", async () => {
    const content = [
      "这类数据目前还没有可靠结果。我帮你查一下。",
      "看起来刚才的判断已经过期了！让我再获取完整信息。",
      "好，我已经获取到可用数据。",
      "",
      "以下是最终汇总：",
      "",
      "| 项目 | 数值 |",
      "| --- | --- |",
      "| A | 1 |",
      "| B | 2 |",
    ].join("\n");
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: { id: "test-model", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:65530/v1", apiKey: "test-key" },
    });

    await session.prompt("请整理结果");

    const finalMessage = manager.buildSessionContext().messages.at(-1);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(finalMessage.content).toContain("以下是最终汇总");
    expect(finalMessage.content).toContain("| A | 1 |");
    expect(finalMessage.content).not.toContain("目前还没有可靠结果");
    expect(finalMessage.content).not.toContain("我帮你查一下");
    expect(finalMessage.content).not.toContain("让我再获取完整信息");
  });

  it("with explicit cross-provider opt-in: skips Spark and uses MiMo before GLM in the fallback tier", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash") return sseResponse(["data: [DONE]\n\n"]);
      if (body.model === "mimo-v2.5-pro") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"MiMo 第二梯队兜底。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "apex-spark-i-balanced", provider: "spark", api: "openai-completions", baseUrl: "http://127.0.0.1:65533/v1", apiKey: "spark" },
          { id: "glm-5", provider: "zhipu-coding", api: "openai-completions", baseUrl: "http://127.0.0.1:65534/v1", apiKey: "glm5" },
          { id: "GLM-5V-Turbo", provider: "zhipu-coding", api: "openai-completions", baseUrl: "http://127.0.0.1:65535/v1", apiKey: "glm5v" },
          { id: "alaya-glm-5", provider: "k2.5", api: "openai-completions", baseUrl: "http://127.0.0.1:65536/v1", apiKey: "alaya" },
          { id: "glm-5-turbo", provider: "zhipu", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "https://cloud-65537.example/v1", apiKey: "mimo" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
    });

    await session.prompt("你好");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("mimo-v2.5-pro");
  });

  it("with explicit cross-provider opt-in: falls back to GLM only after StepFun and MiMo fail to answer", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === "deepseek-v4-flash" || body.model === "step-3.7-flash" || body.model === "mimo-v2.5-pro") {
        return sseResponse(["data: [DONE]\n\n"]);
      }
      if (body.model === "glm-5-turbo") {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"content\":\"GLM 最后兜底。\"}}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      throw new Error(`unexpected model ${body.model}`);
    });
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      modelRegistry: {
        getAll: () => [
          { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
          { id: "step-3.7-flash", provider: "stepfun", api: "openai-completions", baseUrl: "https://cloud-65531.example/v1", apiKey: "step" },
          { id: "glm-5-turbo", provider: "zhipu-coding", api: "openai-completions", baseUrl: "https://cloud-65532.example/v1", apiKey: "glm" },
          { id: "mimo-v2.5-pro", provider: "xiaomi", api: "openai-completions", baseUrl: "https://cloud-65537.example/v1", apiKey: "mimo" },
        ],
      },
      model: { compat: { allowCrossProviderFallback: true }, id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://cloud-65530.example/v1", apiKey: "ds" },
    });

    await session.prompt("你好");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual([
      "deepseek-v4-flash",
      "step-3.7-flash",
      "mimo-v2.5-pro",
      "glm-5-turbo",
    ]);
  });
});
