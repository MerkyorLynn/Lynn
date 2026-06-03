export interface ExternalMcpArmConfig {
  id: string;
  command: string;
  args: string[];
  capability: "gui" | "browser" | "device" | "custom";
  description?: string;
}

export interface ExternalMcpArmValidation {
  ok: boolean;
  errors: string[];
  arm: ExternalMcpArmConfig | null;
}

export type ExternalArmBrokerAction = "start" | "step" | "status" | "cancel" | "artifacts";
export type ExternalArmRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ExternalArmBrokerContract {
  type: "external_arm.broker_contract";
  protocol: "lynn.external_arm.broker.v1";
  armId: string;
  capability: ExternalMcpArmConfig["capability"];
  actions: ExternalArmBrokerAction[];
  requestType: "external_arm.request";
  responseType: "external_arm.response";
  tokenPolicy: string;
  rules: string[];
  exampleRequest: ExternalArmBrokerRequest;
}

export interface ExternalArmBrokerRequestInput {
  action: ExternalArmBrokerAction | string;
  taskId?: string;
  goal?: string;
  observation?: string;
  constraints?: string[];
  maxArtifacts?: number;
  timeoutMs?: number;
}

export interface ExternalArmBrokerRequest {
  type: "external_arm.request";
  protocol: "lynn.external_arm.broker.v1";
  armId: string;
  capability: ExternalMcpArmConfig["capability"];
  action: ExternalArmBrokerAction;
  taskId?: string;
  goal?: string;
  observation?: string;
  constraints?: string[];
  maxArtifacts?: number;
  timeoutMs?: number;
}

export interface ExternalArmBrokerRequestValidation {
  ok: boolean;
  errors: string[];
  request: ExternalArmBrokerRequest | null;
}

export interface ExternalArmArtifact {
  id: string;
  kind: "screenshot" | "trace" | "log" | "file" | "replay" | "custom";
  path?: string;
  url?: string;
  title?: string;
  summary?: string;
}

export interface ExternalArmBrokerResponse {
  type: "external_arm.response";
  protocol: "lynn.external_arm.broker.v1";
  armId: string;
  action: ExternalArmBrokerAction;
  taskId?: string;
  ok: boolean;
  status?: ExternalArmRunStatus;
  summary?: string;
  actions?: string[];
  artifacts?: ExternalArmArtifact[];
  error?: string;
}

export function validateExternalMcpArmConfig(value: unknown): ExternalMcpArmValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["config must be an object"], arm: null };
  }
  const record = value as Record<string, unknown>;
  const id = stringField(record.id);
  const command = stringField(record.command);
  const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
  const capability = normalizeCapability(record.capability) || normalizeCapability(Array.isArray(record.capabilities) ? record.capabilities[0] : null);
  const description = stringField(record.description);

  if (!id) errors.push("id is required");
  if (!command) errors.push("command is required");
  if (Array.isArray(record.args) && args.length !== record.args.length) errors.push("args must contain only strings");
  if (!capability) errors.push("capability must be gui, browser, device, or custom");
  if (command && /[;&|`$<>]/.test(command)) errors.push("command must be a binary name/path, not a shell string");

  return {
    ok: errors.length === 0,
    errors,
    arm: errors.length ? null : {
      id,
      command,
      args,
      capability: capability || "custom",
      ...(description ? { description } : {}),
    },
  };
}

export function gelabZeroMcpArmExample(): ExternalMcpArmConfig {
  return {
    id: "gelab-zero",
    command: "python",
    args: ["mcp_server/detailed_gelab_mcp_server.py"],
    capability: "device",
    description: "StepFun GELab GUI/phone grounding arm exposed through MCP. Lynn treats it as an external arm; do not merge its Python code into the CLI.",
  };
}

export function renderExternalMcpArmContract(arm = gelabZeroMcpArmExample()): string {
  const broker = buildExternalArmBrokerContract(arm);
  return [
    "External MCP arm contract:",
    `- id: ${arm.id}`,
    `- command: ${arm.command} ${arm.args.join(" ")}`.trimEnd(),
    `- capability: ${arm.capability}`,
    "- role: external specialist arm. Lynn/StepFun does planning; the MCP arm performs domain-specific actions.",
    "- boundary: do not merge external Python/ADB/device code into Lynn CLI; call it through MCP only.",
    `- broker: expose only ${broker.requestType} actions (${broker.actions.join(", ")}); do not expose the full MCP schema to the model.`,
    "- gate: Fleet still trusts Lynn-side JSONL, ownership checks, tests, and merge gates, not the external arm's self-report.",
  ].join("\n");
}

export function buildExternalArmBrokerContract(arm = gelabZeroMcpArmExample()): ExternalArmBrokerContract {
  return {
    type: "external_arm.broker_contract",
    protocol: "lynn.external_arm.broker.v1",
    armId: arm.id,
    capability: arm.capability,
    actions: ["start", "step", "status", "cancel", "artifacts"],
    requestType: "external_arm.request",
    responseType: "external_arm.response",
    tokenPolicy: "Expose one compact broker request/response envelope. Do not expose full MCP tool schemas or raw GUI traces to the model.",
    rules: [
      "Lynn/StepFun plans; the external arm performs domain-specific GUI/device/browser actions.",
      "Store screenshots, traces, and logs as artifacts; summarize them instead of streaming full content into context.",
      "If the arm fails, report the failure and artifact handles; do not invent fallback actions.",
      "Fleet still gates ownership, tests, diffs, and merges on the Lynn side.",
    ],
    exampleRequest: {
      type: "external_arm.request",
      protocol: "lynn.external_arm.broker.v1",
      armId: arm.id,
      capability: arm.capability,
      action: "start",
      goal: "Open the target app, inspect the screen, and report the next actionable GUI step.",
      constraints: ["return concise observations", "store screenshots as artifacts"],
      maxArtifacts: 3,
    },
  };
}

export function buildExternalArmBrokerRequest(arm: ExternalMcpArmConfig, input: ExternalArmBrokerRequestInput): ExternalArmBrokerRequestValidation {
  const errors: string[] = [];
  const action = normalizeBrokerAction(input.action);
  const taskId = stringField(input.taskId);
  const goal = boundedText(input.goal, 4000);
  const observation = boundedText(input.observation, 4000);
  const constraints = normalizeConstraints(input.constraints);
  const maxArtifacts = boundedInt(input.maxArtifacts, 1, 10);
  const timeoutMs = boundedInt(input.timeoutMs, 1000, 600_000);

  if (!action) errors.push("action must be start, step, status, cancel, or artifacts");
  if (action === "start" && !goal) errors.push("start requires goal");
  if ((action === "step" || action === "status" || action === "cancel" || action === "artifacts") && !taskId) errors.push(`${action} requires taskId`);
  if (action === "step" && !goal && !observation) errors.push("step requires goal or observation");

  if (errors.length || !action) return { ok: false, errors, request: null };
  const request: ExternalArmBrokerRequest = {
    type: "external_arm.request",
    protocol: "lynn.external_arm.broker.v1",
    armId: arm.id,
    capability: arm.capability,
    action,
    ...(taskId ? { taskId } : {}),
    ...(goal ? { goal } : {}),
    ...(observation ? { observation } : {}),
    ...(constraints.length ? { constraints } : {}),
    ...(maxArtifacts ? { maxArtifacts } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  return { ok: true, errors: [], request };
}

export function summarizeExternalArmBrokerResponse(response: ExternalArmBrokerResponse, maxArtifacts = 3): string {
  const lines = [
    `external_arm ${response.armId} ${response.action}: ${response.ok ? "ok" : "failed"}${response.status ? ` (${response.status})` : ""}`,
  ];
  if (response.summary) lines.push(`summary: ${oneLine(response.summary, 360)}`);
  if (response.actions?.length) {
    for (const action of response.actions.slice(0, 5)) lines.push(`action: ${oneLine(action, 220)}`);
    if (response.actions.length > 5) lines.push(`actions: +${response.actions.length - 5} more`);
  }
  const artifacts = response.artifacts?.slice(0, Math.max(0, maxArtifacts)) || [];
  for (const artifact of artifacts) {
    const target = artifact.path || artifact.url || artifact.id;
    lines.push(`artifact: ${artifact.kind} ${target}${artifact.summary ? ` - ${oneLine(artifact.summary, 160)}` : ""}`);
  }
  if ((response.artifacts?.length || 0) > artifacts.length) lines.push(`artifacts: +${(response.artifacts?.length || 0) - artifacts.length} more`);
  if (response.error) lines.push(`error: ${oneLine(response.error, 300)}`);
  return lines.join("\n");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapability(value: unknown): ExternalMcpArmConfig["capability"] | null {
  if (value === "gui" || value === "browser" || value === "device" || value === "custom") return value;
  return null;
}

function normalizeBrokerAction(value: unknown): ExternalArmBrokerAction | null {
  if (value === "start" || value === "step" || value === "status" || value === "cancel" || value === "artifacts") return value;
  return null;
}

function normalizeConstraints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, 12)
    .map((item) => oneLine(item, 220));
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
