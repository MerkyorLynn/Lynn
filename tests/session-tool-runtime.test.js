import { describe, expect, it, vi } from "vitest";
import {
  applySessionToolRuntime,
  buildSessionToolsForEntry,
  filterBrainManagedCustomTools,
  shouldSuppressClientToolSchema,
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
    expect(Object.keys(entry.session._baseToolsOverride)).toEqual(["read", "grep"]);
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

  it("keeps local client tools for Brain while filtering Brain-managed realtime custom tools", () => {
    expect(shouldSuppressClientToolSchema({ id: "lynn-brain-router", provider: "brain" })).toBe(false);

    const entry = makeEntry({
      model: { id: "lynn-brain-router", provider: "brain" },
    });
    const deps = makeDeps(vi.fn(() => ({
      tools: [{ name: "read" }, { name: "grep" }, { name: "bash" }],
      customTools: [{ name: "weather" }, { name: "web_search" }, { name: "notify" }],
    })));
    const logger = { warn: vi.fn(), log: vi.fn() };

    applySessionToolRuntime({ entry, ...deps, logger });

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
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("filtered 2 Brain-managed"));
  });

  it("normalizes custom tool names for DeepSeek/OpenAI-compatible chat completions", () => {
    const execute = vi.fn();
    const entry = makeEntry({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions" },
    });
    const deps = makeDeps(vi.fn(() => ({
      tools: [{ name: "read" }],
      customTools: [
        { name: "flux-studio.generate_image", execute },
        { name: "mcp.server.tool", execute },
      ],
    })));
    const logger = { warn: vi.fn(), log: vi.fn() };

    applySessionToolRuntime({ entry, ...deps, logger });

    expect(entry.session._customTools.map((tool) => tool.name)).toEqual([
      "flux-studio_generate_image",
      "mcp_server_tool",
    ]);
    expect(entry.session._customTools[0]._aliasOf).toBe("flux-studio.generate_image");
    expect(entry.session._customTools[0].execute).toBe(execute);
    expect(entry.session._buildRuntime).toHaveBeenCalledWith({
      activeToolNames: ["read", "flux-studio_generate_image", "mcp_server_tool"],
    });
  });

  it("filters only realtime custom tools owned by Brain", () => {
    expect(filterBrainManagedCustomTools([
      { name: "weather" },
      { name: "web_search" },
      { name: "notify" },
      { name: "present_files" },
    ], { id: "lynn-brain-router", provider: "brain" })).toEqual([
      { name: "notify" },
      { name: "present_files" },
    ]);
  });
});
