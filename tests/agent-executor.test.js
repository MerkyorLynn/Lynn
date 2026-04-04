import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, settingsManagerInMemoryMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  settingsManagerInMemoryMock: vi.fn(() => ({})),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: settingsManagerInMemoryMock,
  },
}));

const { runAgentSession } = await import("../hub/agent-executor.js");

describe("runAgentSession", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-agent-exec-"));
    sessionManagerCreateMock.mockImplementation(() => ({
      getSessionFile: () => path.join(tmpDir, "session.jsonl"),
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts a hung prompt when the caller signal aborts", async () => {
    const abort = vi.fn(async () => {});
    const prompt = vi.fn(() => new Promise(() => {}));
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort,
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    const controller = new AbortController();
    const promise = runAgentSession(
      "lynn",
      [{ text: "hello", capture: true }],
      {
        signal: controller.signal,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "lynn"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("uses modelOverride when provided", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    const overrideModel = { id: "step-3.5-flash-2603", provider: "brain", name: "Step 3.5 Flash 2603" };

    await runAgentSession(
      "lynn",
      [{ text: "hello", capture: true }],
      {
        engine: {
          homeCwd: tmpDir,
          currentModel: { id: "glm-5.1", provider: "glm", name: "GLM-5.1" },
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "lynn"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
        modelOverride: overrideModel,
      },
    );

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: overrideModel,
    }));
  });

  it("lazy-loads a missing agent before executing the session", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    let runtimeReady = false;
    const ensureAgentLoaded = vi.fn(async () => {
      runtimeReady = true;
      return {
        agentDir: path.join(tmpDir, "agents", "hanako"),
        personality: "personality",
        systemPrompt: "prompt",
        tools: [],
        config: {},
      };
    });

    await runAgentSession(
      "hanako",
      [{ text: "hello", capture: true }],
      {
        engine: {
          homeCwd: tmpDir,
          ensureAgentLoaded,
          getAgent: () => runtimeReady ? ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }) : null,
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(ensureAgentLoaded).toHaveBeenCalledWith("hanako");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });
});
