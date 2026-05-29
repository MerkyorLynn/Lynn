/**
 * fleet-hub.ts — in-memory orchestration of worker dispatch + event fan-out (B-line).
 *
 * Holds worker records, owns a WorktreeManager, and broadcasts fleet events over the
 * existing server WebSocket (envelope `{ type: "fleet:event", event }`). v0.80 step-2
 * `dispatch` is a stub: it registers the worker and streams a started/claims/progress
 * sequence so the GUI board lights up end-to-end. Real process spawn (WorkerManager) +
 * worktree creation + the merge queue land in step 4, once the CLI lane's
 * `lynn worker run --jsonl` is merged into the integration branch.
 */
import type { FleetWorkerEvent, FleetAgentKind } from "../../shared/fleet-events.js";
import path from "node:path";
import { WorktreeManager } from "./worktree-manager.js";

export interface FleetBrief {
  title: string;
  agent: FleetAgentKind | string;
  objective: string;
  owned: string[];
  forbidden: string[];
  centerLocks?: string[];
  testCommands?: string[];
  branch: string;
  worktree: string;
}

export interface FleetWorkerRecord {
  workerId: string;
  agent: string;
  status: string;
  brief: FleetBrief;
  createdAt: string;
  events: FleetWorkerEvent[];
}

export type FleetBroadcast = (msg: unknown) => void;

/** Reject absolute paths and `..` traversal before handing a file path to git. */
function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

export class FleetHub {
  private workers = new Map<string, FleetWorkerRecord>();
  private seq = 0;
  readonly worktrees: WorktreeManager;

  constructor(
    private repoRoot: string,
    private broadcast: FleetBroadcast,
    private now: () => string = () => new Date().toISOString(),
  ) {
    this.worktrees = new WorktreeManager(repoRoot);
  }

  listWorkers(): FleetWorkerRecord[] {
    return [...this.workers.values()];
  }

  getWorker(id: string): FleetWorkerRecord | undefined {
    return this.workers.get(id);
  }

  private emit(workerId: string, event: FleetWorkerEvent): void {
    const rec = this.workers.get(workerId);
    if (rec) rec.events.push(event);
    this.broadcast({ type: "fleet:event", event });
  }

  async dispatch(brief: FleetBrief): Promise<FleetWorkerRecord> {
    const workerId = `w${++this.seq}`;
    const rec: FleetWorkerRecord = {
      workerId,
      agent: String(brief.agent),
      status: "queued",
      brief,
      createdAt: this.now(),
      events: [],
    };
    this.workers.set(workerId, rec);

    this.emit(workerId, {
      schemaVersion: 1,
      type: "worker.started",
      ts: this.now(),
      workerId,
      agent: brief.agent,
      cwd: this.repoRoot,
      worktree: brief.worktree,
      branch: brief.branch,
    });
    this.emit(workerId, {
      type: "worker.claims",
      ts: this.now(),
      workerId,
      owned: brief.owned,
      forbidden: brief.forbidden,
      centerLocks: brief.centerLocks ?? [],
    });
    this.emit(workerId, {
      type: "worker.progress",
      ts: this.now(),
      workerId,
      message: `dispatched to ${brief.agent}; awaiting runner`,
    });
    rec.status = "running";
    return rec;
  }

  cancel(id: string): boolean {
    const rec = this.workers.get(id);
    if (!rec) return false;
    rec.status = "cancelled";
    this.emit(id, {
      type: "worker.error",
      ts: this.now(),
      workerId: id,
      code: "cancelled",
      message: "cancelled by user",
      recoverable: false,
    });
    return true;
  }

  /** Re-dispatch a worker's brief as a fresh worker (recovery). */
  async retry(id: string): Promise<FleetWorkerRecord | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    return this.dispatch(rec.brief);
  }

  /** Read-only single-file diff for the GUI drawer; never escapes the worktree. */
  async getWorkerFileDiff(
    id: string,
    file: string,
  ): Promise<{ file: string; diff: string; error?: string } | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    if (!isSafeRelPath(file)) return { file, diff: "", error: "invalid path" };
    const worktree = path.isAbsolute(rec.brief.worktree)
      ? rec.brief.worktree
      : path.join(this.repoRoot, rec.brief.worktree);
    try {
      return { file, diff: await this.worktrees.fileDiff(worktree, file) };
    } catch {
      return { file, diff: "" };
    }
  }
}
