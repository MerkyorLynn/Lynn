/**
 * fleet-hub.ts - in-memory orchestration of worker dispatch + event fan-out (B-line).
 *
 * dispatch() really spawns `lynn worker run --jsonl` when a CLI runtime is resolvable
 * (worker-command.ts: env from desktop main, or a dev cli build), streaming the
 * worker's JSONL events over the existing server WebSocket ({ type: "fleet:event" }).
 * When no CLI runtime is available (cli/** not yet integrated), it falls back to a
 * stub broadcast so the GUI board still demos. Worktree creation + spawn + the brief
 * file are injectable for tests.
 */
import type { FleetWorkerEvent, FleetAgentKind } from "../../shared/fleet-events.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "./worktree-manager.js";
import { spawnWorker, type WorkerHandle } from "./worker-manager.js";
import { cliRuntimeAvailable, resolveCliCommand, type ResolvedCommand } from "./worker-command.js";

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
  /** Vision dispatch (Pillar 1): the task kind and the image the worker should see. */
  taskType?: "code" | "see" | "ground" | "ui2code";
  image?: string;
}

export interface FleetWorkerRecord {
  workerId: string;
  agent: string;
  status: string;
  brief: FleetBrief;
  createdAt: string;
  spawned: boolean;
  events: FleetWorkerEvent[];
}

export type FleetBroadcast = (msg: unknown) => void;

/** Injectable seams (defaults wire the real implementations; tests pass fakes). */
export interface FleetHubDeps {
  available?: () => boolean;
  resolveCommand?: (workerArgs: string[]) => ResolvedCommand | null;
  writeBrief?: (brief: FleetBrief, workerId: string) => string;
  spawn?: (opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; workerId: string }, onEvent: (e: FleetWorkerEvent) => void) => WorkerHandle;
  createWorktree?: (relPath: string, branch: string, baseRef: string) => Promise<void>;
}

/** Reject absolute paths and `..` traversal before handing a file path to git. */
function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/**
 * Markdown brief written for `lynn worker run --brief`. NOTE: this file format is a
 * contract with the CLI lane's `--brief` parser - align with Codex before real spawn.
 */
function defaultWriteBrief(brief: FleetBrief, workerId: string): string {
  const lines: string[] = [
    `# ${brief.title}`,
    ``,
    `Worker: ${brief.agent} | Branch: ${brief.branch} | Worktree: ${brief.worktree}`,
  ];
  if (brief.taskType) lines.push(``, `## Task Type`, brief.taskType);
  if (brief.image) lines.push(``, `## Image`, brief.image);
  lines.push(``, `## Objective`, brief.objective || "(none)", ``, `## Owned files`);
  for (const f of brief.owned) lines.push(`- ${f}`);
  lines.push(``, `## Forbidden files`);
  for (const f of brief.forbidden) lines.push(`- ${f}`);
  if (brief.testCommands?.length) {
    lines.push(``, `## Test commands`);
    for (const c of brief.testCommands) lines.push(`- ${c}`);
  }
  const p = path.join(os.tmpdir(), `lynn-fleet-${workerId}.md`);
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

const RUNNER_LABEL: Record<string, string> = {
  bundled: "bundled Node",
  electron: "Electron-as-node",
  dev: "dev CLI",
};

export class FleetHub {
  private workers = new Map<string, FleetWorkerRecord>();
  private handles = new Map<string, WorkerHandle>();
  private seq = 0;
  readonly worktrees: WorktreeManager;

  constructor(
    private repoRoot: string,
    private broadcast: FleetBroadcast,
    private now: () => string = () => new Date().toISOString(),
    private deps: FleetHubDeps = {},
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

  private available(): boolean {
    return this.deps.available ? this.deps.available() : cliRuntimeAvailable({ repoRoot: this.repoRoot });
  }

  private resolve(workerArgs: string[]): ResolvedCommand | null {
    return this.deps.resolveCommand
      ? this.deps.resolveCommand(workerArgs)
      : resolveCliCommand(workerArgs, { repoRoot: this.repoRoot });
  }

  async dispatch(brief: FleetBrief): Promise<FleetWorkerRecord> {
    const workerId = `w${++this.seq}`;
    const rec: FleetWorkerRecord = {
      workerId,
      agent: String(brief.agent),
      status: "queued",
      brief,
      createdAt: this.now(),
      spawned: false,
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

    if (brief.taskType && brief.taskType !== "code") {
      this.emit(workerId, {
        type: "worker.progress",
        ts: this.now(),
        workerId,
        message: `vision task: ${brief.taskType}${brief.image ? ` (${brief.image})` : ""}`,
        data: { kind: "vision", taskType: brief.taskType, image: brief.image },
      });
    }

    rec.status = "running";

    // Real spawn path: only when a CLI runtime is resolvable (env from main, or a dev
    // cli build). Until cli/** is integrated this is false and we use the stub below.
    if (this.available()) {
      try {
        const create =
          this.deps.createWorktree ?? ((p: string, b: string, base: string) => this.worktrees.create(p, b, base).then(() => undefined));
        await create(brief.worktree, brief.branch, "HEAD");
      } catch (e) {
        this.emit(workerId, {
          type: "worker.progress",
          ts: this.now(),
          workerId,
          message: `worktree not created (${e instanceof Error ? e.message : String(e)})`,
          level: "warning",
        });
      }
      const writeBrief = this.deps.writeBrief ?? defaultWriteBrief;
      const briefPath = writeBrief(brief, workerId);
      const workerArgs = ["worker", "run", "--brief", briefPath, "--worktree", brief.worktree, "--jsonl"];
      const cmd = this.resolve(workerArgs);
      if (cmd) {
        const spawn = this.deps.spawn ?? spawnWorker;
        const handle = spawn(
          { command: cmd.command, args: cmd.args, cwd: this.repoRoot, env: cmd.env, workerId },
          (ev) => this.emit(workerId, ev),
        );
        this.handles.set(workerId, handle);
        rec.spawned = true;
        this.emit(workerId, {
          type: "worker.progress",
          ts: this.now(),
          workerId,
          message: `spawned via ${RUNNER_LABEL[cmd.source] ?? cmd.source}${handle.pid != null ? ` (pid ${handle.pid})` : ""}`,
          data: { kind: "runner", mode: "spawned", source: cmd.source, pid: handle.pid },
        });
        return rec;
      }
    }

    // Stub fallback (no CLI runtime yet): keep the board demoable.
    this.emit(workerId, {
      type: "worker.progress",
      ts: this.now(),
      workerId,
      message: "stub - CLI bundle pending",
      data: { kind: "runner", mode: "stub" },
    });
    return rec;
  }

  cancel(id: string): boolean {
    const rec = this.workers.get(id);
    if (!rec) return false;
    const handle = this.handles.get(id);
    if (handle) {
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
      this.handles.delete(id);
    }
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
