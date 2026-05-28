import { describe, expect, it, vi } from "vitest";
import {
  applySessionToolRuntime,
  buildSessionToolsForEntry,
} from "../core/session-tool-runtime.js";

function makeEntry({ mode = "authorized", model = { id: "qwen", provider: "local" } } = {}) {
  return {
    agentId: "lynn",
    securityMode: mode,
    activeMcpServers: ["memory"],
    session: {
      model,
      sessionManager: {
        getCwd: () => "/tmp/workspace",
        getSessionFile: () => "/tmp/session.jsonl",
      },
      _buildRuntime: vi.fn(),
    },
  };
}

function makeDeps(buildTools = vi.fn(() => ({
  tools: [{ name: "read" }, { name: "grep" }, { name: "bash" }],
  customTools: [{ name: "notify" }],
}))) {
  return {
    buildTools,
    getHomeCwd: () => "/tmp/home",
    getAgentById: vi.fn(() => ({ agentDir: "/tmp/agent" })),
    getFallbackAgent: () => ({ agentDir: "/tmp/fallback-agent" }),
  };
}

describe("session tool runtime helpers", () => {
  it("builds tool options from the session entry and security mode", () => {
    const entry = makeEntry({ mode: "plan" });
    const deps = makeDeps();

    buildSessionToolsForEntry({ entry, ...deps });

    expect(deps.buildTools).toHaveBeenCalledWith("/tmp/workspace", null, expect.objectContaining({
      agentDir: "/tmp/agent",
      workspace: "/tmp/workspace",
      mode: "standard",
      activeMcpServers: ["memory"],
    }));
    const options = deps.buildTools.mock.calls[0][2];
    expect(options.getSessionPath()).toBe("/tmp/session.jsonl");
  });

  it("applies full runtime tools in authorized mode", () => {
    const entry = makeEntry();
    const deps = makeDeps();

    applySessionToolRuntime({ entry, ...deps });

    expect(entry.planMode).toBe(false);
    expect(entry.nativeToolCallingDisabled).toBe(false);
    expect(entry.session._customTools).toEqual([{ name: "notify" }]);
    expect(entry.session._baseToolsOverride).toMatchObject({
      read: { name: "read" },
      grep: { name: "grep" },
      bash: { name: "bash" },
    });
    expect(entry.session._buildRuntime).toHaveBeenCalledWith({
      activeToolNames: ["read", "grep", "bash", "notify"],
    });
  });

  it("limits built-in tools in plan mode while keeping custom tools", () => {
    const entry = makeEntry({ mode: "plan" });
    const deps = makeDeps();

    applySessionToolRuntime({ entry, ...deps });

    expect(entry.planMode).toBe(true);
    expect(entry.session._buildRuntime).toHaveBeenCalledWith({
      activeToolNames: ["read", "grep", "find", "ls", "notify"],
    });
  });

  it("disables runtime tools for models with broken native tool calls", () => {
    const entry = makeEntry({
      model: { id: "lynn-nvfp4-prism", provider: "local" },
    });
    const deps = makeDeps();
    const logger = { warn: vi.fn(), log: vi.fn() };

    applySessionToolRuntime({ entry, ...deps, logger });

    expect(entry.nativeToolCallingDisabled).toBe(true);
    expect(entry.session._customTools).toEqual([]);
    expect(entry.session._baseToolsOverride).toEqual({});
    expect(entry.session._buildRuntime).toHaveBeenCalledWith({ activeToolNames: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("runtime tools disabled"));
  });
});
