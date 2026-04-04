import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clearConfigCache = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache,
  getRawConfig: () => ({}),
}));

const inferredProfileGetRawProfile = vi.fn(() => ({
  traits: [{ dimension: "communication", value: "喜欢直接回答", confidence: 0.8 }],
  goals: [{ goal: "做好 Lynn", confidence: 0.9 }],
}));

const memoryExclusionsList = vi.fn(() => ({
  phrases: ["不要记住临时验证码"],
}));
const memoryExclusionsAddPhrase = vi.fn(() => true);
const memoryExclusionsRemovePhrase = vi.fn(() => true);

vi.mock("../lib/memory/inferred-profile.js", () => ({
  InferredProfile: class {
    getRawProfile() {
      return inferredProfileGetRawProfile();
    }
  },
}));

vi.mock("../lib/memory/memory-exclusions.js", () => ({
  MemoryExclusions: class {
    list() {
      return memoryExclusionsList();
    }
    addPhrase(phrase) {
      return memoryExclusionsAddPhrase(phrase);
    }
    removePhrase(phrase) {
      return memoryExclusionsRemovePhrase(phrase);
    }
  },
}));

describe("config memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns grouped memory timeline plus inferred profile", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();

    const factStore = {
      exportAll: vi.fn(() => ([
        {
          id: 2,
          fact: "用户喜欢暖色主题",
          category: "preference",
          confidence: 0.8,
          evidence: "明确提到米色暖阳主题",
          created_at: "2026-04-04T10:00:00.000Z",
          time: "2026-04-04T10:00",
          source: null,
        },
        {
          id: 1,
          fact: "Lynn 使用 Electron 架构",
          category: "project",
          confidence: 0.9,
          evidence: "对话明确提到",
          created_at: "2026-04-03T10:00:00.000Z",
          time: "2026-04-03T10:00",
          source: "conversation",
        },
      ])),
    };

    const engine = {
      agent: { agentDir: "/tmp/.lynn/agents/lynn" },
      agentsDir: "/tmp/.lynn/agents",
      factStore,
      inferredProfile: { getRawProfile: inferredProfileGetRawProfile },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/memories/timeline?days=30");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.timeline).toHaveLength(2);
    expect(data.timeline[0].date).toBe("2026-04-04");
    expect(data.timeline[0].items[0].sourceType).toBe("conversation");
    expect(data.inferredProfile.traits[0].value).toBe("喜欢直接回答");
    expect(data.exclusions.phrases[0]).toBe("不要记住临时验证码");
  });

  it("patches a memory entry and returns the updated item", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();

    const updatedMemory = {
      id: 7,
      fact: "用户喜欢暖色主题",
      category: "preference",
      confidence: 0.95,
      evidence: "用户再次确认",
    };

    const factStore = {
      updateFact: vi.fn(() => updatedMemory),
      exportAll: vi.fn(() => []),
    };

    const engine = {
      agent: { agentDir: "/tmp/.lynn/agents/lynn" },
      agentsDir: "/tmp/.lynn/agents",
      factStore,
      inferredProfile: { getRawProfile: inferredProfileGetRawProfile },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/memories/7", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "preference", confidence: 0.95, evidence: "用户再次确认" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(factStore.updateFact).toHaveBeenCalledWith(7, {
      category: "preference",
      confidence: 0.95,
      evidence: "用户再次确认",
    });
    expect(data.memory).toEqual(updatedMemory);
  });

  it("deletes a memory entry", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();

    const factStore = {
      delete: vi.fn(() => true),
      exportAll: vi.fn(() => []),
    };

    const engine = {
      agent: { agentDir: "/tmp/.lynn/agents/lynn" },
      agentsDir: "/tmp/.lynn/agents",
      factStore,
      inferredProfile: { getRawProfile: inferredProfileGetRawProfile },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/memories/9", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(factStore.delete).toHaveBeenCalledWith(9);
  });

  it("adds a memory exclusion phrase", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      agent: { agentDir: "/tmp/.lynn/agents/lynn" },
      agentsDir: "/tmp/.lynn/agents",
      factStore: { exportAll: vi.fn(() => []) },
      inferredProfile: { getRawProfile: inferredProfileGetRawProfile },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/memories/exclusions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase: "不要记住临时验证码" }),
    });

    expect(res.status).toBe(200);
    expect(memoryExclusionsAddPhrase).toHaveBeenCalledWith("不要记住临时验证码");
  });
});
