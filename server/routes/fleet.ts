/**
 * fleet.ts — Worker Fleet HTTP surface (B-line). Sibling of tasks.ts; registered in
 * server/index.ts next to createTasksRoute. Reads/writes the in-memory FleetHub and
 * relies on the hub to broadcast `fleet:event` over the existing WebSocket.
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { FleetHub, type FleetBrief } from "../fleet/fleet-hub.js";
import { DEFAULT_FLEET_REGISTRY } from "../fleet/registry.js";

function validateBrief(b: Partial<FleetBrief>): string[] {
  const errs: string[] = [];
  if (!b.title) errs.push("title is required");
  if (!b.agent) errs.push("agent is required");
  if (!b.branch) errs.push("branch is required");
  if (!b.worktree) errs.push("worktree is required");
  if (!Array.isArray(b.owned)) errs.push("owned[] is required");
  if (!Array.isArray(b.forbidden)) errs.push("forbidden[] is required");
  return errs;
}

export function createFleetRoute(hub: FleetHub): Hono {
  const route = new Hono();

  route.get("/fleet/registry", (c) => c.json({ agents: DEFAULT_FLEET_REGISTRY }));

  route.get("/fleet/workers", (c) => c.json({ workers: hub.listWorkers() }));

  route.get("/fleet/workers/:id", (c) => {
    const worker = hub.getWorker(c.req.param("id"));
    if (!worker) return c.json({ error: "worker not found" }, 404);
    return c.json({ worker });
  });

  route.post("/fleet/dispatch", async (c) => {
    const body = await safeJson<Partial<FleetBrief>>(c);
    const errors = validateBrief(body);
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const worker = await hub.dispatch(body as FleetBrief);
    return c.json({ ok: true, worker });
  });

  route.post("/fleet/workers/:id/cancel", (c) => {
    const ok = hub.cancel(c.req.param("id"));
    if (!ok) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true });
  });

  route.post("/fleet/workers/:id/retry", async (c) => {
    const worker = await hub.retry(c.req.param("id"));
    if (!worker) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true, worker });
  });

  route.get("/fleet/workers/:id/diff", async (c) => {
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file query param required" }, 400);
    const result = await hub.getWorkerFileDiff(c.req.param("id"), file);
    if (!result) return c.json({ error: "worker not found" }, 404);
    return c.json(result);
  });

  return route;
}

export { FleetHub };
