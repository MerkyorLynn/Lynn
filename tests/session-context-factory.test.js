import { describe, expect, it, vi } from "vitest";
import {
  createSessionContextFactory,
  resolveSessionContextModel,
} from "../core/session-context-factory.js";

function makeModels(models, defaultModel = models[0] || null) {
  return {
    availableModels: models,
    defaultModel,
    authStorage: { kind: "auth" },
    modelRegistry: { kind: "registry" },
  };
}

describe("session context factory", () => {
  it("creates the context shape consumed by agent sessions", () => {
    const buildTools = vi.fn(() => ({ tools: [{ name: "read" }], customTools: [] }));
    const skills = {
      allSkills: [{ name: "skill" }],
      getSkillsForAgent: vi.fn(() => [{ name: "agent-skill" }]),
    };

    const ctx = createSessionContextFactory({
      models: makeModels([{ id: "m", provider: "p" }]),
      skills,
      resourceLoader: { getSystemPrompt: () => "prompt" },
      buildTools,
      log: { log: vi.fn(), error: vi.fn() },
      t: (key) => key,
    });

    expect(ctx.authStorage).toEqual({ kind: "auth" });
    expect(ctx.modelRegistry).toEqual({ kind: "registry" });
    expect(ctx.allSkills).toEqual([{ name: "skill" }]);
    expect(ctx.getSkillsForAgent({ id: "a" })).toEqual([{ name: "agent-skill" }]);
    expect(ctx.buildTools("/tmp")).toEqual({ tools: [{ name: "read" }], customTools: [] });
    expect(ctx.resolveModel({ models: { chat: "m" } })).toEqual({ id: "m", provider: "p" });
  });

  it("resolves configured provider-specific chat models", () => {
    expect(resolveSessionContextModel({
      models: { chat: { id: "same", provider: "b" } },
    }, {
      models: makeModels([
        { id: "same", provider: "a" },
        { id: "same", provider: "b" },
      ]),
      log: { log: vi.fn(), error: vi.fn() },
      t: (key) => key,
    })).toEqual({ id: "same", provider: "b" });
  });

  it("falls back to default model when chat ref is missing or unavailable", () => {
    const defaultModel = { id: "default", provider: "brain" };
    const opts = {
      models: makeModels([defaultModel], defaultModel),
      log: { log: vi.fn(), error: vi.fn() },
      t: (key) => key,
    };

    expect(resolveSessionContextModel({}, opts)).toBe(defaultModel);
    expect(resolveSessionContextModel({ models: { chat: "missing" } }, opts)).toBe(defaultModel);
  });

  it("throws translated errors when no fallback exists", () => {
    const opts = {
      models: makeModels([], null),
      log: { log: vi.fn(), error: vi.fn() },
      t: (key, vars) => `${key}:${vars?.id || ""}`,
    };

    expect(() => resolveSessionContextModel({}, opts)).toThrow("error.resolveModelNoChatModel");
    expect(() => resolveSessionContextModel({ models: { chat: "missing" } }, opts))
      .toThrow("error.resolveModelNotAvailable:missing");
  });
});
