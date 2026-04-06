import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { createDefaultMcpServerTemplate } from "../../lib/mcp-client.js";

function getManager(engine) {
  return engine.mcpManager || null;
}

export function createMcpRoute(engine) {
  const route = new Hono();

  route.get("/mcp/servers", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ servers: [], ok: false, error: "MCP manager unavailable" }, 503);
    }
    return c.json({ ok: true, servers: manager.listServerStates() });
  });

  route.post("/mcp/servers", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const body = await safeJson(c);
    const name = String(body?.name || "").trim();
    const config = body?.config || createDefaultMcpServerTemplate(body?.transport === "sse" ? "sse" : "stdio");
    if (!name) return c.json({ error: "name is required" }, 400);

    try {
      const server = await manager.saveServer(name, config);
      return c.json({ ok: true, server });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/mcp/servers/:name", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const name = c.req.param("name");
    try {
      await manager.deleteServer(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/mcp/test", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const body = await safeJson(c);
    const name = String(body?.name || "test").trim() || "test";
    const config = body?.config || createDefaultMcpServerTemplate(body?.transport === "sse" ? "sse" : "stdio");

    try {
      const result = await manager.testServerConfig(name, config);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 400);
    }
  });

  route.post("/mcp/reload", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    try {
      await manager.reload();
      return c.json({ ok: true, servers: manager.listServerStates() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
