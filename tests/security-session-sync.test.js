import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsRoute } from "../server/routes/sessions.js";

function makeEngine() {
  const engine = {
    agentsDir: "/tmp/agents",
    currentSessionPath: "/tmp/agents/main/sessions/current.jsonl",
    currentAgentId: "agent-main",
    agentName: "Lynn",
    cwd: "/workspace/main",
    planMode: false,
    securityMode: "authorized",
    memoryEnabled: true,
    memoryModelUnavailableReason: null,
    currentModel: { id: "gpt-5", provider: "openai" },
    config: {},
    messages: [],
    createSession: vi.fn(async () => {}),
    createSessionForAgent: vi.fn(async () => {}),
    persistSessionMeta: vi.fn(),
    updateConfig: vi.fn(async () => {}),
    isSessionStreaming: vi.fn(() => false),
    listSessions: vi.fn(async () => []),
  };

  engine.switchSession = vi.fn(async (sessionPath) => {
    engine.currentSessionPath = sessionPath;
    engine.cwd = "/workspace/switched";
    engine.planMode = true;
    engine.securityMode = "safe";
  });

  return engine;
}

describe("sessions route security mode sync", () => {
  let engine;
  let app;

  beforeEach(() => {
    engine = makeEngine();
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("returns securityMode when creating a session", async () => {
    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: true, cwd: "/workspace/new" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.securityMode).toBe("authorized");
  });

  it("returns securityMode after switching sessions", async () => {
    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/main/sessions/target.jsonl" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.planMode).toBe(true);
    expect(data.securityMode).toBe("safe");
  });
});
