import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../core/agent-runtime/create-session.js", () => ({
  createLynnAgentSession: createAgentSessionMock,
}));

vi.mock("../core/agent-runtime/session-manager.js", () => ({
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
}));

vi.mock("../core/agent-runtime/settings-manager.js", () => ({
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";
import { resolveCompactionSettings } from "../core/compaction-settings.js";

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    sessionManagerOpenMock.mockReturnValue({
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => "/tmp/session.jsonl",
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
        subscribe: vi.fn(() => vi.fn()),
        _buildRuntime: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
        steer: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("applies session memory before creating the agent session", async () => {
    let sessionMemoryEnabled = true;
    const agent = {
      agentDir: "/tmp/agent",
      sessionDir: "/tmp/agent-sessions",
      tools: [],
      config: {},
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
    };

    const resourceLoader = {
      getSystemPrompt: () => (sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF"),
      getAppendSystemPrompt: () => [],
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("uses Execute wording in security notices", async () => {
    const agent = {
      agentDir: "/tmp/agent",
      sessionDir: "/tmp/agent-sessions",
      tools: [],
      config: { locale: "en" },
      setMemoryEnabled: vi.fn(),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coordinator.setSecurityMode('plan');
    await coordinator.createSession(null, "/tmp/workspace", true);
    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    expect(resourceLoader.getAppendSystemPrompt()).toContain(
      "[System Notice] Currently in PLAN MODE. You can only use read-only tools (read, grep, find, ls) and custom tools. You cannot write, edit, or delete. If the user asks for these operations, inform them to switch to 'Execute Mode' via the selector at the bottom-left of the input area.",
    );

    agent.config.locale = "zh-CN";
    coordinator.setSecurityMode('safe');
    expect(resourceLoader.getAppendSystemPrompt()).toContain(
      "【系统通知】当前处于「安全模式」，所有危险操作（sudo、chmod 等）和受保护路径的写入都会被直接拒绝，不会弹出确认。如果用户确实需要执行这些操作，请告知先在输入框左下角切换到「执行模式」。",
    );
  });

  it("injects MCP resource context into append system prompt", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => ["base"] }),
      getMcpPromptContext: () => "[MCP Resources]\n- filesystem: repo-root, docs",
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    expect(resourceLoader.getAppendSystemPrompt()).toContain("[MCP Resources]\n- filesystem: repo-root, docs");
  });

  it("refreshes stale Brain request signatures before the next prompt", async () => {
    const previousLynnHome = process.env.LYNN_HOME;
    const firstTime = Date.parse("2026-06-14T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(firstTime);
    try {
      process.env.LYNN_HOME = tempDir;
      const prefsDir = path.join(tempDir, "user");
      fs.mkdirSync(prefsDir, { recursive: true });
      fs.writeFileSync(path.join(prefsDir, "preferences.json"), JSON.stringify({
        client_agent_key: "ak_test_refresh",
        client_agent_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }), "utf8");

      const prompts = [];
      createAgentSessionMock.mockImplementation(async ({ requestHeaders }) => ({
        session: {
          requestHeaders,
          sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
          subscribe: vi.fn(() => vi.fn()),
          _buildRuntime: vi.fn(),
          prompt: vi.fn().mockImplementation(async (...args) => {
            prompts.push({ requestHeaders, args });
          }),
          steer: vi.fn(),
          isStreaming: false,
        },
      }));

      const agent = {
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        recallForMessage: vi.fn().mockResolvedValue(""),
        setMemoryEnabled: vi.fn(),
        _memoryTicker: { notifyTurn: vi.fn() },
      };
      const model = {
        id: "lynn-brain-router",
        provider: "brain",
        name: "默认模型",
        baseUrl: "https://api.merkyorlynn.com/api/v2/v1",
      };
      const coordinator = new SessionCoordinator({
        agentsDir: "/tmp/agents",
        getAgent: () => agent,
        getActiveAgentId: () => "hana",
        getModels: () => ({
          currentModel: model,
          availableModels: [model],
          authStorage: {},
          modelRegistry: {},
          resolveThinkingLevel: () => "medium",
        }),
        getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
        getSkills: () => null,
        buildTools: () => ({ tools: [], customTools: [] }),
        emitEvent: () => {},
        emitDevLog: () => {},
        getHomeCwd: () => "/tmp/home",
        agentIdFromSessionPath: () => null,
        switchAgentOnly: async () => {},
        getConfig: () => ({}),
        getPrefs: () => ({ getThinkingLevel: () => "medium" }),
        getAgents: () => new Map(),
        getActivityStore: () => null,
        getAgentById: () => null,
        listAgents: () => [],
      });

      await coordinator.createSession(null, "/tmp/workspace", true, model);
      const initialHeaders = { ...createAgentSessionMock.mock.calls[0][0].requestHeaders };
      expect(initialHeaders["X-Lynn-Timestamp"]).toBe(String(firstTime));

      const refreshedTime = firstTime + (5 * 60 * 60 * 1000) + 1;
      vi.setSystemTime(refreshedTime);
      await coordinator.prompt("你好");

      expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
      expect(sessionManagerOpenMock).not.toHaveBeenCalled();
      expect(coordinator.currentSessionPath).toBe("/tmp/session.jsonl");
      const refreshedHeaders = createAgentSessionMock.mock.calls[0][0].requestHeaders;
      expect(refreshedHeaders["X-Lynn-Timestamp"]).toBe(String(refreshedTime));
      expect(refreshedHeaders["X-Lynn-Timestamp"]).not.toBe(initialHeaders["X-Lynn-Timestamp"]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0].requestHeaders).toBe(refreshedHeaders);
      expect(prompts[0].args[0]).toBe("你好");
    } finally {
      if (previousLynnHome === undefined) delete process.env.LYNN_HOME;
      else process.env.LYNN_HOME = previousLynnHome;
    }
  });

  it("rebuilds runtime tools when switching security mode to plan", async () => {
    const buildTools = vi.fn(() => ({
      tools: [{ name: 'read' }, { name: 'edit' }, { name: 'bash' }],
      customTools: [{ name: 'todo' }],
    }));
    const session = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools,
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    session._buildRuntime.mockClear();

    coordinator.setSecurityMode('plan');

    expect(buildTools).toHaveBeenLastCalledWith('/tmp/workspace', null, expect.objectContaining({
      mode: 'standard',
      workspace: '/tmp/workspace',
      agentDir: '/tmp/agent',
      getSessionPath: expect.any(Function),
    }));
    expect(session._buildRuntime).toHaveBeenCalledWith({ activeToolNames: ['read', 'grep', 'find', 'ls', 'todo'] });
    expect(coordinator.getSecurityMode()).toBe('plan');
    expect(coordinator.getPlanMode()).toBe(true);
  });

  it("temporarily disables runtime tools for a no-tool prompt and restores them", async () => {
    const buildTools = vi.fn(() => ({
      tools: [{ name: 'read' }, { name: 'edit' }, { name: 'bash' }],
      customTools: [{ name: 'todo' }],
    }));
    const session = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        recallForMessage: vi.fn(async () => ""),
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools,
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    session.prompt.mockImplementationOnce(async () => {
      expect(resourceLoader.getAppendSystemPrompt()).toContain("NO_TOOL_TURN");
    });
    session._buildRuntime.mockClear();

    await coordinator.promptSession("/tmp/session.jsonl", "只回复：已记住", {
      disableTools: true,
      turnInstruction: "NO_TOOL_TURN",
    });

    expect(session.prompt).toHaveBeenCalledWith("只回复：已记住", undefined);
    expect(session._buildRuntime).toHaveBeenNthCalledWith(1, { activeToolNames: [] });
    expect(session._buildRuntime).toHaveBeenLastCalledWith({ activeToolNames: ['read', 'edit', 'bash', 'todo'] });
    expect(resourceLoader.getAppendSystemPrompt()).not.toContain("NO_TOOL_TURN");
  });

  it("switches the active session model immediately", async () => {
    const oldModel = { id: "old-model", provider: "brain", name: "Old Model" };
    const nextModel = { id: "next-model", provider: "brain", name: "Next Model" };
    const session = {
      model: oldModel,
      setModel: vi.fn(async (model) => {
        session.model = model;
        return true;
      }),
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: oldModel,
        availableModels: [oldModel, nextModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    const result = await coordinator.switchCurrentSessionModel(nextModel);

    expect(result).toEqual({ appliedToSession: true, pendingOnly: false });
    expect(session.setModel).toHaveBeenCalledWith(nextModel);
    expect(coordinator.getCurrentSessionModelRef()).toEqual({ id: "next-model", provider: "brain" });
    expect(coordinator.pendingModel).toEqual(nextModel);
  });

  it("records learned skill activation telemetry when a skill is activated", async () => {
    let subscriptionHandler = null;
    const recordSkillActivation = vi.fn();
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        model: { id: "brain-default", provider: "brain", name: "Default Model" },
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
        subscribe: vi.fn((handler) => {
          subscriptionHandler = handler;
          return vi.fn();
        }),
        _buildRuntime: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "brain-default", provider: "brain", name: "Default Model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => ({ _skillDistiller: { recordSkillActivation } }),
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    subscriptionHandler?.({
      type: "skill_activated",
      skillName: "release-wrap-up",
      skillFilePath: "/tmp/agent/learned-skills/release-wrap-up/SKILL.md",
    });

    expect(recordSkillActivation).toHaveBeenCalledWith({
      skillName: "release-wrap-up",
      skillFilePath: "/tmp/agent/learned-skills/release-wrap-up/SKILL.md",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("sizes compaction windows adaptively for different context windows", () => {
    expect(resolveCompactionSettings({ contextWindow: 32_768 })).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 8_192,
    });

    expect(resolveCompactionSettings({ contextWindow: 128_000 })).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 25_600,
    });

    expect(resolveCompactionSettings({ contextWindow: 1_000_000 })).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 65_536,
    });

    expect(resolveCompactionSettings({ provider: "openai", id: "gpt-4o" })).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 25_600,
    });

    expect(resolveCompactionSettings({ id: "unknown-model" })).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
  });

  it("guides brain sessions to present themselves as the default model service", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: { locale: "zh-CN" },
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "lynn",
      getModels: () => ({
        currentModel: { id: "step-3.5-flash-2603", provider: "brain", name: "默认模型" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    const prompt = resourceLoader.getAppendSystemPrompt().join("\n");
    expect(prompt).toContain("当前用户选择的是默认模型");
    expect(prompt).toContain("不要主动说出具体上游模型名、供应商名或 provider ID");
    expect(prompt).toContain("即使用户直接追问你当前是什么模型，也不要把具体上游型号当成最终答案");
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
          prompt: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: "default-model" } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model" },
        availableModels: [{ id: "default-model" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("delegate task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("relays to a new session after repeated compactions", async () => {
    let firstHandler = null;
    const firstSession = {
      model: { id: "step-3.5-flash-2603", provider: "brain", name: "Default Model" },
      sessionManager: { getSessionFile: () => "/tmp/session-a.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn((handler) => {
        firstHandler = handler;
        return vi.fn();
      }),
      _buildRuntime: vi.fn(),
    };
    const secondSession = {
      model: { id: "step-3.5-flash-2603", provider: "brain", name: "Default Model" },
      sessionManager: { getSessionFile: () => "/tmp/session-b.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession })
      .mockResolvedValueOnce({ session: secondSession });

    const emitEvent = vi.fn();
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "step-3.5-flash-2603", provider: "brain", name: "Default Model" },
        availableModels: [{ id: "step-3.5-flash-2603", provider: "brain", name: "Default Model" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      emitDevLog: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => "medium",
        getSessionRelay: () => ({ enabled: true, compaction_threshold: 3, summary_max_tokens: 400 }),
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      summarizeSessionRelay: vi.fn().mockResolvedValue("用户要继续推进 MCP 和长任务优化；已完成 Brain 连接池与 reviewer 修复；待继续执行 dry-run 与恢复体验。"),
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    firstHandler?.({ type: "auto_compaction_end" });
    firstHandler?.({ type: "auto_compaction_end" });
    firstHandler?.({ type: "auto_compaction_end" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(coordinator.currentSessionPath).toBe("/tmp/session-b.jsonl");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_relay",
      oldSessionPath: "/tmp/session-a.jsonl",
      newSessionPath: "/tmp/session-b.jsonl",
    }), "/tmp/session-b.jsonl");

    const relayLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    expect(relayLoader.getAppendSystemPrompt().join("\n")).toContain("自动接力摘要");
  });

  it("creates a shadow workspace for executeIsolated dry-run validation", async () => {
    const sourceDir = fs.mkdtempSync(path.join(tempDir, "workspace-"));
    fs.writeFileSync(path.join(sourceDir, "hello.txt"), "hello", "utf-8");
    fs.mkdirSync(path.join(sourceDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "node_modules", "skip.txt"), "skip", "utf-8");

    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => path.join(tempDir, "dryrun.jsonl") },
        subscribe: vi.fn(() => vi.fn()),
        abort: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: "default-model" } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model" },
        availableModels: [{ id: "default-model" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("delegate task", {
      cwd: sourceDir,
      dryRun: true,
      validateCommand: [
        process.execPath,
        "-e",
        "const fs=require('fs');process.exit(fs.existsSync('hello.txt')&&!fs.existsSync('node_modules')?0:1);",
      ],
    });

    expect(result.error).toBeNull();
    expect(result.dryRun.workspacePath).not.toBe(sourceDir);
    expect(fs.existsSync(path.join(result.dryRun.workspacePath, "hello.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.dryRun.workspacePath, "node_modules"))).toBe(false);
    expect(result.dryRun.validation.exitCode).toBe(0);
  });

  it("returns executeIsolated model text without pseudo-tool sanitizing or retrying a prompt", async () => {
    let handler = null;
    const promptMock = vi.fn(async (attemptPrompt) => {
      if (promptMock.mock.calls.length === 1) {
        handler?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: '我来搜索一下。<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>',
          },
        });
        return;
      }

      handler?.({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "今天金价偏强，建议同时看上金所和品牌金店报价。",
        },
      });
    });

    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => path.join(tempDir, "retry.jsonl"), getCwd: () => "/tmp/workspace" },
        subscribe: vi.fn((fn) => {
          handler = fn;
          return vi.fn();
        }),
        abort: vi.fn(),
        prompt: promptMock,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: "default-model" } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model" },
        availableModels: [{ id: "default-model" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      emitDevLog: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("今天金价如何");

    expect(result.error).toBeNull();
    expect(result.replyText).toBe('我来搜索一下。<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>');
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("emits warn-level content filter events without blocking prompts", async () => {
    const emitEvent = vi.fn();
    const emitDevLog = vi.fn();
    const session = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
      isStreaming: false,
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        recallForMessage: vi.fn().mockResolvedValue(""),
        _memoryTicker: { notifyTurn: vi.fn() },
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      emitDevLog,
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coordinator._contentFilter = {
      check: vi.fn().mockReturnValue({
        blocked: false,
        level: "warn",
        matches: [{ category: "10-gambling", level: "warn" }],
      }),
    };

    await coordinator.createSession(null, "/tmp/workspace", true);
    await coordinator.prompt("这是一条需要 warn 的测试消息");

    expect(session.prompt).toHaveBeenCalledWith("这是一条需要 warn 的测试消息", undefined);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "content_filtered",
      blocked: false,
      level: "warn",
    }), "/tmp/session.jsonl");
    expect(emitDevLog).toHaveBeenCalledWith("内容过滤 warn: 10-gambling", "warn");
  });

  it("downgrades BYOK content filter blocks to warnings", async () => {
    const emitEvent = vi.fn();
    const emitDevLog = vi.fn();
    const session = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
      isStreaming: false,
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        recallForMessage: vi.fn().mockResolvedValue(""),
        _memoryTicker: { notifyTurn: vi.fn() },
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "DeepSeek V4 Pro", provider: "deepseek" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      emitDevLog,
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coordinator._contentFilter = {
      check: vi.fn().mockReturnValue({
        blocked: true,
        level: "block",
        matches: [{ category: "02-national-security", level: "block" }],
      }),
    };

    await coordinator.createSession(null, "/tmp/workspace", true);
    await coordinator.prompt("升级最新版后依然无法正常使用，模型配置界面不对。");

    expect(session.prompt).toHaveBeenCalledWith("升级最新版后依然无法正常使用，模型配置界面不对。", undefined);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "content_filtered",
      blocked: false,
      level: "warn",
      originalLevel: "block",
      downgraded: true,
      provider: "deepseek",
      categories: ["02-national-security"],
    }), "/tmp/session.jsonl");
    expect(emitDevLog).toHaveBeenCalledWith("内容过滤 block->warn: 02-national-security", "warn");
  });

  it("keeps Brain-managed content filter blocks hard and shows categories", async () => {
    const emitEvent = vi.fn();
    const emitDevLog = vi.fn();
    const session = {
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp/workspace" },
      subscribe: vi.fn(() => vi.fn()),
      _buildRuntime: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn(),
      isStreaming: false,
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        recallForMessage: vi.fn().mockResolvedValue(""),
        _memoryTicker: { notifyTurn: vi.fn() },
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "StepFun 3.7 Flash", provider: "brain" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      emitDevLog,
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coordinator._contentFilter = {
      check: vi.fn().mockReturnValue({
        blocked: true,
        level: "block",
        matches: [{ category: "02-national-security", level: "block" }],
      }),
    };

    await coordinator.createSession(null, "/tmp/workspace", true);
    await expect(coordinator.prompt("blocked input")).rejects.toThrow(/02-national-security/);

    expect(session.prompt).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "content_filtered",
      blocked: true,
      level: "block",
      originalLevel: "block",
      downgraded: false,
      provider: "brain",
      categories: ["02-national-security"],
    }), "/tmp/session.jsonl");
    coordinator._contentFilter.check.mockImplementation(text => text.includes('blocked input')
      ? { blocked: true, level: 'block', matches: [{ category: '02-national-security', level: 'block' }] }
      : { blocked: false, level: 'pass', matches: [] });
    const originalUserText = '访问 example.com 并概括内容';
    const augmented = `${originalUserText}\n检索资料：blocked input`;
    await coordinator.prompt(augmented, { originalUserText });
    expect(coordinator._contentFilter.check).toHaveBeenLastCalledWith(originalUserText);
    expect(session.prompt).toHaveBeenLastCalledWith(augmented, undefined);
    await coordinator.promptSession('/tmp/session.jsonl', augmented, { originalUserText });
    expect(coordinator._contentFilter.check).toHaveBeenLastCalledWith(originalUserText);
    await expect(coordinator.prompt(augmented, { originalUserText: '' })).rejects.toThrow(/02-national-security/);
    await expect(coordinator.prompt(augmented, { originalUserText: 123 })).rejects.toThrow(/02-national-security/);
    await expect(coordinator.promptSession('/tmp/session.jsonl', 'model context', { originalUserText: 'blocked input' })).rejects.toThrow(/02-national-security/);
  });

  it("applies content filtering to steer messages too", () => {
    const emitEvent = vi.fn();
    const emitDevLog = vi.fn();
    const steer = vi.fn();
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: "/tmp/agent",
        sessionDir: "/tmp/agent-sessions",
        tools: [],
        config: {},
        setMemoryEnabled: vi.fn(),
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      emitDevLog,
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coordinator._contentFilter = {
      check: vi.fn().mockReturnValue({
        blocked: true,
        level: "block",
        matches: [{ category: "03-extremism-terrorism", level: "block" }],
      }),
    };
    coordinator._session = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
      steer,
    };
    coordinator._sessions.set("/tmp/session.jsonl", { lastTouchedAt: 0 });

    const ok = coordinator.steer("绕过测试");

    expect(ok).toBe(false);
    expect(steer).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "content_filtered",
      blocked: true,
      level: "block",
    }), "/tmp/session.jsonl");
  });
});
