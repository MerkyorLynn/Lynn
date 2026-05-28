/**
 * @deprecated D1: This server-route Path B (Python bootstrap) is being phased out in favor of
 * the Electron-main Path A (LlamaCppManager in desktop/llamacpp-manager.cjs + desktop/model-downloader.cjs).
 *
 * Path A is canonical because:
 *  - No python3 dependency (clean Mac install works out of the box)
 *  - Same llama.cpp binary location across platforms (~/.lynn/llamacpp/bin/)
 *  - Single GGUF location (~/.lynn/models/) avoiding the Path-A vs Path-B model-dir confusion
 *  - LlamaCppManager owns port allocation and restart lifecycle
 *  - Onboarding step can call platform IPC instead of HTTP route
 *
 * This route remains for:
 *  - Backward compat (existing client builds still call /api/local-qwen35-9b/*)
 *  - python3 bootstrap path users who explicitly opted in via env LYNN_LOCAL_QWEN35_USE_BOOTSTRAP=1
 *
 * TODO sprint: migrate LocalModelDownloadStep.tsx to call platform.llamacppStartDownload()
 *              instead of this HTTP route, then mark file for removal.
 */
import { spawn, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { fromRoot } from "../../shared/hana-root.js";

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const MODEL_ID = "qwen35-9b-q4km-imatrix";
const MODEL_DISPLAY_NAME = "Qwen3.5-9B Q4_K_M imatrix MTP";
const MODEL_FILE_NAME = "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf";
const MODEL_ROOT_NAME = "Qwen3.5-9B";

type JsonRecord = Record<string, unknown>;

type LocalQwen35State = {
  modelRoot: string;
  providerConfig: string;
  pidFile: string;
  logFile: string;
  host: string;
  port: string;
};

type ProviderModelConfig = string | {
  id?: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  [key: string]: unknown;
};

type RawProviderConfig = {
  models?: ProviderModelConfig[];
  [key: string]: unknown;
};

type LocalQwen35ProviderRegistry = {
  saveProvider(providerId: string, config: RawProviderConfig): unknown;
  getAllProvidersRaw?(): Record<string, RawProviderConfig | undefined>;
};

type LocalQwen35RouteEngine = {
  providerRegistry: LocalQwen35ProviderRegistry;
  syncModelsAndRefresh?: () => Promise<unknown> | unknown;
  refreshAvailableModels?: () => Promise<unknown> | unknown;
  setPendingModel?: (modelId: string, providerId: string) => Promise<unknown> | unknown;
};

type FetchWithTimeoutOptions = RequestInit & {
  timeoutMs?: number;
};

type MetricSummary = {
  prompt_tokens_total: number | null;
  predicted_tokens_total: number | null;
  requests_total: number | null;
};

type SlotSummary = {
  id: unknown;
  state: unknown;
  prompt_tokens: unknown;
  predicted_tokens: unknown;
  progress: number | null;
};

type SlotsSummary = {
  total: number;
  busy: number;
  slots: SlotSummary[];
};

type RuntimeDetails = {
  base_url: string;
  gui_url: string;
  pid: number | null;
  pid_file: string;
  process_alive: boolean;
  endpoint_running_any: boolean;
  listen_pids: number[];
  command_pids: number[];
  pids: number[];
  endpoint_running: boolean;
  endpoint_loading: boolean;
  endpoint_occupied: boolean;
  serves_default_model: boolean;
  health_status: number;
  health: unknown;
  model_ids: string[];
  foreign_model_ids: string[];
  slots: SlotsSummary | null;
  metrics: MetricSummary | null;
  metrics_available: boolean;
  checked_at: string;
};

type RuntimeCache = {
  at: number;
  value: RuntimeDetails | null;
  inflight: Promise<RuntimeDetails> | null;
};

type Python3CheckResult =
  | { ok: true }
  | { ok: false; error: string; detail: string; raw: string };

type SetupBody = {
  authorized?: boolean;
  yesUserAuthorized?: boolean;
  variant?: string;
  start?: boolean;
  installRuntime?: boolean;
};

type SetupJobStatus = "running" | "succeeded" | "failed";

type SetupJob = {
  id: string;
  status: SetupJobStatus;
  started_at: string;
  finished_at: string | null;
  log_file: string;
  provider_id: string;
  model: string;
  exit_code: number | null;
  result: unknown;
  registered?: boolean;
  register_error?: string | null;
  stdout_tail?: string;
  stderr_tail?: string;
};

type RegisterProviderOptions = {
  activate?: boolean;
};

type JobProgress = {
  phase: string;
  source?: string | null;
  percent?: number | null;
  downloaded?: string;
  total?: string;
  elapsed?: string;
  eta?: string;
  speed?: string;
  tail?: string[];
  message: string;
};

type DecoratedSetupJob = SetupJob & {
  progress: JobProgress | null;
};

type DeriveProviderStateInput = {
  runtime?: Partial<RuntimeDetails> | null;
  status?: unknown;
  registered?: boolean;
  job?: { status?: SetupJobStatus } | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorOutput(err: unknown, key: "stdout" | "stderr"): string {
  if (!isRecord(err)) return "";
  const value = err[key];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function jsonRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function getNestedRecord(value: unknown, key: string): JsonRecord {
  return asRecord(asRecord(value)[key]);
}

function getPlanObserved(value: unknown): JsonRecord {
  const root = asRecord(value);
  const plan = asRecord(root.plan);
  return asRecord(plan.observed ?? root.observed);
}

function extractHealthErrorMessage(value: unknown): string {
  const message = getNestedRecord(value, "error").message;
  return typeof message === "string" ? message : "";
}

function defaultState(): LocalQwen35State {
  const home = os.homedir();
  return {
    modelRoot: process.env.LYNN_LOCAL_QWEN35_MODEL_ROOT || path.join(home, "Models", "Lynn", MODEL_ROOT_NAME),
    providerConfig: process.env.LYNN_LOCAL_QWEN35_PROVIDER_CONFIG || path.join(home, ".lynn-engine", "providers", "qwen35-9b-q4km-imatrix-gguf.json"),
    pidFile: process.env.LYNN_LOCAL_QWEN35_PID_FILE || path.join(home, ".lynn-engine", "run", "qwen35-9b-q4km-imatrix.pid"),
    logFile: process.env.LYNN_LOCAL_QWEN35_LOG_FILE || path.join(home, ".lynn-engine", "logs", "qwen35-9b-q4km-imatrix.client.log"),
    host: process.env.LYNN_LOCAL_QWEN35_HOST || "127.0.0.1",
    port: String(process.env.LYNN_LOCAL_QWEN35_PORT || "18099"),
  };
}

function expectedModelPath(state: LocalQwen35State = defaultState(), _variant = "imatrix"): string {
  // 2026-05-25: 默认回到 9B MTP;4B 仅作为显式 downgrade,不能误匹配成默认。
  return path.join(state.modelRoot, "q4_k_m", MODEL_FILE_NAME);
}

function candidateModelPaths(state: LocalQwen35State = defaultState()): string[] {
  const home = os.homedir();
  return [
    expectedModelPath(state, "imatrix"),
    path.join(state.modelRoot, MODEL_FILE_NAME),
    path.join(home, ".lynn", "models", MODEL_FILE_NAME),
    path.join(home, ".lynn", "models", MODEL_FILE_NAME.toLowerCase()),
    path.join(home, "Models", "Lynn", MODEL_ROOT_NAME, "q4_k_m", MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", MODEL_ROOT_NAME, MODEL_FILE_NAME),
  ];
}

function installedModelPath(state: LocalQwen35State = defaultState()): string | null {
  for (const candidate of candidateModelPaths(state)) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore inaccessible candidate paths; they simply are not installed.
    }
  }
  return null;
}

function endpointRoot(state: LocalQwen35State = defaultState()): string {
  return `http://${state.host}:${state.port}`;
}

function bootstrapPath(): string | null {
  const explicit = process.env.LYNN_QWEN35_BOOTSTRAP;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidate = fromRoot("scripts", "local_qwen35_9b_client_bootstrap.py");
  return fs.existsSync(candidate) ? candidate : null;
}

function commonArgs(state: LocalQwen35State, variant = "imatrix"): string[] {
  return [
    "--variant", variant,
    "--host", state.host,
    "--port", state.port,
    "--model-root", state.modelRoot,
    "--provider-config", state.providerConfig,
    "--pid-file", state.pidFile,
    "--log-file", state.logFile,
  ];
}

function readPidFile(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const pid = Number(raw.split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listenerPids(port: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: 2_000,
      maxBuffer: 32 * 1024,
    });
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter(isPositiveFiniteNumber);
  } catch (err: unknown) {
    const stdout = errorOutput(err, "stdout");
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter(isPositiveFiniteNumber);
  }
}

async function qwen35ProcessPids(state: LocalQwen35State = defaultState()): Promise<number[]> {
  const modelPaths = candidateModelPaths(state);
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      timeout: 2_000,
      maxBuffer: 512 * 1024,
    });
    return stdout
      .split("\n")
      .map((line): number | null => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const command = match[2] || "";
        if (!Number.isFinite(pid) || pid <= 0) return null;
        if (!/llama-server(?:\s|$)/.test(command) && !/llama-server\b/.test(command)) return null;
        const mentionsPort = command.includes(`--port ${state.port}`) || command.includes(`:${state.port}`);
        const mentionsModel = modelPaths.some((candidate) => candidate && command.includes(candidate))
          || /Qwen3\.5-9B-Q4_K_M/i.test(command)
          || /qwen35-9b-q4km/i.test(command);
        return mentionsPort || mentionsModel ? pid : null;
      })
      .filter(isPositiveFiniteNumber);
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<Response> {
  const { timeoutMs = 900, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonMaybe(url: string, timeoutMs = 900): Promise<unknown | null> {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJsonStatus(url: string, timeoutMs = 900): Promise<{ ok: boolean; status: number; json: unknown | null }> {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    const text = await res.text().catch(() => "");
    let json: unknown | null = null;
    if (text) {
      try { json = JSON.parse(text); } catch {
        // Some llama.cpp endpoints return text during loading; keep status only.
      }
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

async function fetchTextMaybe(url: string, timeoutMs = 900): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function summarizeSlots(slots: unknown): SlotsSummary | null {
  if (!Array.isArray(slots)) return null;
  const summaries = slots.map((rawSlot): SlotSummary => {
    const slot = asRecord(rawSlot);
    return {
      id: slot.id ?? slot.id_slot ?? null,
      state: slot.state ?? null,
      prompt_tokens: slot.n_prompt_tokens_processed ?? slot.n_prompt_tokens ?? slot.prompt_tokens ?? null,
      predicted_tokens: slot.n_decoded ?? slot.n_predict ?? slot.predicted_tokens ?? null,
      progress: typeof slot.progress === "number" ? slot.progress : null,
    };
  });
  return {
    total: summaries.length,
    busy: summaries.filter((slot) => slot.state && !String(slot.state).toLowerCase().includes("idle")).length,
    slots: summaries.slice(0, 8),
  };
}

function parseMetrics(text: string | null): MetricSummary | null {
  if (!text) return null;
  const pick = (patterns: RegExp[]): number | null => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  };
  return {
    prompt_tokens_total: pick([
      /(?:^|\n)llamacpp:prompt_tokens_total\s+([0-9.]+)/,
      /(?:^|\n).*prompt.*tokens.*total\s+([0-9.]+)/i,
    ]),
    predicted_tokens_total: pick([
      /(?:^|\n)llamacpp:tokens_predicted_total\s+([0-9.]+)/,
      /(?:^|\n).*predicted.*tokens.*total\s+([0-9.]+)/i,
      /(?:^|\n).*completion.*tokens.*total\s+([0-9.]+)/i,
    ]),
    requests_total: pick([
      /(?:^|\n)llamacpp:requests_total\s+([0-9.]+)/,
      /(?:^|\n).*requests.*total\s+([0-9.]+)/i,
    ]),
  };
}

// 2026-05-24 A2 fix: runtimeDetails 一次开销 ~600-800ms (4 fetch + 2 execFile lsof+ps);
// 多组件 polling (StatusBar 15s / ProviderStatusBadge 12s / InputArea 15s / LocalModelDownloadStep 1.5s)
// 同时 hit 这条 route。加 1500ms 内存 cache + inflight dedup,避免 N 个并发 caller 各自 spawn lsof/ps。
const _RUNTIME_CACHE_TTL_MS = 1500;
let _runtimeCache: RuntimeCache = { at: 0, value: null, inflight: null };

async function _computeRuntimeDetails(): Promise<RuntimeDetails> {
  const state = defaultState();
  const root = endpointRoot(state);
  const pidFromFile = readPidFile(state.pidFile);
  const [listenPids, commandPids] = await Promise.all([
    listenerPids(state.port),
    qwen35ProcessPids(state),
  ]);
  const pids = [...new Set([...listenPids, ...commandPids])];
  const pid = pidFromFile && pids.includes(pidFromFile) ? pidFromFile : (pids[0] || pidFromFile || null);
  const [healthStatus, models, slots, metricsText] = await Promise.all([
    fetchJsonStatus(`${root}/health`),
    fetchJsonMaybe(`${root}/v1/models`),
    fetchJsonMaybe(`${root}/slots`),
    fetchTextMaybe(`${root}/metrics`),
  ]);
  const modelIds = jsonRecordArray(asRecord(models).data)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const health = healthStatus.ok ? healthStatus.json : null;
  const rawEndpointRunning = healthStatus.ok === true;
  const servesDefaultModel = modelIds.includes(MODEL_ID);
  const endpointOccupied = rawEndpointRunning && !servesDefaultModel;
  const defaultProcessAlive = isPidAlive(pidFromFile) || commandPids.some((candidate) => isPidAlive(candidate));
  const endpointRunning = rawEndpointRunning && servesDefaultModel;
  const endpointLoading = !rawEndpointRunning && defaultProcessAlive
    && (healthStatus.status === 503 || /loading/i.test(extractHealthErrorMessage(healthStatus.json)) || commandPids.length > 0);
  return {
    base_url: `${root}/v1`,
    gui_url: root,
    pid,
    pid_file: state.pidFile,
    process_alive: endpointRunning || endpointLoading ? isPidAlive(pid) : false,
    endpoint_running_any: rawEndpointRunning,
    listen_pids: listenPids,
    command_pids: commandPids,
    pids,
    endpoint_running: endpointRunning,
    endpoint_loading: endpointLoading,
    endpoint_occupied: endpointOccupied,
    serves_default_model: servesDefaultModel,
    health_status: healthStatus.status,
    health,
    model_ids: modelIds,
    foreign_model_ids: endpointOccupied ? modelIds : [],
    slots: summarizeSlots(slots),
    metrics: parseMetrics(metricsText),
    metrics_available: !!metricsText,
    checked_at: new Date().toISOString(),
  };
}

async function runtimeDetails({ force = false }: { force?: boolean } = {}): Promise<RuntimeDetails> {
  const now = Date.now();
  if (!force && _runtimeCache.value && (now - _runtimeCache.at) < _RUNTIME_CACHE_TTL_MS) {
    return _runtimeCache.value;
  }
  if (_runtimeCache.inflight) return _runtimeCache.inflight;
  const promise = _computeRuntimeDetails().then((value) => {
    _runtimeCache = { at: Date.now(), value, inflight: null };
    return value;
  }).catch((err) => {
    _runtimeCache = { at: Date.now(), value: null, inflight: null };
    throw err;
  });
  _runtimeCache.inflight = promise;
  return promise;
}

// 在 stopLocalModel / setup / register 等 mutation 后 invalidate cache,避免下一次 status 返回 stale。
function _invalidateRuntimeCache() {
  _runtimeCache = { at: 0, value: null, inflight: null };
}

function fastReadyPlan(runtime: RuntimeDetails, _variant = "imatrix"): JsonRecord {
  const state = defaultState();
  const totalMemoryGib = os.totalmem() / (1024 ** 3);
  const isMac = process.platform === "darwin";
  const chip = isMac ? os.cpus()?.[0]?.model || "Apple Silicon" : os.cpus()?.[0]?.model || null;
  // 2026-05-25 默认回到 9B MTP。24GB+ 推荐;16GB 可试但提示降级 4B。
  const comfortable = totalMemoryGib >= 24;
  const usable = totalMemoryGib >= 16;
  const ctxSize = comfortable ? 32768 : 16384;
  const parallel = 1;
  const modelPath = installedModelPath(state);
  return {
    ok: true,
    provider_id: PROVIDER_ID,
    model: MODEL_ID,
    plan: {
      decision: runtime.endpoint_occupied ? "occupied" : runtime.endpoint_running ? "ready" : runtime.endpoint_loading ? "loading" : "inspect",
      base_url: runtime.base_url,
      observed: {
        endpoint_running: runtime.endpoint_running === true,
        endpoint_loading: runtime.endpoint_loading === true,
        endpoint_occupied: runtime.endpoint_occupied === true,
        served_model_ids: runtime.model_ids || [],
        gguf: modelPath,
        llama_server: (runtime.endpoint_running || runtime.endpoint_loading || runtime.process_alive) ? "llama-server" : null,
        homebrew_available: null,
      },
      hardware: {
        can_enable: usable,
        recommendation: usable ? "recommended" : "not_recommended",
        chip,
        total_memory_gib: totalMemoryGib,
        gpus: [],
        recommended_runtime: {
          name: comfortable ? "local_qwen9b_32k" : "local_qwen9b_16k",
          label: comfortable ? "Qwen3.5-9B MTP 32K 推荐档" : "Qwen3.5-9B MTP 16K 试用档",
          ctx_size: ctxSize,
          parallel,
          gpu_layers: isMac ? 999 : 0,
        },
        warnings: [
          ...(runtime.endpoint_occupied
            ? [`检测到 ${runtime.base_url} 当前运行的是 ${runtime.model_ids?.join(", ") || "非默认模型"} 端点,不会作为默认 9B 使用;停止该端点后可启动默认 Qwen3.5-9B MTP。`]
            : []),
          ...(comfortable ? [] : [
          usable
            ? "当前内存低于 24GB,默认 9B 可试 16K;低配建议改用 4B 降级档,但 4B thinking-on 可能长思考后无正文。"
            : "当前内存低于 16GB,不建议默认安装 9B;可继续使用云端模型或在模型页手动选择 4B 降级档。",
          ]),
        ],
        blockers: [],
        // 三档全部 surface:默认 9B,低配 4B downgrade,高端 35B。
        upgrade_options: [
          // 4B 低配降级档
          {
            id: "qwen35-4b-q4km",
            label: "Qwen3.5-4B Q4_K_M imatrix (低配降级)",
            profile: "8~16GB 设备可选 · thinking-off 建议",
            metrics: ["2.6 GB", "MMLU thinking-off 73.00%", "GPQA thinking-off 16.67%", "thinking-on 可能长思考后无正文"],
            reason: "只建议低配机器降级使用;请保持 thinking-off 或让 Lynn 自动关闭轻任务 thinking。",
            modelscope_url: "https://modelscope.cn/models/Merkyor/Qwen3.5-4B-GGUF-imatrix",
            download_label: "下载到本机",
            file_name: "Qwen3.5-4B-Q4_K_M-imatrix.gguf",
            requires_memory_gib: 8,
            can_run: totalMemoryGib >= 8,
          },
          // 35B 高端档 (32GB+ 推荐) — 2026-05-28 切到 APEX-MTP I-Balanced 新仓库。
          {
            id: "qwen36-35b-a3b-apex-mtp",
            label: "Qwen3.6-35B-A3B APEX-MTP I-Balanced",
            profile: "32GB 显存/统一内存+ 推荐 · thinking-on 长链最快",
            metrics: ["DGX Spark thinking-on 75-85 TPS", "DGX Spark 数学 84.69 TPS", "DGX Spark 归纳证明 75.53 TPS", "APEX I-Balanced", "24.27 GiB · MTP head"],
            reason: "高端质量档;APEX-MTP 保留官方 MTP head,thinking-on 长链路比 no-MTP 基线提升约 20-30%。",
            modelscope_url: "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF",
            download_label: "下载到本机",
            file_name: "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf",
            requires_memory_gib: 32,
            can_run: totalMemoryGib >= 32,
          },
        ],
      },
      actions: [],
    },
  };
}

function parseJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch {
    // Bootstrap logs may wrap the final JSON; scan for the last object below.
  }
  const end = text.lastIndexOf("}");
  if (end <= 0) return null;
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Continue scanning earlier braces until a valid JSON object is found.
    }
  }
  return null;
}

function readLogTail(file: string, maxBytes = 96 * 1024): string {
  if (!file || !fs.existsSync(file)) return "";
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function parseDownloadProgress(text: string): JobProgress | null {
  const chunks = text.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
  const downloadRegex = /Downloading\s+\[[^\]]+\]:\s*(\d{1,3})%\|[^|]*\|\s*([^/\s]+)\/([^\s]+)\s*\[([^<\]]+)<([^,\]]+),\s*([^\]]+)\]/;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const match = chunks[i].match(downloadRegex);
    if (!match) continue;
    return {
      phase: "下载模型（ModelScope）",
      source: "modelscope",
      percent: Math.max(0, Math.min(100, Number(match[1]))),
      downloaded: match[2],
      total: match[3],
      elapsed: match[4],
      eta: match[5],
      speed: match[6],
      message: chunks[i].replace(/\s+/g, " "),
    };
  }
  return null;
}

function parseJobProgress(job: SetupJob): JobProgress | null {
  if (!job?.log_file) return null;
  const text = readLogTail(job.log_file);
  if (!text) return null;
  const chunks = text.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
  const tail = chunks
    .filter((line) => !line.startsWith("Downloading [") || /100%\|/.test(line))
    .slice(-8);
  const download = parseDownloadProgress(text);
  if (download) return { ...download, tail };

  let phase = "准备本地模型";
  let percent: number | null = null;
  let source: string | null = null;
  if (/installing llama\.cpp|Installing llama\.cpp|Pouring llama\.cpp/i.test(text)) {
    phase = "安装 llama.cpp";
    percent = 10;
  }
  if (/downloading via Lynn CDN/i.test(text)) {
    phase = "下载模型（Lynn CDN）";
    source = "lynn-cdn";
    percent = 25;
  }
  if (/downloading via ModelScope/i.test(text)) {
    phase = "连接 ModelScope 下载";
    source = "modelscope";
    percent = 25;
  }
  if (/Running llama\.cpp smoke|smoke/i.test(text)) {
    phase = "验证本地模型";
    percent = 88;
  }
  if (/starting llama\.cpp|server started|llama-server/i.test(text) && /smoke/i.test(text)) {
    phase = "启动本地端点";
    percent = 94;
  }
  if (job.status === "succeeded") {
    phase = "本地模型已就绪";
    percent = 100;
  }
  if (job.status === "failed") {
    phase = "准备失败";
  }
  return {
    phase,
    source,
    percent,
    tail,
    message: tail[tail.length - 1] || phase,
  };
}

function decorateJob(job: SetupJob | null): DecoratedSetupJob | null {
  if (!job) return null;
  return {
    ...job,
    progress: parseJobProgress(job),
  };
}

// Cache python3 availability check across requests (resets on process restart)
let _python3CheckResult: Python3CheckResult | null = null;
async function ensurePython3(): Promise<Python3CheckResult> {
  if (_python3CheckResult !== null) return _python3CheckResult;
  try {
    await execFileAsync("python3", ["--version"], { timeout: 5_000 });
    _python3CheckResult = { ok: true };
  } catch (err: unknown) {
    _python3CheckResult = {
      ok: false,
      error: "python3_not_found",
      detail: "python3 executable not in PATH. On macOS install via Homebrew (brew install python3) or python.org installer. Lynn local model setup needs python3 to run the bootstrap script.",
      raw: errorMessage(err),
    };
  }
  return _python3CheckResult;
}

async function plan(variant = "imatrix"): Promise<JsonRecord> {
  const bootstrap = bootstrapPath();
  const state = defaultState();
  if (!bootstrap) {
    return {
      ok: false,
      error: "bootstrap_not_found",
      searched: [fromRoot("scripts", "local_qwen35_9b_client_bootstrap.py")],
      provider_id: PROVIDER_ID,
      fallback_provider: "brain",
    };
  }
  const pyCheck = await ensurePython3();
  if (!pyCheck.ok) {
    return {
      provider_id: PROVIDER_ID,
      fallback_provider: "brain",
      ...pyCheck,
    };
  }
  try {
    const { stdout } = await execFileAsync("python3", [bootstrap, "plan", ...commonArgs(state, variant)], {
      cwd: fromRoot(),
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      provider_id: PROVIDER_ID,
      model: MODEL_ID,
      bootstrap,
      plan: parseJson(String(stdout)),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      provider_id: PROVIDER_ID,
      bootstrap,
      error: errorMessage(err),
      stdout: errorOutput(err, "stdout"),
      stderr: errorOutput(err, "stderr"),
    };
  }
}

async function registerProvider(engine: LocalQwen35RouteEngine, options: RegisterProviderOptions = {}): Promise<boolean> {
  const state = defaultState();
  engine.providerRegistry.saveProvider(PROVIDER_ID, {
    display_name: "本地 Qwen3.5-9B",
    base_url: `http://${state.host}:${state.port}/v1`,
    api: "openai-completions",
    auth_type: "none",
    models: [{
      id: MODEL_ID,
      name: MODEL_DISPLAY_NAME,
      context: 32768,
      maxOutput: 32768,
    }],
  });
  await engine.syncModelsAndRefresh?.();
  await engine.refreshAvailableModels?.();
  if (options.activate) {
    await engine.setPendingModel?.(MODEL_ID, PROVIDER_ID);
  }
  return true;
}

function isReadyPlan(planData: unknown): boolean {
  const observed = getPlanObserved(planData);
  return observed.endpoint_running === true
    && !!observed.gguf
    && !!observed.llama_server;
}

function isProviderRegistered(engine: LocalQwen35RouteEngine): boolean {
  const raw = engine.providerRegistry?.getAllProvidersRaw?.() || {};
  const entry = raw[PROVIDER_ID];
  return !!entry?.models?.some?.((m) => (typeof m === "object" && m !== null ? m.id : m) === MODEL_ID);
}

export function deriveLocalQwen35ProviderState({ runtime, status, registered, job }: DeriveProviderStateInput = {}) {
  const observed = getPlanObserved(status);
  const statusRecord = asRecord(status);
  const hasObservedGguf = Object.prototype.hasOwnProperty.call(observed, "gguf");
  const hasObservedLlamaServer = Object.prototype.hasOwnProperty.call(observed, "llama_server");
  const gguf = hasObservedGguf ? observed.gguf : installedModelPath(defaultState());
  const llamaServer = hasObservedLlamaServer ? observed.llama_server : null;
  if (runtime?.endpoint_occupied || observed.endpoint_occupied) {
    return {
      state: "occupied",
      severity: "error",
      canSwitch: false,
      canSetup: true,
      reason: "endpoint_running_non_default_model",
    };
  }
  if (runtime?.endpoint_running || observed.endpoint_running) {
    return {
      state: registered ? "ready" : "endpoint_ready_unregistered",
      severity: registered ? "ready" : "warning",
      canSwitch: registered === true,
      canSetup: registered !== true,
      reason: registered ? "ready" : "register_provider_required",
    };
  }
  if (runtime?.endpoint_loading || runtime?.process_alive || observed.endpoint_loading || job?.status === "running") {
    return {
      state: "preparing",
      severity: "busy",
      canSwitch: false,
      canSetup: false,
      reason: job?.status === "running" ? "setup_job_running" : "runtime_loading",
    };
  }
  if (!gguf) {
    return {
      state: "needs_model",
      severity: "standby",
      canSwitch: false,
      canSetup: true,
      reason: "gguf_missing",
    };
  }
  if (!llamaServer) {
    return {
      state: "needs_runtime",
      severity: "standby",
      canSwitch: false,
      canSetup: true,
      reason: "llama_server_missing",
    };
  }
  if (statusRecord.ok === false) {
    return {
      state: "unavailable",
      severity: "error",
      canSwitch: false,
      canSetup: true,
      reason: typeof statusRecord.error === "string" ? statusRecord.error : "status_error",
    };
  }
  return {
    state: "ready_to_start",
    severity: "standby",
    canSwitch: false,
    canSetup: true,
    reason: "assets_ready_endpoint_stopped",
  };
}

export function createLocalQwen35Route(engine: LocalQwen35RouteEngine): Hono {
  const route = new Hono();
  let job: SetupJob | null = null;

  route.get("/local-qwen35-9b/status", async (c) => {
    const runtime = await runtimeDetails();
    const status = (runtime.endpoint_running || runtime.endpoint_loading || runtime.process_alive)
      ? fastReadyPlan(runtime)
      : await plan();
    const registered = isProviderRegistered(engine);
    const decoratedJob = decorateJob(job);
    const providerState = deriveLocalQwen35ProviderState({
      runtime,
      status,
      registered,
      job: decoratedJob,
    });
    return c.json({ ...status, registered_provider: registered, runtime, job: decoratedJob, provider_state: providerState });
  });

  route.post("/local-qwen35-9b/setup", async (c) => {
    const body = await safeJson<SetupBody>(c);
    const authorized = body.authorized === true || body.yesUserAuthorized === true;
    if (!authorized) {
      return c.json({
        ok: false,
        error: "missing_user_authorization",
        message: "客户端必须在用户授权后传 authorized:true，才会安装、下载或启动本地模型。",
      }, 403);
    }
    if (job?.status === "running") return c.json({ ok: true, already_running: true, job: decorateJob(job) }, 202);

    const bootstrap = bootstrapPath();
    const state = defaultState();
    if (!bootstrap) return c.json({ ok: false, error: "bootstrap_not_found" }, 503);

    fs.mkdirSync(path.dirname(state.logFile), { recursive: true });
    const logFile = path.join(path.dirname(state.logFile), `qwen35-9b-setup-${Date.now()}.log`);
    const args = [
      bootstrap,
      "execute",
      ...commonArgs(state, body.variant || "imatrix"),
      "--yes-user-authorized",
    ];
    if (body.start !== false) args.push("--start");
    if (body.installRuntime === false) args.push("--no-install-runtime");

    const runningJob: SetupJob = {
      id: "local-qwen35-9b-setup-" + Date.now(),
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      log_file: logFile,
      provider_id: PROVIDER_ID,
      model: MODEL_ID,
      exit_code: null,
      result: null,
    };
    job = runningJob;

    const child = spawn("python3", args, { cwd: fromRoot(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (chunk: string) => {
      try { fs.appendFileSync(logFile, chunk); } catch {
        // Best effort logging; setup should continue if the log file is unavailable.
      }
    };
    child.stdout.on("data", (buf) => { const s = buf.toString(); stdout += s; append(s); });
    child.stderr.on("data", (buf) => { const s = buf.toString(); stderr += s; append(s); });
    child.on("exit", async (code) => {
      const result = parseJson(stdout);
      const resultStatus = asRecord(result).status;
      let registered = false;
      let registerError: string | null = null;
      const finalStatus = code === 0 && !isReadyPlan(resultStatus)
        ? await plan(body.variant || "imatrix").catch(() => null)
        : null;
      if (code === 0 && (isReadyPlan(resultStatus) || isReadyPlan(finalStatus))) {
        try {
          await registerProvider(engine, { activate: true });
          registered = true;
        } catch (err: unknown) {
          registerError = errorMessage(err);
        }
      } else if (code === 0) {
        registerError = "endpoint_not_ready";
      }
      job = {
        ...runningJob,
        status: code === 0 && !registerError ? "succeeded" : "failed",
        finished_at: new Date().toISOString(),
        exit_code: code,
        result,
        registered,
        register_error: registerError,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-4000),
      };
      _invalidateRuntimeCache();
    });
    return c.json({ ok: true, job: decorateJob(job) }, 202);
  });

  route.post("/local-qwen35-9b/register", async (c) => {
    const status = await plan();
    if (!isReadyPlan(status)) {
      return c.json({
        ok: false,
        error: "endpoint_not_ready",
        message: "本地 Qwen3.5-9B 端点还没有通过 /health 和 /v1/models 就绪检查,暂不注册。",
        status,
      }, 409);
    }
    await registerProvider(engine, { activate: true });
    return c.json({ ok: true, provider_id: PROVIDER_ID, model: MODEL_ID });
  });

  route.post("/local-qwen35-9b/stop", async (c) => {
    const state = defaultState();
    const before = await runtimeDetails();
    const targets = new Set([
      ...before.pids,
      readPidFile(state.pidFile),
    ].filter(isPositiveFiniteNumber));

    for (const pid of targets) {
      try { process.kill(pid, "SIGTERM"); } catch {
        // Process may have exited between discovery and termination.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    let remaining = [...new Set([
      ...await listenerPids(state.port),
      ...await qwen35ProcessPids(state),
    ])];
    if (remaining.length > 0) {
      for (const pid of remaining) {
        try { process.kill(pid, "SIGKILL"); } catch {
          // Process may have exited after SIGTERM.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      remaining = [...new Set([
        ...await listenerPids(state.port),
        ...await qwen35ProcessPids(state),
      ])];
    }
    try { fs.rmSync(state.pidFile, { force: true }); } catch {
      // Non-fatal cleanup.
    }
    _invalidateRuntimeCache();

    return c.json({
      ok: remaining.length === 0,
      stopped_pids: [...targets],
      remaining_pids: remaining,
      before,
      runtime: await runtimeDetails({ force: true }),
    });
  });

  return route;
}
