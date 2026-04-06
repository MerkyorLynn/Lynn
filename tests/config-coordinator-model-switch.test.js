import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/memory/config-loader.js", () => ({
  saveConfig: vi.fn(),
}));

import { saveConfig } from "../lib/memory/config-loader.js";
import { ConfigCoordinator } from "../core/config-coordinator.js";

describe("ConfigCoordinator model switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches the active session model and persists the agent default chat model", async () => {
    const oldModel = { id: "step-3.5-flash-2603", provider: "brain", name: "Step" };
    const nextModel = { id: "glm-5.1", provider: "glm", name: "GLM-5.1" };
    const setDefaultModel = vi.fn(() => nextModel);
    const switchCurrentSessionModel = vi.fn(async () => ({ appliedToSession: true, pendingOnly: false }));

    const prefs = {
      trusted_roots: [],
    };

    const coord = new ConfigCoordinator({
      lynnHome: "/tmp/lynn",
      agentsDir: "/tmp/lynn/agents",
      getAgent: () => ({
        configPath: "/tmp/lynn/agents/lynn/config.yaml",
        sessionDir: "/tmp/lynn/agents/lynn/sessions",
        config: { models: { chat: { id: oldModel.id, provider: oldModel.provider } } },
        memoryEnabled: true,
      }),
      getAgents: () => new Map(),
      getModels: () => ({
        availableModels: [oldModel, nextModel],
        setDefaultModel,
      }),
      getPrefs: () => ({
        getPreferences: () => prefs,
        savePreferences: vi.fn(),
      }),
      getSkills: () => null,
      getSession: () => ({
        sessionManager: { getSessionFile: () => "/tmp/lynn/agents/lynn/sessions/current.jsonl" },
      }),
      getSessionCoordinator: () => ({
        switchCurrentSessionModel,
        getCurrentSessionModelRef: () => ({ id: nextModel.id, provider: nextModel.provider }),
      }),
      getHub: () => null,
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getCurrentModel: () => oldModel.name,
    });

    const result = await coord.setPendingModel(nextModel.id, nextModel.provider);

    expect(result).toEqual(nextModel);
    expect(switchCurrentSessionModel).toHaveBeenCalledWith(nextModel);
    expect(setDefaultModel).toHaveBeenCalledWith(nextModel.id, nextModel.provider);
    expect(saveConfig).toHaveBeenCalledWith("/tmp/lynn/agents/lynn/config.yaml", {
      models: { chat: { id: "glm-5.1", provider: "glm" } },
      api: { provider: "glm" },
    });
  });
});
