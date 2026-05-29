/**
 * fleet-reducer.ts — pure fold of the worker JSONL event stream into a per-worker
 * view model. No zustand, no React: testable in isolation and reused by both the
 * mock playback (B-line) and the live WS path (later).
 *
 * Contract: shared/fleet-events.ts (owned by the CLI Core lane; read-only here).
 */
import type {
  FleetWorkerEvent,
  FleetWorkerStatus,
  FleetChangedFile,
  FleetApprovalMode,
  FleetSandboxMode,
  FleetSeverity,
} from '../../../../../shared/fleet-events.js';

/** Structured payload the server attaches to worker.progress.data (B1 vision / B3 runner). */
interface FleetProgressData {
  kind?: 'vision' | 'runner';
  taskType?: 'code' | 'see' | 'ground' | 'ui2code';
  image?: string;
  mode?: 'stub' | 'spawned';
  source?: 'bundled' | 'electron' | 'dev';
  pid?: number;
}

export interface FleetTestResult {
  command: string;
  running: boolean;
  ok?: boolean;
  ms?: number;
  summary?: string;
}

export interface FleetViolation {
  code: string;
  message: string;
  path?: string;
  severity?: FleetSeverity;
}

/** Accumulated, render-ready state for a single worker. */
export interface FleetWorkerView {
  workerId: string;
  agent?: string;
  status: FleetWorkerStatus;
  branch?: string;
  worktree?: string;
  cwd?: string;
  pid?: number;
  approval?: FleetApprovalMode;
  sandbox?: FleetSandboxMode;
  owned: string[];
  forbidden: string[];
  centerLocks: string[];
  log: string[];
  assistant: string;
  reasoningChunks: number;
  changedFiles: FleetChangedFile[];
  diffStat: { files: number; insertions: number; deletions: number } | null;
  /** Path currently being written (last file.changed while running); cleared on git.diff/finish. */
  activeFile?: string;
  tests: FleetTestResult[];
  gate: { ok: boolean; summary: string } | null;
  violations: FleetViolation[];
  /** True once any forbidden-file or center-lock breach is seen (drives the merge block + red flag). */
  hasForbiddenEdit: boolean;
  error: { code: string; message: string; recoverable: boolean } | null;
  finished: { ok: boolean; exitCode: number; summary: string; commit?: string } | null;
  /** Vision dispatch context (from a worker.progress data:{kind:'vision'} event). */
  taskType?: 'code' | 'see' | 'ground' | 'ui2code';
  image?: string;
  /** How the worker was launched (from a worker.progress data:{kind:'runner'} event). */
  runner?: { mode: 'stub' | 'spawned'; source?: 'bundled' | 'electron' | 'dev'; pid?: number };
  lastTs?: string;
}

export function createWorkerView(workerId: string, agent?: string): FleetWorkerView {
  return {
    workerId,
    agent,
    status: 'queued',
    owned: [],
    forbidden: [],
    centerLocks: [],
    log: [],
    assistant: '',
    reasoningChunks: 0,
    changedFiles: [],
    diffStat: null,
    tests: [],
    gate: null,
    violations: [],
    hasForbiddenEdit: false,
    error: null,
    finished: null,
  };
}

function upsertChangedFile(list: FleetChangedFile[], file: FleetChangedFile): FleetChangedFile[] {
  const idx = list.findIndex((f) => f.path === file.path);
  if (idx === -1) return [...list, { ...file }];
  const copy = list.slice();
  copy[idx] = { ...copy[idx], ...file };
  return copy;
}

/** Fold one event into a worker view, returning a new view (immutable). */
export function reduceFleetWorker(prev: FleetWorkerView, ev: FleetWorkerEvent): FleetWorkerView {
  const next: FleetWorkerView = { ...prev, lastTs: ev.ts ?? prev.lastTs };
  if (ev.agent) next.agent = ev.agent;
  switch (ev.type) {
    case 'worker.started':
      next.status = 'running';
      next.cwd = ev.cwd;
      next.worktree = ev.worktree;
      next.branch = ev.branch;
      next.pid = ev.pid;
      next.approval = ev.approval;
      next.sandbox = ev.sandbox;
      return next;
    case 'worker.claims':
      next.owned = ev.owned;
      next.forbidden = ev.forbidden;
      next.centerLocks = ev.centerLocks ?? [];
      return next;
    case 'worker.progress': {
      next.log = [...prev.log, ev.message];
      const data = ev.data as FleetProgressData | undefined;
      if (data && typeof data === 'object') {
        if (data.kind === 'vision') {
          if (data.taskType) next.taskType = data.taskType;
          if (data.image) next.image = data.image;
        } else if (data.kind === 'runner') {
          next.runner = { mode: data.mode ?? 'spawned', source: data.source, pid: data.pid };
        }
      }
      return next;
    }
    case 'assistant.delta':
      next.assistant = prev.assistant + ev.text;
      return next;
    case 'reasoning.delta':
      next.reasoningChunks = prev.reasoningChunks + 1;
      return next;
    case 'tool.started':
      next.log = [...prev.log, `tool ${ev.name}${ev.argsPreview ? ` ${ev.argsPreview}` : ''}`];
      return next;
    case 'tool.finished':
      next.log = [...prev.log, `tool ${ev.name} ${ev.ok ? 'ok' : 'fail'}${ev.ms != null ? ` ${ev.ms}ms` : ''}`];
      return next;
    case 'shell.started':
      next.log = [...prev.log, `$ ${ev.command} (${ev.approval})`];
      return next;
    case 'shell.output':
      next.log = [...prev.log, ev.text.replace(/\n+$/, '')];
      return next;
    case 'shell.finished':
      next.log = [...prev.log, `exit ${ev.exitCode}${ev.ms != null ? ` ${ev.ms}ms` : ''}`];
      return next;
    case 'file.changed':
      next.changedFiles = upsertChangedFile(prev.changedFiles, { path: ev.path, action: ev.action });
      next.activeFile = ev.path;
      return next;
    case 'git.diff': {
      next.diffStat = { files: ev.files, insertions: ev.insertions, deletions: ev.deletions };
      if (ev.changedFiles?.length) {
        let merged = prev.changedFiles;
        for (const f of ev.changedFiles) merged = upsertChangedFile(merged, f);
        next.changedFiles = merged;
      }
      next.hasForbiddenEdit = prev.hasForbiddenEdit || next.changedFiles.some((f) => f.forbidden === true);
      next.activeFile = undefined;
      return next;
    }
    case 'test.started':
      next.tests = [...prev.tests, { command: ev.command, running: true }];
      return next;
    case 'test.finished': {
      let patched = false;
      next.tests = prev.tests.map((t) => {
        if (!patched && t.running && t.command === ev.command) {
          patched = true;
          return { command: ev.command, running: false, ok: ev.ok, ms: ev.ms, summary: ev.summary };
        }
        return t;
      });
      if (!patched) {
        next.tests = [...next.tests, { command: ev.command, running: false, ok: ev.ok, ms: ev.ms, summary: ev.summary }];
      }
      return next;
    }
    case 'gate.finished':
      next.gate = { ok: ev.ok, summary: ev.summary };
      return next;
    case 'worker.violation':
      next.violations = [...prev.violations, { code: ev.code, message: ev.message, path: ev.path, severity: ev.severity }];
      if (ev.code === 'forbidden_file' || ev.code === 'center_lock') {
        next.hasForbiddenEdit = true;
        next.status = 'blocked';
      }
      return next;
    case 'worker.finished':
      next.finished = { ok: ev.ok, exitCode: ev.exitCode, summary: ev.summary, commit: ev.commit };
      // done means "ready for review" -> waiting_approval, unless a breach already blocked it.
      next.status = ev.ok ? (prev.status === 'blocked' ? 'blocked' : 'waiting_approval') : 'failed';
      next.activeFile = undefined;
      return next;
    case 'worker.error':
      next.error = { code: ev.code, message: ev.message, recoverable: ev.recoverable };
      next.log = [...prev.log, `error ${ev.code}: ${ev.message}`];
      if (ev.code === 'cancelled') next.status = 'cancelled';
      else if (!ev.recoverable) next.status = 'failed';
      return next;
    default: {
      const _exhaustive: never = ev;
      return _exhaustive ? prev : prev;
    }
  }
}

/** Attribute an event to its worker (creating the view on first sight) and fold it in. */
export function applyFleetEventToList(list: FleetWorkerView[], ev: FleetWorkerEvent): FleetWorkerView[] {
  const id = ev.workerId;
  if (!id) return list; // events without a workerId cannot be attributed in MVP
  const idx = list.findIndex((w) => w.workerId === id);
  if (idx === -1) {
    return [...list, reduceFleetWorker(createWorkerView(id, ev.agent), ev)];
  }
  const copy = list.slice();
  copy[idx] = reduceFleetWorker(list[idx], ev);
  return copy;
}
