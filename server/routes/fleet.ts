/**
 * fleet.ts — Worker Fleet HTTP surface (B-line). Sibling of tasks.ts; registered in
 * server/index.ts next to createTasksRoute. Reads/writes the in-memory FleetHub and
 * relies on the hub to broadcast `fleet:event` over the existing WebSocket.
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { FleetHub, type FleetBrief } from "../fleet/fleet-hub.js";
import { configuredCliProviderPreset, resolveFleetRegistry, type FleetAgentEntry } from "../fleet/registry.js";
import { readPermissionStatus } from "../fleet/permissions.js";
import type { FleetApprovalMode, FleetSandboxMode } from "../../shared/fleet-events.js";

const APPROVALS = new Set<FleetApprovalMode>(["ask", "on-failure", "never", "yolo"]);
const SANDBOXES = new Set<FleetSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);

function validateBrief(b: Partial<FleetBrief>): string[] {
  const errs: string[] = [];
  if (!b.title) errs.push("title is required");
  if (!b.agent) errs.push("agent is required");
  if (!b.branch) errs.push("branch is required");
  if (!b.worktree) errs.push("worktree is required");
  if (!Array.isArray(b.owned)) errs.push("owned[] is required");
  if (!Array.isArray(b.forbidden)) errs.push("forbidden[] is required");
  if (b.approval && !APPROVALS.has(b.approval)) errs.push("approval is invalid");
  if (b.sandbox && !SANDBOXES.has(b.sandbox)) errs.push("sandbox is invalid");
  return errs;
}

export interface FleetRouteOptions {
  registry?: () => FleetAgentEntry[];
}

function defaultRegistry(): FleetAgentEntry[] {
  return resolveFleetRegistry({ configuredPreset: configuredCliProviderPreset() });
}

function unavailableAgentError(agent: string, registry: FleetAgentEntry[]): string | null {
  const entry = registry.find((candidate) => candidate.id === agent);
  if (!entry) return `unknown worker agent: ${agent}`;
  if (!entry.enabled || entry.available === false) {
    return `${agent} unavailable: ${entry.availability || "disabled"}`;
  }
  return null;
}

export function createFleetRoute(hub: FleetHub, options: FleetRouteOptions = {}): Hono {
  const route = new Hono();
  const registry = options.registry || defaultRegistry;

  route.get("/fleet/registry", (c) => c.json({ agents: registry() }));

  // B2: read-only CLI permission profile (approval / sandbox) for the GUI badge.
  route.get("/fleet/permissions", async (c) => c.json(await readPermissionStatus()));

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
    const agentError = unavailableAgentError(String(body.agent), registry());
    if (agentError) return c.json({ error: agentError }, 409);
    const worker = await hub.dispatch(body as FleetBrief);
    return c.json({ ok: true, worker });
  });

  route.post("/fleet/workers/:id/cancel", (c) => {
    const ok = hub.cancel(c.req.param("id"));
    if (!ok) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true });
  });

  route.post("/fleet/workers/:id/retry", async (c) => {
    const resume = c.req.query("resume") === "1" || c.req.query("resume") === "true";
    const worker = await hub.retry(c.req.param("id"), { resumeFromCheckpoint: resume });
    if (!worker) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true, worker });
  });

  route.post("/fleet/workers/:id/approve", async (c) => {
    const result = await hub.approve(c.req.param("id"));
    if (!result) return c.json({ error: "worker not found" }, 404);
    if (!result.ok) return c.json({ error: result.error || "worker cannot be approved" }, 409);
    return c.json({ ok: true, commit: result.commit, changed: result.changed });
  });

  route.post("/fleet/workers/:id/integrate", async (c) => {
    let body: { branch?: string; force?: boolean } = {};
    try {
      body = await safeJson<{ branch?: string; force?: boolean }>(c);
    } catch {
      body = {};
    }
    const result = await hub.integrate(c.req.param("id"), body.branch || "fleet/integration", { force: !!body.force });
    if (!result) return c.json({ error: "worker not found" }, 404);
    if (!result.ok) return c.json({ error: result.error || "worker cannot be integrated", gate: result.gate }, 409);
    return c.json({ ok: true, branch: result.branch, commit: result.commit, sourceCommit: result.sourceCommit, gate: result.gate });
  });

  route.get("/fleet/workers/:id/gate", (c) => {
    const gate = hub.gateStatus(c.req.param("id"));
    if (!gate) return c.json({ error: "worker not found" }, 404);
    return c.json(gate);
  });

  route.post("/fleet/workers/:id/discard", async (c) => {
    const result = await hub.discard(c.req.param("id"));
    if (!result) return c.json({ error: "worker not found" }, 404);
    if (!result.ok) return c.json({ error: result.error || "worker cannot be discarded" }, 409);
    return c.json({ ok: true });
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
