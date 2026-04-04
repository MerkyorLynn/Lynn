import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
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
      "【系统通知】当前处于「安全模式」，所有危险操作（sudo、chmod 等）和受限路径的写入将被直接拒绝，无确认机会。如果用户需要执行这些操作，请告知需要在输入框左下角切换到「执行模式」。",
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
      workspace: '/tmp/home',
    }));
    expect(session._buildRuntime).toHaveBeenCalledWith({ activeToolNames: ['read', 'grep', 'find', 'ls', 'todo'] });
    expect(coordinator.getSecurityMode()).toBe('plan');
    expect(coordinator.getPlanMode()).toBe(true);
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
