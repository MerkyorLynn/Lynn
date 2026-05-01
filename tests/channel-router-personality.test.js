import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "../hub/channel-router.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function parseChannel(content) {
  const lines = String(content || "").split("\n");
  const messages = [];
  let current = null;
  const bodyLines = [];

  for (const line of lines) {
    const match = line.match(/^### (.+?) \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)$/);
    if (match) {
      if (current) {
        current.body = bodyLines.join("\n").trim();
        messages.push(current);
        bodyLines.length = 0;
      }
      current = { sender: match[1], timestamp: match[2], body: "" };
      continue;
    }
    if (!current || line.trim() === "---") continue;
    bodyLines.push(line);
  }

  if (current) {
    current.body = bodyLines.join("\n").trim();
    messages.push(current);
  }

  return { meta: {}, messages };
}

function slashPath(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

vi.mock("../lib/channels/channel-store.js", () => ({
  formatMessagesForLLM: (msgs) => msgs.map((m) => `${m.sender}: ${m.text ?? m.body ?? ""}`).join("\n"),
  appendMessage: vi.fn(),
  getChannelMeta: vi.fn((filePath) => {
    if (slashPath(filePath).endsWith("/broken.md")) return {};
    return { id: "general", members: ["alpha", "beta", "hanako"] };
  }),
  parseChannel,
}));

vi.mock("../lib/memory/config-loader.js", () => ({
  loadConfig: vi.fn(() => {
    throw new Error("loadConfig should NOT be called when agent instance exists");
  }),
}));

let callTextSpy;
vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(async () => "NO"),
}));

describe("ChannelRouter._executeCheck personality 来源", () => {
  it("当 engine.agents 有该 agent 实例时，使用内存中的 personality 而不读磁盘", async () => {
    const { callText } = await import("../core/llm-client.js");
    callTextSpy = callText;
    callTextSpy.mockResolvedValue("NO");

    const mockAgent = {
      config: { agent: { name: "Lynn", yuan: "hanako" } },
      personality: "我是 Lynn，一个温柔的助手。这是内存中的 personality。",
    };

    const mockAgentsMap = new Map([["lynn", mockAgent]]);
    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (slashPath(filePath).endsWith("/general.md")) return true;
      return realExistsSync(filePath);
    });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      if (slashPath(filePath).endsWith("/general.md")) {
        return "### user | 2026-04-01 10:00\n\n你好\n";
      }
      return realReadFileSync(filePath, ...args);
    });

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          userDir: "/fake/user",
          agents: mockAgentsMap,
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "lynn",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    readSpy.mockRestore();
    existsSpy.mockRestore();
    expect(result.replied).toBe(false);
    expect(callTextSpy).toHaveBeenCalledTimes(1);
    const callArgs = callTextSpy.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("我是 Lynn，一个温柔的助手。这是内存中的 personality。");
  });

  it("当 engine.agents 为 undefined 时 fallback 到磁盘读取", async () => {
    const { callText } = await import("../core/llm-client.js");
    callText.mockResolvedValue("NO");

    const { loadConfig } = await import("../lib/memory/config-loader.js");
    loadConfig.mockReturnValueOnce({ agent: { name: "TestAgent", yuan: "hanako" } });

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: undefined,
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    expect(result.replied).toBe(false);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("立即 triage 时不会因为前一个 agent 已回复而阻断后续 agent", async () => {
    const { callText } = await import("../core/llm-client.js");
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    callText.mockResolvedValue("YES");
    appendMessage.mockClear();

    const agentA = {
      config: { agent: { name: "Alpha", yuan: "hanako" } },
      personality: "Alpha personality",
    };
    const agentB = {
      config: { agent: { name: "Beta", yuan: "hanako" } },
      personality: "Beta personality",
    };
    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (slashPath(filePath).endsWith("/general.md")) return true;
      return realExistsSync(filePath);
    });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      if (slashPath(filePath).endsWith("/general.md")) {
        return [
          "### user | 2026-04-01 10:00:00",
          "",
          "大家怎么看？",
          "",
          "---",
          "",
          "### Alpha | 2026-04-01 10:00:05",
          "",
          "我先说一句。",
          "",
          "---",
          "",
        ].join("\n");
      }
      return realReadFileSync(filePath, ...args);
    });

    const router = new ChannelRouter({
      hub: {
        engine: {
          currentAgentId: "host",
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: new Map([
            ["alpha", agentA],
            ["beta", agentB],
          ]),
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    router._executeReply = vi.fn().mockResolvedValue("Beta 来补充一下。");

    const result = await router._executeCheck(
      "beta",
      "general",
      [
        { sender: "user", text: "大家怎么看？" },
        { sender: "Alpha", text: "我先说一句。" },
      ],
      [],
      { triggerMessage: { sender: "user", timestamp: "2026-04-01 10:00:00" } },
    );

    readSpy.mockRestore();
    existsSpy.mockRestore();
    expect(callText).toHaveBeenCalled();
    expect(router._executeReply).toHaveBeenCalledOnce();
    expect(appendMessage).toHaveBeenCalledWith(expect.stringMatching(/[\\/]fake[\\/]channels[\\/]general\.md$/), "Beta", "Beta 来补充一下。");
    expect(result).toEqual({ replied: true, replyContent: "Beta 来补充一下。" });
  });

  it("用户发在线/在吗这类唤醒消息时，即使 triage 返回 NO 也会强制让成员回应", async () => {
    const { callText } = await import("../core/llm-client.js");
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    callText.mockResolvedValue("NO");
    callText.mockClear();
    appendMessage.mockClear();

    const agentA = {
      config: { agent: { name: "Alpha", yuan: "hanako" } },
      personality: "Alpha personality",
    };

    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (slashPath(filePath).endsWith("/general.md")) return true;
      return realExistsSync(filePath);
    });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      if (slashPath(filePath).endsWith("/general.md")) {
        return [
          "### user | 2026-04-01 10:00:00",
          "",
          "大家都在吗？",
          "",
          "---",
          "",
        ].join("\n");
      }
      return realReadFileSync(filePath, ...args);
    });

    const router = new ChannelRouter({
      hub: {
        engine: {
          currentAgentId: "host",
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: new Map([["alpha", agentA]]),
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    router._executeReply = vi.fn().mockResolvedValue("我在，可以聊。");

    const result = await router._executeCheck(
      "alpha",
      "general",
      [{ sender: "user", text: "大家都在吗？" }],
      [],
      { triggerMessage: { sender: "user", timestamp: "2026-04-01 10:00:00", body: "大家都在吗？" } },
    );

    readSpy.mockRestore();
    existsSpy.mockRestore();
    expect(callText).not.toHaveBeenCalled();
    expect(router._executeReply).toHaveBeenCalledOnce();
    expect(appendMessage).toHaveBeenCalledWith(expect.stringMatching(/[\\/]fake[\\/]channels[\\/]general\.md$/), "Alpha", "我在，可以聊。");
    expect(result).toEqual({ replied: true, replyContent: "我在，可以聊。" });
  });

  it("主回复链路失败时，会回退到轻量直连回复继续发言", async () => {
    const { callText } = await import("../core/llm-client.js");
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    callText.mockResolvedValueOnce("我来补一句。");
    appendMessage.mockClear();

    const mockAgent = {
      config: {
        agent: { name: "Hanako", yuan: "hanako" },
        api: { provider: "minimax" },
        models: { chat: "MiniMax-M2.7-highspeed" },
      },
      personality: "Hanako personality",
    };

    const router = new ChannelRouter({
      hub: {
        engine: {
          currentAgentId: "lynn",
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          currentModel: null,
          agents: new Map([["hanako", mockAgent]]),
          providerRegistry: { get: vi.fn(() => ({ authType: "api-key" })) },
          resolveProviderCredentials: vi.fn(() => ({
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
          })),
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
          _models: {
            resolveModelWithCredentials: vi.fn(() => {
              throw new Error("no cached model registry");
            }),
          },
        },
        eventBus: { emit: vi.fn() },
      },
    });

    router._executeReply = vi.fn().mockRejectedValue(new Error("error.agentExecNotInit"));
    const realExistsSync = fs.existsSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (slashPath(filePath).endsWith("/general.md")) return true;
      return realExistsSync(filePath);
    });

    const result = await router._executeCheck(
      "hanako",
      "general",
      [{ sender: "user", text: "@Hanako 你在吗？" }],
      [],
    );

    existsSpy.mockRestore();
    expect(router._executeReply).toHaveBeenCalledOnce();
    expect(appendMessage).toHaveBeenCalledWith(expect.stringMatching(/[\\/]fake[\\/]channels[\\/]general\.md$/), "Hanako", "我来补一句。");
    expect(result).toEqual({ replied: true, replyContent: "我来补一句。" });
  });

  it("不会向缺少成员 frontmatter 的坏频道文件继续写回复", async () => {
    const { appendMessage } = await import("../lib/channels/channel-store.js");
    appendMessage.mockClear();

    const mockAgent = {
      config: {
        agent: { name: "Hanako", yuan: "hanako" },
        api: { provider: "minimax" },
        models: { chat: "MiniMax-M2.7-highspeed" },
      },
      personality: "Hanako personality",
    };

    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (slashPath(filePath).endsWith("/broken.md")) return true;
      return realExistsSync(filePath);
    });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      if (slashPath(filePath).endsWith("/broken.md")) {
        return [
          "### user | 2026-04-01 10:00:00",
          "",
          "有人吗？",
          "",
          "---",
          "",
        ].join("\n");
      }
      return realReadFileSync(filePath, ...args);
    });

    const router = new ChannelRouter({
      hub: {
        engine: {
          currentAgentId: "lynn",
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: new Map([["hanako", mockAgent]]),
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "broken",
      [{ sender: "user", text: "@Hanako 在吗？" }],
      [],
    );

    existsSpy.mockRestore();
    readSpy.mockRestore();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ replied: false });
  });
});
