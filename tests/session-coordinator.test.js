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
});
