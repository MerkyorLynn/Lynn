import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAppStateRoute } from "../server/routes/app-state.js";

function makeEngine() {
  const prefs = {
    review: {
      defaultReviewer: "hanako",
      hanakoReviewerId: "agent-hanako",
      butterReviewerId: "agent-butter",
    },
  };
  const agents = [
    { id: "lynn", name: "Lynn", yuan: "lynn", tier: "local", hasAvatar: true, isPrimary: true },
    { id: "agent-hanako", name: "Hanako Review", yuan: "hanako", tier: "reviewer", hasAvatar: true, isPrimary: false },
    { id: "agent-butter", name: "Butter Review", yuan: "butter", tier: "reviewer", hasAvatar: false, isPrimary: false },
  ];

  return {
    currentAgentId: "lynn",
    agentName: "Lynn",
    agent: { config: { agent: { yuan: "lynn" }, api: { provider: "brain" }, models: { chat: { id: "step-3.5-flash-2603", provider: "brain" } } } },
    currentModel: { id: "step-3.5-flash-2603", name: "Step-3.5-Flash-2603", provider: "brain" },
    config: {
      api: { provider: "brain" },
      models: { chat: { id: "step-3.5-flash-2603", provider: "brain" } },
      providers: { brain: { models: ["step-3.5-flash-2603", "glm-z1-9b-0414", "qwen3-8b"] } },
    },
    preferences: {
      getPrimaryAgent: () => "lynn",
    },
    getPreferences: () => prefs,
    getSharedModels: () => ({
      utility: { id: "glm-z1-9b-0414", provider: "brain" },
      utility_large: { id: "step-3.5-flash-2603", provider: "brain" },
    }),
    getSearchConfig: () => ({ provider: "", api_key: "" }),
    getSecurityMode: () => "authorized",
    planMode: false,
    cwd: "/Users/lynn/openhanako",
    getHomeFolder: () => "/Users/lynn/Desktop/Lynn",
    getTrustedRoots: () => ["/Users/lynn/Desktop/Lynn", "/Users/lynn/openhanako"],
    getAllSkills: () => ([
      { name: "tavily-search", enabled: true, hidden: false, source: "builtin" },
      { name: "summarize", enabled: true, hidden: false, source: "builtin" },
      { name: "learned-checklist", enabled: true, hidden: false, source: "learned" },
    ]),
    mcpManager: {
      serverCount: 2,
      toolCount: 5,
    },
    listAgents: () => agents,
    getAgent: (id) => {
      const agent = agents.find((item) => item.id === id);
      return {
        ...agent,
        config: {
          agent: { yuan: agent?.yuan, tier: agent?.tier },
          api: { provider: "brain" },
          models: { chat: { id: "step-3.5-flash-2603", provider: "brain" } },
        },
      };
    },
  };
}

describe("app-state route", () => {
  it("returns unified runtime state with review and task snapshot", async () => {
    const app = new Hono();
    const engine = makeEngine();
    const taskRuntime = {
      listTasks: vi.fn(() => [
        {
          id: "task-1",
          title: "Long task",
          status: "running",
          progress: { currentLabel: "Running" },
          snapshot: { agentId: "lynn" },
        },
      ]),
    };

    app.route("/api", createAppStateRoute(engine, { taskRuntime }));

    const res = await app.request("/api/app-state");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.agent).toEqual(expect.objectContaining({
      currentAgentId: "lynn",
      primaryAgentId: "lynn",
      yuan: "lynn",
    }));
    expect(data.model).toEqual(expect.objectContaining({
      current: expect.objectContaining({ id: "step-3.5-flash-2603", provider: "brain" }),
      preferredProviderId: "brain",
    }));
    expect(data.review).toEqual(expect.objectContaining({
      defaultReviewer: "hanako",
      hanakoReviewerId: "agent-hanako",
    }));
    expect(data.tasks).toEqual(expect.objectContaining({
      activeCount: 1,
      runningCount: 1,
      recent: [expect.objectContaining({ id: "task-1" })],
    }));
    expect(data.capabilities).toEqual(expect.objectContaining({
      enabledSkills: 3,
      learnedSkills: 1,
      mcp: expect.objectContaining({ servers: 2, tools: 5 }),
      projectInstructions: expect.objectContaining({
        layers: expect.any(Number),
      }),
    }));
  });
});
