import { describe, expect, it, vi } from "vitest";
import {
  notifyActiveSessionEnd,
  prepareCachedSessionSwitch,
  resolveColdStartSwitchModel,
} from "../core/session-switch-runtime.js";

describe("session switch runtime helpers", () => {
  it("notifies the owner agent for the active session being left", async () => {
    const oldSession = { sessionManager: { getSessionFile: () => "/tmp/old.jsonl" } };
    const ownerAgent = { id: "owner" };
    const fallbackAgent = { id: "fallback" };
    const notifySessionEnd = vi.fn();

    await notifyActiveSessionEnd({
      activeSession: oldSession,
      sessions: new Map([["/tmp/old.jsonl", { agentId: "agent-a", session: oldSession, lastTouchedAt: 1 }]]),
      getAgentById: (agentId) => agentId === "agent-a" ? ownerAgent : null,
      getFallbackAgent: () => fallbackAgent,
      notifySessionEnd,
      context: "session switch",
    });

    expect(notifySessionEnd).toHaveBeenCalledWith(ownerAgent, "/tmp/old.jsonl", "session switch");
  });

  it("activates a cached target session and restores its memory toggle", async () => {
    const oldSession = { sessionManager: { getSessionFile: () => "/tmp/old.jsonl" } };
    const newSession = { sessionManager: { getSessionFile: () => "/tmp/new.jsonl" } };
    const targetAgent = { setMemoryEnabled: vi.fn() };
    const notifySessionEnd = vi.fn();
    const targetEntry = { agentId: "agent-b", session: newSession, lastTouchedAt: 1 };

    const result = await prepareCachedSessionSwitch({
      activeSession: oldSession,
      targetEntry,
      sessions: new Map([
        ["/tmp/old.jsonl", { agentId: "agent-a", session: oldSession, lastTouchedAt: 1 }],
        ["/tmp/new.jsonl", targetEntry],
      ]),
      memoryEnabled: false,
      getAgentById: (agentId) => agentId === "agent-b" ? targetAgent : { id: agentId },
      getFallbackAgent: () => ({ id: "fallback" }),
      notifySessionEnd,
      now: () => 42,
    });

    expect(result).toBe(newSession);
    expect(targetEntry.lastTouchedAt).toBe(42);
    expect(targetAgent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(notifySessionEnd).toHaveBeenCalledWith({ id: "agent-a" }, "/tmp/old.jsonl", "session switch");
  });

  it("resolves saved cold-start models and reports missing refs", () => {
    const model = { id: "qwen", provider: "local", name: "Qwen" };
    expect(resolveColdStartSwitchModel({
      savedModelRef: { id: "qwen", provider: "local" },
      availableModels: [model],
    })).toBe(model);

    const onMissingModel = vi.fn();
    expect(resolveColdStartSwitchModel({
      savedModelRef: { id: "missing", provider: "local" },
      availableModels: [model],
      onMissingModel,
    })).toBeNull();
    expect(onMissingModel).toHaveBeenCalledWith({ id: "missing", provider: "local" });
  });
});
