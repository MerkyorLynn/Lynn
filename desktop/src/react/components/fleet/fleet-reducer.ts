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
  FleetVisualBox,
  FleetVisualResultFile,
} from '../../../../../shared/fleet-events.js';

/** Structured payload the server attaches to worker.progress.data (B1 vision / B3 runner). */
interface FleetProgressData {
  kind?: 'vision' | 'runner' | 'review' | 'plan';
  taskType?: 'code' | 'see' | 'ground' | 'ui2code';
  image?: string;
  mode?: 'stub' | 'spawned';
  source?: 'bundled' | 'electron' | 'dev';
  pid?: number;
  action?: 'approved' | 'discarded' | 'integrated';
  commit?: string;
  sourceCommit?: string;
  branch?: string;
  changed?: boolean;
  path?: string;
  line?: string;
  items?: unknown;
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

export interface FleetToolRun {
  name: string;
  argsPreview?: string;
  running: boolean;
  ok?: boolean;
  ms?: number;
}

export interface FleetUsageView {
  summary: string;
  total?: number;
  prompt?: number;
  completion?: number;
  cacheHit?: number;
  cacheMiss?: number;
  cacheRatio?: number;
  durationMs?: number;
  tps?: number;
}

export interface FleetCheckpointView {
  path?: string;
  line?: string;
}

export type FleetPlanStatus = 'pending' | 'in_progress' | 'completed';

export interface FleetPlanItemView {
  content: string;
  status: FleetPlanStatus;
  id?: string;
}

export interface FleetVisualResultView {
  taskType: 'see' | 'ground' | 'ui2code';
  image?: string;
  summary: string;
  boxes?: FleetVisualBox[];
  files?: FleetVisualResultFile[];
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
  tools: FleetToolRun[];
  usage?: FleetUsageView;
  checkpoint?: FleetCheckpointView;
  planItems: FleetPlanItemView[];
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
  visualResult?: FleetVisualResultView;
  /** How the worker was launched (from a worker.progress data:{kind:'runner'} event). */
  runner?: { mode: 'stub' | 'spawned'; source?: 'bundled' | 'electron' | 'dev'; pid?: number };
  /** Review action result surfaced by Fleet approval/discard endpoints. */
  review?: { action: 'approved' | 'discarded' | 'integrated'; commit?: string; sourceCommit?: string; branch?: string; changed?: boolean };
  lastTs?: string;
}

export interface FleetGateView {
  passed: boolean;
  reasons: string[];
}

/** Mirror the server-side merge gate from the worker events the GUI already tracks. */
export function deriveGate(worker: FleetWorkerView): FleetGateView {
  const reasons: string[] = [];
  if (worker.hasForbiddenEdit) reasons.push('out-of-scope edits');
  const failedTests = worker.tests.filter((t) => t.ok === false).length;
  if (failedTests) reasons.push(`${failedTests} test${failedTests === 1 ? '' : 's'} failed`);
  if (worker.gate?.ok === false) reasons.push('gate failed');
  return { passed: reasons.length === 0, reasons };
}

export interface FleetWorkerRecordSnapshot {
  workerId: string;
  agent?: string;
  status?: string;
  events?: FleetWorkerEvent[];
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
    tools: [],
    planItems: [],
    tests: [],
    gate: null,
    violations: [],
    hasForbiddenEdit: false,
    error: null,
    finished: null,
  };
}

const FLEET_STATUSES = new Set<FleetWorkerStatus>([
  'queued',
  'running',
  'waiting_approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

function normalizeFleetStatus(status: string | undefined): FleetWorkerStatus | undefined {
  return status && FLEET_STATUSES.has(status as FleetWorkerStatus) ? (status as FleetWorkerStatus) : undefined;
}

function upsertChangedFile(list: FleetChangedFile[], file: FleetChangedFile): FleetChangedFile[] {
  const idx = list.findIndex((f) => f.path === file.path);
  if (idx === -1) return [...list, { ...file }];
  const copy = list.slice();
  copy[idx] = { ...copy[idx], ...file };
  return copy;
}

function finishToolRun(list: FleetToolRun[], name: string, ok: boolean, ms?: number): FleetToolRun[] {
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].running && list[i].name === name) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return [...list, { name, running: false, ok, ms }];
  const copy = list.slice();
  copy[idx] = { ...copy[idx], running: false, ok, ms };
  return copy;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumber(record: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = path.split('.').reduce<unknown>((acc, part) => {
      if (!acc || typeof acc !== 'object' || Array.isArray(acc)) return undefined;
      return (acc as Record<string, unknown>)[part];
    }, record);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function summarizeFleetUsage(data: unknown): FleetUsageView | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const prompt = firstNumber(record, ['prompt_tokens', 'input_tokens']);
  const completion = firstNumber(record, ['completion_tokens', 'output_tokens']);
  const total = firstNumber(record, ['total_tokens']) ?? (prompt != null && completion != null ? prompt + completion : undefined);
  const cacheHit = firstNumber(record, [
    'prompt_cache_hit_tokens',
    'cached_tokens',
    'cache_read_input_tokens',
    'prompt_tokens_details.cached_tokens',
  ]);
  const cacheMiss = firstNumber(record, ['prompt_cache_miss_tokens', 'cache_creation_input_tokens']);
  const durationMs = numberValue(record, 'duration_ms') ?? numberValue(record, 'durationMs');
  const explicitTps = numberValue(record, 'tokens_per_second') ?? numberValue(record, 'tps');
  const tps = explicitTps != null
    ? explicitTps
    : completion != null && durationMs != null && durationMs > 0
      ? completion / (durationMs / 1000)
      : undefined;
  const cacheBase = prompt && prompt > 0 ? prompt : cacheHit != null && cacheMiss != null ? cacheHit + cacheMiss : undefined;
  const cacheRatio = cacheHit != null && cacheBase && cacheBase > 0 ? Math.round((cacheHit / cacheBase) * 100) : undefined;
  const parts = [
    total != null ? `${total} tok` : undefined,
    prompt != null ? `in ${prompt}` : undefined,
    completion != null ? `out ${completion}` : undefined,
    cacheHit != null ? `cache ${cacheHit}${cacheRatio != null ? ` (${cacheRatio}%)` : ''}` : undefined,
    tps != null && Number.isFinite(tps) ? `${formatFleetTps(tps)} TPS` : undefined,
  ].filter((part): part is string => !!part);
  if (!parts.length) return undefined;
  return { summary: parts.join(' · '), total, prompt, completion, cacheHit, cacheMiss, cacheRatio, durationMs, tps };
}

function formatFleetTps(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
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
        } else if (data.kind === 'review') {
          if (data.action === 'approved' || data.action === 'discarded' || data.action === 'integrated') {
            next.review = { action: data.action, commit: data.commit, sourceCommit: data.sourceCommit, branch: data.branch, changed: data.changed };
          }
          if (data.action === 'approved') next.status = 'completed';
          if (data.action === 'integrated') next.status = 'completed';
          if (data.action === 'discarded') next.status = 'cancelled';
        } else if (data.kind === 'plan') {
          next.planItems = normalizeFleetPlanItems(data.items);
        }
        if ((ev.message.startsWith('checkpoint:') || ev.message === 'session saved') && (data.path || data.line)) {
          next.checkpoint = { path: data.path, line: data.line };
        }
      }
      if (ev.message === 'usage') {
        next.usage = summarizeFleetUsage(ev.data) ?? prev.usage;
      }
      return next;
    }
    case 'worker.visual_result':
      next.taskType = ev.taskType;
      if (ev.image) next.image = ev.image;
      next.visualResult = {
        taskType: ev.taskType,
        image: ev.image,
        summary: ev.summary,
        boxes: ev.boxes,
        files: ev.files,
      };
      return next;
    case 'assistant.delta':
      next.assistant = prev.assistant + ev.text;
      return next;
    case 'reasoning.delta':
      next.reasoningChunks = prev.reasoningChunks + 1;
      return next;
    case 'tool.started':
      next.tools = [...prev.tools, { name: ev.name, argsPreview: ev.argsPreview, running: true }];
      next.log = [...prev.log, `tool ${ev.name}${ev.argsPreview ? ` ${ev.argsPreview}` : ''}`];
      return next;
    case 'tool.finished':
      next.tools = finishToolRun(prev.tools, ev.name, ev.ok, ev.ms);
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
      if (!ev.ok) next.status = 'failed';
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
      else next.status = 'failed';
      return next;
    default: {
      const _exhaustive: never = ev;
      return _exhaustive ? prev : prev;
    }
  }
}

export function normalizeFleetPlanItems(value: unknown): FleetPlanItemView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => normalizeFleetPlanItem(item, index))
    .filter((item): item is FleetPlanItemView => !!item);
}

function normalizeFleetPlanItem(value: unknown, index: number): FleetPlanItemView | null {
  if (typeof value === 'string') {
    const content = value.trim();
    return content ? { content, status: 'pending', id: `P${index + 1}` } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const content = firstString(record.content, record.text, record.title, record.task, record.step)?.trim();
  if (!content) return null;
  return {
    content,
    status: normalizeFleetPlanStatus(firstString(record.status, record.state)),
    id: firstString(record.id, record.key, record.name) || `P${index + 1}`,
  };
}

function normalizeFleetPlanStatus(value: string | undefined): FleetPlanStatus {
  const key = (value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'in_progress' || key === 'doing' || key === 'active' || key === 'current' || key === 'running') return 'in_progress';
  if (key === 'completed' || key === 'complete' || key === 'done' || key === 'finished' || key === 'success') return 'completed';
  return 'pending';
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find((entry) => typeof entry === 'string' && entry.trim());
  return typeof value === 'string' ? value : undefined;
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

/** Rebuild the board from the server's FleetHub snapshots after a GUI reload/open. */
export function hydrateFleetWorkers(records: FleetWorkerRecordSnapshot[]): FleetWorkerView[] {
  let list: FleetWorkerView[] = [];
  for (const rec of records) {
    const before = list.length;
    for (const ev of rec.events ?? []) list = applyFleetEventToList(list, ev);
    if (list.length === before) list = [...list, createWorkerView(rec.workerId, rec.agent)];
    const idx = list.findIndex((w) => w.workerId === rec.workerId);
    const status = normalizeFleetStatus(rec.status);
    if (idx >= 0 && status) {
      const copy = list.slice();
      copy[idx] = { ...copy[idx], status };
      list = copy;
    }
  }
  return list;
}
