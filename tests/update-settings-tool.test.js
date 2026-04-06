/**
 * update-settings-tool.js 注册表单元测试
 *
 * 覆盖：apply 签名、toggle boolean 转换、agent null guard
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadLocale } from "../server/i18n.js";

// ── Mock 工厂 ──

function makeMockPrefs(initial = {}) {
  const store = { ...initial };
  return {
    getPreferences: () => ({ ...store }),
    getLocale: () => store.locale || "",
    setLocale(v) { store.locale = v; },
    getTimezone: () => store.timezone || "",
    setTimezone(v) { store.timezone = v; },
    getThinkingLevel: () => store.thinking_level || "auto",
    setThinkingLevel(v) { store.thinking_level = v; },
    _store: store,
  };
}

function makeMockEngine(overrides = {}) {
  const prefs = makeMockPrefs(overrides.prefsData || {});
  return {
    preferences: prefs,
    _prefs: prefs,
    agent: overrides.agent !== undefined ? overrides.agent : {
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      updateConfig: vi.fn(),
    },
    availableModels: overrides.availableModels || [],
    getHomeFolder: () => overrides.homeFolder || "/home/test",
    setHomeFolder: vi.fn(),
    setLocale: vi.fn(function (v) { prefs.setLocale(v); }),
    setTimezone: vi.fn(function (v) { prefs.setTimezone(v); }),
    setThinkingLevel: vi.fn(function (v) { prefs.setThinkingLevel(v); }),
    setSecurityMode: vi.fn(),
    securityMode: overrides.securityMode || "authorized",
    currentSessionPath: "/sessions/test",
    emitSessionEvent: vi.fn(),
  };
}

function makeMockConfirmStore(action = "confirmed", value = undefined) {
  return {
    create: vi.fn(() => ({
      confirmId: "test-confirm-id",
      promise: Promise.resolve({ action, value }),
    })),
  };
}

describe("update-settings-tool", () => {
  let createUpdateSettingsTool;

  beforeEach(async () => {
    loadLocale("en");
    const mod = await import("../lib/tools/update-settings-tool.js");
    createUpdateSettingsTool = mod.createUpdateSettingsTool;
  }, 20000);

  function buildTool(engineOpts = {}, confirmAction = "confirmed") {
    const engine = makeMockEngine(engineOpts);
    const confirmStore = makeMockConfirmStore(confirmAction);
    const tool = createUpdateSettingsTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      getSessionPath: () => "/sessions/test",
      emitEvent: vi.fn(),
    });
    return { tool, engine, confirmStore };
  }

  describe("locale — 非 toggle 类型不受 parse 影响", () => {
    it("apply locale=en 传入字符串", async () => {
      const { tool, engine } = buildTool({ prefsData: { locale: "zh-CN" } });
      await tool.execute("c3", { action: "apply", key: "locale", value: "en" });

      expect(engine.setLocale).toHaveBeenCalledWith("en");
    });
  });

  describe("security mode labels", () => {
    it("search security mode 时向用户展示 Execute 文案，但内部值仍是 authorized", async () => {
      const { tool } = buildTool({ securityMode: 'authorized' });
      const result = await tool.execute('c-sec', { action: 'search', query: 'security mode' });
      const text = result.content[0].text;
      expect(text).toContain('Execute');
      expect(text).toContain('authorized (Execute)');
    });
  });

  describe("agent-scoped null guard", () => {
    it("get memory.enabled 在 agent=null 时不返回 true", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c4", { action: "search", query: "memory" });
      const text = result.content[0].text;
      expect(text).not.toContain("→ true");
      expect(text).toContain("N/A");
    });

    it("apply memory.enabled 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c5", { action: "apply", key: "memory.enabled", value: "true" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("get agent.name 在 agent=null 时返回 N/A", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c6", { action: "search", query: "agent.name" });
      const text = result.content[0].text;
      expect(text).toContain("N/A");
    });
  });

  describe("confirmation rejected/aborted", () => {
    it("rejected 返回取消消息", async () => {
      const { tool } = buildTool({}, "rejected");
      const result = await tool.execute("c7", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("aborted（session 关闭）不返回成功消息", async () => {
      const { tool } = buildTool({}, "aborted");
      const result = await tool.execute("c8", { action: "apply", key: "locale", value: "en" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });
  });
});
