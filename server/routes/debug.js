import { Hono } from "hono";
import { getRuntimeDiagnostics } from "../diagnostics.js";

export function createDebugRoute(engine) {
  const route = new Hono();

  route.get("/debug/runtime", async (c) => {
    try {
      return c.json(getRuntimeDiagnostics(engine));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
