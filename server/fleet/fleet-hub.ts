/**
 * fleet-hub.ts - in-memory orchestration of worker dispatch + event fan-out (B-line).
 *
 * dispatch() really spawns `lynn worker run --jsonl` when a CLI runtime is resolvable
 * (worker-command.ts: env from desktop main, or a dev cli build), streaming the
 * worker's JSONL events over the existing server WebSocket ({ type: "fleet:event" }).
 * When no CLI runtime is available, it falls back to a demo broadcast so the GUI
 * board still works. Worktree creation + spawn + the brief
 * file are injectable for tests.
 */
import type {
  FleetWorkerEvent,
  FleetAgentKind,
  FleetApprovalMode,
  FleetSandboxMode,
  FleetWorkerStatus,
} from "../../shared/fleet-events.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager, type WorktreeCommitResult, type WorktreeIntegrateResult } from "./worktree-manager.js";
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
  /** Optional CLI session checkpoint used to resume a long-running worker. */
  resumePath?: string;
  /** Explicit worker permission profile. Fleet never hides an autonomous YOLO run. */
  approval?: FleetApprovalMode;
  sandbox?: FleetSandboxMode;
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
  removeWorktree?: (worktreePath: string) => Promise<void>;
  commitWorktree?: (worktreePath: string, message: string) => Promise<WorktreeCommitResult>;
  integrateCommit?: (commit: string, branch: string) => Promise<WorktreeIntegrateResult>;
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
  if (brief.resumePath) lines.push(``, `## Resume`, brief.resumePath);
  if (brief.approval || brief.sandbox) {
    lines.push(``, `## Permissions`);
    if (brief.approval) lines.push(`- approval: ${brief.approval}`);
    if (brief.sandbox) lines.push(`- sandbox: ${brief.sandbox}`);
  }
  lines.push(``, `## Objective`, brief.objective || "(none)", ``, `## Owned files`);
  for (const f of brief.owned) lines.push(`- ${f}`);
  lines.push(``, `## Forbidden files`);
  for (const f of brief.forbidden) lines.push(`- ${f}`);
  if (brief.centerLocks?.length) {
    lines.push(``, `## Center locks`);
    for (const f of brief.centerLocks) lines.push(`- ${f}`);
  }
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
    if (rec) {
      rec.events.push(event);
      rec.status = statusAfterEvent(rec.status, event);
    }
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
      approval: brief.approval,
      sandbox: brief.sandbox,
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
    // cli build). Otherwise the board falls back to a demo runner below.
    if (this.available()) {
      try {
        const create =
          this.deps.createWorktree ?? ((p: string, b: string, base: string) => this.worktrees.create(p, b, base).then(() => undefined));
        await create(brief.worktree, brief.branch, "HEAD");
      } catch (e) {
        this.emit(workerId, {
          type: "worker.error",
          ts: this.now(),
          workerId,
          code: "worktree_create_failed",
          message: `worktree not created: ${e instanceof Error ? e.message : String(e)}`,
          recoverable: true,
        });
        return rec;
      }
      const writeBrief = this.deps.writeBrief ?? defaultWriteBrief;
      const briefPath = writeBrief(brief, workerId);
      const workerArgs = [
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        brief.worktree,
        "--agent",
        String(brief.agent),
        "--id",
        workerId,
        "--jsonl",
      ];
      if (brief.approval) workerArgs.push("--approval", brief.approval);
      if (brief.sandbox) workerArgs.push("--sandbox", brief.sandbox);
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

    // Demo fallback (no CLI runtime): keep the board inspectable and testable.
    this.emit(workerId, {
      type: "worker.progress",
      ts: this.now(),
      workerId,
      message: "demo runner - CLI runtime unavailable",
      data: { kind: "runner", mode: "stub" },
    });
    this.emit(workerId, {
      type: "worker.error",
      ts: this.now(),
      workerId,
      code: "cli_runtime_unavailable",
      message: "CLI runtime unavailable; build or bundle Lynn CLI before dispatching a real worker",
      recoverable: true,
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
  async retry(id: string, opts: { resumeFromCheckpoint?: boolean } = {}): Promise<FleetWorkerRecord | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    const checkpoint = opts.resumeFromCheckpoint ? latestCheckpointPath(rec.events) : undefined;
    const retryBrief = freshRetryBrief(rec.brief, this.seq + 1);
    return this.dispatch(checkpoint ? { ...retryBrief, resumePath: checkpoint } : retryBrief);
  }

  /** Mark a reviewed worker as accepted. This is intentionally not a git merge. */
  async approve(id: string): Promise<{ ok: boolean; error?: string; commit?: string; changed?: boolean } | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    if (rec.status !== "waiting_approval") {
      return { ok: false, error: `worker is ${rec.status}, not waiting_approval` };
    }
    let result: WorktreeCommitResult = { changed: false };
    try {
      const commit = this.deps.commitWorktree ?? ((p: string, message: string) => this.worktrees.commitAll(p, message));
      result = await commit(this.resolveWorktreePath(rec.brief.worktree), reviewCommitMessage(rec));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit(id, {
        type: "worker.progress",
        ts: this.now(),
        workerId: id,
        message: `review commit failed: ${message}`,
        level: "warning",
      });
      return { ok: false, error: `review commit failed: ${message}` };
    }
    this.emit(id, {
      type: "worker.progress",
      ts: this.now(),
      workerId: id,
      message: result.commit ? `review approved: ${result.commit}` : "review approved (no changes)",
      data: { kind: "review", action: "approved", commit: result.commit, changed: result.changed },
    });
    return { ok: true, commit: result.commit, changed: result.changed };
  }

  /** Discard a reviewed worker and remove its worktree when possible. */
  async discard(id: string): Promise<{ ok: boolean; error?: string } | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    if (["queued", "running"].includes(rec.status)) {
      return { ok: false, error: `worker is ${rec.status}; cancel it before discarding` };
    }
    const worktreePath = rec.brief.worktree;
    try {
      const remove = this.deps.removeWorktree ?? ((p: string) => this.worktrees.remove(p, true));
      await remove(worktreePath);
      this.emit(id, {
        type: "worker.progress",
        ts: this.now(),
        workerId: id,
        message: "worktree discarded",
      });
    } catch (e) {
      this.emit(id, {
        type: "worker.progress",
        ts: this.now(),
        workerId: id,
        message: `worktree discard failed: ${e instanceof Error ? e.message : String(e)}`,
        level: "warning",
      });
    }
    this.emit(id, {
      type: "worker.progress",
      ts: this.now(),
      workerId: id,
      message: "review discarded",
      data: { kind: "review", action: "discarded" },
    });
    return { ok: true };
  }

  /**
   * Move an approved worker commit into a staging integration branch. This never
   * merges into main; the target branch is explicit and defaults to fleet/integration.
   */
  async integrate(
    id: string,
    targetBranch = "fleet/integration",
    opts: { force?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string; branch?: string; commit?: string; sourceCommit?: string; gate?: FleetGateResult } | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    const sourceCommit = latestApprovedCommit(rec.events);
    if (!sourceCommit) return { ok: false, error: "worker has no approved commit to integrate" };

    // Test gate: never merge a worker that failed tests/gates or touched forbidden
    // files unless the operator explicitly forces it. This is what makes the
    // dispatch -> run -> review -> merge loop *verifiable*.
    const gate = evaluateGate(rec.events);
    if (!gate.passed && !opts.force) {
      return { ok: false, error: `gate not passed: ${gate.reasons.join("; ")}`, gate };
    }
    try {
      const integrate = this.deps.integrateCommit ?? ((commit: string, branch: string) => this.worktrees.integrateCommit(commit, branch));
      const result = await integrate(sourceCommit, targetBranch);
      this.emit(id, {
        type: "worker.progress",
        ts: this.now(),
        workerId: id,
        message: `review integrated: ${result.branch}@${result.commit}`,
        data: {
          kind: "review",
          action: "integrated",
          commit: result.commit,
          sourceCommit: result.sourceCommit,
          branch: result.branch,
          changed: true,
        },
      });
      return { ok: true, branch: result.branch, commit: result.commit, sourceCommit: result.sourceCommit, gate };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit(id, {
        type: "worker.progress",
        ts: this.now(),
        workerId: id,
        message: `review integrate failed: ${message}`,
        level: "warning",
      });
      return { ok: false, error: `review integrate failed: ${message}` };
    }
  }

  /** Merge gate for the GUI: tests/gates passing and scope clean? */
  gateStatus(id: string): FleetGateResult | null {
    const rec = this.workers.get(id);
    if (!rec) return null;
    return evaluateGate(rec.events);
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

  private resolveWorktreePath(worktreePath: string): string {
    return path.isAbsolute(worktreePath) ? worktreePath : path.join(this.repoRoot, worktreePath);
  }
}

function reviewCommitMessage(rec: FleetWorkerRecord): string {
  const title = rec.brief.title.replace(/\s+/g, " ").trim().slice(0, 80) || "worker changes";
  return `fleet(${rec.agent}): ${title}\n\nWorker: ${rec.workerId}\nBranch: ${rec.brief.branch}`;
}

function freshRetryBrief(brief: FleetBrief, nextSeq: number): FleetBrief {
  const suffix = `retry-${Math.max(1, nextSeq)}`;
  return {
    ...brief,
    branch: appendRetrySuffix(brief.branch, suffix),
    worktree: appendRetrySuffix(brief.worktree, suffix),
  };
}

function appendRetrySuffix(value: string, suffix: string): string {
  if (!value) return suffix;
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (index < 0) return `${value}-${suffix}`;
  const prefix = value.slice(0, index + 1);
  const base = value.slice(index + 1) || "worker";
  return `${prefix}${base}-${suffix}`;
}

function statusAfterEvent(current: string, event: FleetWorkerEvent): FleetWorkerStatus | string {
  if (event.type === "worker.started") return "running";
  if (event.type === "worker.progress") {
    const data = event.data as { kind?: unknown; action?: unknown } | undefined;
    if (data?.kind === "review" && data.action === "approved") return "completed";
    if (data?.kind === "review" && data.action === "integrated") return "completed";
    if (data?.kind === "review" && data.action === "discarded") return "cancelled";
  }
  if (event.type === "worker.violation" && (event.code === "forbidden_file" || event.code === "center_lock")) return "blocked";
  if (event.type === "gate.finished" && !event.ok) return "failed";
  if (event.type === "worker.finished") return event.ok ? (current === "blocked" ? "blocked" : "waiting_approval") : "failed";
  if (event.type === "worker.error") return event.code === "cancelled" ? "cancelled" : "failed";
  return current;
}

function latestCheckpointPath(events: FleetWorkerEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "worker.progress") continue;
    if (event.message !== "session saved" && !event.message.startsWith("checkpoint:")) continue;
    const data = event.data as { path?: unknown } | undefined;
    if (typeof data?.path === "string" && data.path) return data.path;
  }
  return undefined;
}

export interface FleetGateResult {
  passed: boolean;
  reasons: string[];
  testsFailed: number;
  gatesFailed: number;
  violations: number;
  ran: boolean;
}

/** Derive the merge gate from a worker's events: tests + gates + scope violations. */
export function evaluateGate(events: FleetWorkerEvent[]): FleetGateResult {
  let testsFailed = 0;
  let gatesFailed = 0;
  let gatesRan = 0;
  let violations = 0;
  for (const event of events) {
    if (event.type === "test.finished" && !event.ok) testsFailed += 1;
    if (event.type === "gate.finished") {
      gatesRan += 1;
      if (!event.ok) gatesFailed += 1;
    }
    if (event.type === "worker.violation" && (event.code === "forbidden_file" || event.code === "center_lock")) {
      violations += 1;
    }
  }
  const reasons: string[] = [];
  if (violations) reasons.push(`${violations} forbidden / center-lock violation(s)`);
  if (testsFailed) reasons.push(`${testsFailed} test(s) failed`);
  if (gatesFailed) reasons.push(`${gatesFailed} gate(s) failed`);
  return { passed: reasons.length === 0, reasons, testsFailed, gatesFailed, violations, ran: gatesRan > 0 };
}

function latestApprovedCommit(events: FleetWorkerEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "worker.progress") continue;
    const data = event.data as { kind?: unknown; action?: unknown; commit?: unknown } | undefined;
    if (data?.kind === "review" && data.action === "approved" && typeof data.commit === "string" && data.commit) {
      return data.commit;
    }
  }
  return undefined;
}
