import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createToolsRoute } from "../server/routes/tools.js";

function makeApp(tools) {
  const engine = {
    pluginManager: {
      getAllTools: () => tools,
    },
  };
  const app = new Hono();
  app.route("/api", createToolsRoute(engine));
  return app;
}

describe("tools route", () => {
  it("resolves an exact fully-qualified tool name", async () => {
    const execute = vi.fn(async (body) => ({ ok: true, via: "exact", body }));
    const app = makeApp([
      { name: "tts-bridge.tts_speak", execute },
    ]);

    const res = await app.request("/api/tts-bridge.tts_speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, via: "exact", body: { text: "hello" } });
    expect(execute).toHaveBeenCalledWith({ text: "hello" });
  });

  it("resolves a unique short alias by suffix", async () => {
    const execute = vi.fn(async (body) => ({ ok: true, via: "suffix", body }));
    const app = makeApp([
      { name: "tts-bridge.tts_speak", execute },
      { name: "rag-core.knowledge_query", execute: vi.fn() },
    ]);

    const res = await app.request("/api/tts_speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, via: "suffix", body: { text: "hello" } });
    expect(execute).toHaveBeenCalledWith({ text: "hello" });
  });

  it("returns 409 when a short alias matches multiple tools", async () => {
    const app = makeApp([
      { name: "tts-bridge.tts_speak", execute: vi.fn() },
      { name: "voice-tools.tts_speak", execute: vi.fn() },
    ]);

    const res = await app.request("/api/tts_speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Tool alias "tts_speak" is ambiguous',
      matches: ["tts-bridge.tts_speak", "voice-tools.tts_speak"],
    });
  });

  it("returns 404 for unknown tools", async () => {
    const app = makeApp([
      { name: "tts-bridge.tts_speak", execute: vi.fn() },
    ]);

    const res = await app.request("/api/not_real", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Tool "not_real" not found' });
  });
});
