type RequiredFieldMap<T extends string> = Readonly<Record<T, readonly string[]>>;

export const FLEET_EVENT_SCHEMA_VERSION = 1;

export const FLEET_WORKER_EVENT_TYPES = Object.freeze([
  "worker.started",
  "worker.claims",
  "worker.progress",
  "worker.visual_result",
  "assistant.delta",
  "reasoning.delta",
  "tool.started",
  "tool.finished",
  "shell.started",
  "shell.output",
  "shell.finished",
  "file.changed",
  "git.diff",
  "test.started",
  "test.finished",
  "gate.finished",
  "worker.violation",
  "worker.finished",
  "worker.error",
] as const);

export type FleetWorkerEventType = (typeof FLEET_WORKER_EVENT_TYPES)[number];

export type FleetWorkerStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type FleetAgentKind =
  | "lynn-cli"
  | "stepfun-flash"
  | "codex-cli"
  | "claude-internal"
  | "claude-code"
  | "qwen-cli"
  | "kimi-cli"
  | "opencode"
  | "codebuddy"
  | "custom";

export type FleetApprovalMode = "ask" | "on-failure" | "never" | "yolo";

export type FleetSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type FleetSeverity = "info" | "warning" | "error";

export interface FleetEventBase<TType extends FleetWorkerEventType = FleetWorkerEventType> {
  schemaVersion?: typeof FLEET_EVENT_SCHEMA_VERSION;
  type: TType;
  ts?: string;
  taskId?: string;
  workerId?: string;
  agent?: FleetAgentKind | string;
}

export interface FleetChangedFile {
  path: string;
  action?: "add" | "edit" | "delete" | "rename";
  insertions?: number;
  deletions?: number;
  forbidden?: boolean;
  centerLocked?: boolean;
}

export interface FleetWorkerStartedEvent extends FleetEventBase<"worker.started"> {
  workerId: string;
  cwd: string;
  worktree: string;
  branch: string;
  pid?: number;
  command?: string[];
  approval?: FleetApprovalMode;
  sandbox?: FleetSandboxMode;
}

export interface FleetWorkerClaimsEvent extends FleetEventBase<"worker.claims"> {
  owned: string[];
  forbidden: string[];
  centerLocks?: string[];
}

export interface FleetWorkerProgressEvent extends FleetEventBase<"worker.progress"> {
  message: string;
  level?: FleetSeverity;
  data?: unknown;
}

export type FleetVisualTaskType = "see" | "ground" | "ui2code";

export interface FleetVisualBox {
  label?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  confidence?: number;
}

export interface FleetVisualResultFile {
  path: string;
  kind: "created" | "modified" | "suggested";
}

export interface FleetWorkerVisualResultEvent extends FleetEventBase<"worker.visual_result"> {
  taskType: FleetVisualTaskType;
  summary: string;
  image?: string;
  boxes?: FleetVisualBox[];
  files?: FleetVisualResultFile[];
}

export interface FleetAssistantDeltaEvent extends FleetEventBase<"assistant.delta"> {
  text: string;
}

export interface FleetReasoningDeltaEvent extends FleetEventBase<"reasoning.delta"> {
  text: string;
  hidden?: boolean;
}

export interface FleetToolStartedEvent extends FleetEventBase<"tool.started"> {
  name: string;
  argsPreview?: string;
}

export interface FleetToolFinishedEvent extends FleetEventBase<"tool.finished"> {
  name: string;
  ok: boolean;
  ms?: number;
}

export interface FleetShellStartedEvent extends FleetEventBase<"shell.started"> {
  command: string;
  approval: "asked" | "auto";
}

export interface FleetShellOutputEvent extends FleetEventBase<"shell.output"> {
  stream: "stdout" | "stderr";
  text: string;
}

export interface FleetShellFinishedEvent extends FleetEventBase<"shell.finished"> {
  command?: string;
  exitCode: number;
  ok: boolean;
  ms?: number;
}

export interface FleetFileChangedEvent extends FleetEventBase<"file.changed"> {
  path: string;
  action: "add" | "edit" | "delete" | "rename";
}

export interface FleetGitDiffEvent extends FleetEventBase<"git.diff"> {
  files: number;
  insertions: number;
  deletions: number;
  changedFiles?: FleetChangedFile[];
}

export interface FleetTestStartedEvent extends FleetEventBase<"test.started"> {
  command: string;
}

export interface FleetTestFinishedEvent extends FleetEventBase<"test.finished"> {
  command: string;
  ok: boolean;
  ms?: number;
  summary?: string;
  data?: { output?: string; truncated?: boolean };
}

export interface FleetGateFinishedEvent extends FleetEventBase<"gate.finished"> {
  ok: boolean;
  summary: string;
}

export interface FleetWorkerViolationEvent extends FleetEventBase<"worker.violation"> {
  code: "forbidden_file" | "center_lock" | "download_attempt" | "secret_leak" | string;
  message: string;
  path?: string;
  severity?: FleetSeverity;
}

export interface FleetWorkerFinishedEvent extends FleetEventBase<"worker.finished"> {
  ok: boolean;
  exitCode: number;
  summary: string;
  commit?: string;
}

export interface FleetWorkerErrorEvent extends FleetEventBase<"worker.error"> {
  code: string;
  message: string;
  recoverable: boolean;
}

export type FleetWorkerEvent =
  | FleetWorkerStartedEvent
  | FleetWorkerClaimsEvent
  | FleetWorkerProgressEvent
  | FleetWorkerVisualResultEvent
  | FleetAssistantDeltaEvent
  | FleetReasoningDeltaEvent
  | FleetToolStartedEvent
  | FleetToolFinishedEvent
  | FleetShellStartedEvent
  | FleetShellOutputEvent
  | FleetShellFinishedEvent
  | FleetFileChangedEvent
  | FleetGitDiffEvent
  | FleetTestStartedEvent
  | FleetTestFinishedEvent
  | FleetGateFinishedEvent
  | FleetWorkerViolationEvent
  | FleetWorkerFinishedEvent
  | FleetWorkerErrorEvent;

export interface FleetValidationResult {
  ok: boolean;
  errors: string[];
}

export interface FleetJsonLineParseResult {
  ok: boolean;
  event?: FleetWorkerEvent;
  raw?: string;
  errors: string[];
}

export const FLEET_EVENT_REQUIRED_FIELDS = Object.freeze({
  "worker.started": ["workerId", "cwd", "worktree", "branch"],
  "worker.claims": ["owned", "forbidden"],
  "worker.progress": ["message"],
  "worker.visual_result": ["taskType", "summary"],
  "assistant.delta": ["text"],
  "reasoning.delta": ["text"],
  "tool.started": ["name"],
  "tool.finished": ["name", "ok"],
  "shell.started": ["command", "approval"],
  "shell.output": ["stream", "text"],
  "shell.finished": ["exitCode", "ok"],
  "file.changed": ["path", "action"],
  "git.diff": ["files", "insertions", "deletions"],
  "test.started": ["command"],
  "test.finished": ["command", "ok"],
  "gate.finished": ["ok", "summary"],
  "worker.violation": ["code", "message"],
  "worker.finished": ["ok", "exitCode", "summary"],
  "worker.error": ["code", "message", "recoverable"],
} as const satisfies RequiredFieldMap<FleetWorkerEventType>);

const fleetTypeSet: ReadonlySet<string> = new Set(FLEET_WORKER_EVENT_TYPES);

export function isFleetWorkerEventType(type: unknown): type is FleetWorkerEventType {
  return typeof type === "string" && fleetTypeSet.has(type);
}

export function validateFleetWorkerEvent(event: unknown): FleetValidationResult {
  if (!event || typeof event !== "object") {
    return { ok: false, errors: ["fleet event must be an object"] };
  }
  const candidate = event as Record<string, unknown>;
  if (!isFleetWorkerEventType(candidate.type)) {
    return { ok: false, errors: [`unknown fleet event type: ${String(candidate.type || "")}`] };
  }
  const missing = FLEET_EVENT_REQUIRED_FIELDS[candidate.type].filter((field) => candidate[field] === undefined);
  if (missing.length) {
    return { ok: false, errors: [`fleet event ${candidate.type} missing required field(s): ${missing.join(", ")}`] };
  }
  return { ok: true, errors: [] };
}

export function parseFleetJsonLine(line: string): FleetJsonLineParseResult {
  const raw = String(line || "");
  if (!raw.trim()) {
    return { ok: false, raw, errors: ["fleet JSONL line is empty"] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const validation = validateFleetWorkerEvent(parsed);
    if (!validation.ok) return { ok: false, raw, errors: validation.errors };
    return { ok: true, event: parsed as FleetWorkerEvent, raw, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, raw, errors: [`invalid fleet JSONL: ${message}`] };
  }
}

export function makeFleetProgressEvent(message: string, fields: Partial<FleetWorkerProgressEvent> = {}): FleetWorkerProgressEvent {
  return {
    ...fields,
    type: "worker.progress",
    message,
  };
}
