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
 * REMOVAL TARGET: V0.84 — after LocalModelDownloadStep.tsx migrates to
 *                 platform.llamacppStartDownload(), delete this file. A one-time runtime
 *                 warning below makes any残留 usage observable in server logs before removal.
 */
import { spawn, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { fromRoot } from "../../shared/lynn-root.js";
import localHardware from '../../shared/local-model-hardware.cjs';
import { localListenerPids, localLlamaProcesses, selectQwen35ProcessPids } from "../local-model-processes.js";
const localCatalog = localHardware.catalog;

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const MODEL_ID = "qwen36-27b-dsv4pro-coding-q4-mtp";
const MODEL_DISPLAY_NAME = "Qwen3.6-27B DSV4Pro GLM52-SFT-GPT55-RL Coding Q4 imatrix MTP";
const MODEL_FILE_NAME = "Q4-imatrix-MTP-00001-of-00004.gguf";
const MODEL_ROOT_NAME = "Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF";
const LOCAL_QWEN35_CLOUD_FALLBACK_PROVIDER = process.env.LYNN_LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER || "step-3.7-flash";
const LOCAL_QWEN35_RUNTIME_POLICY = Object.freeze({
  role: "explicit_opt_in_local_27b_distill",
  kv_cache_reuse: true,
  warm_pool_default: false,
  idle_unload: true,
  stable_prefix: true,
  small_context: true,
  max_history_messages: Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_MESSAGES || 8),
  max_history_chars: Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_CHARS || 8000),
  tool_schema_limit: Math.max(3, Math.min(5, Number(process.env.LYNN_LOCAL_QWEN35_TOOL_SCHEMA_LIMIT || 5))),
  footer_decode_tps: true,
  failure_fallback_provider: LOCAL_QWEN35_CLOUD_FALLBACK_PROVIDER,
});

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
  predicted_tps: number | null;
  tps_window_seconds: number | null;
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
    providerConfig: process.env.LYNN_LOCAL_QWEN35_PROVIDER_CONFIG || path.join(home, ".lynn-engine", "providers", "qwen36-27b-dsv4pro-coding-q4-mtp-gguf.json"),
    pidFile: process.env.LYNN_LOCAL_QWEN35_PID_FILE || path.join(home, ".lynn-engine", "run", "qwen36-27b-dsv4pro-coding-q4-mtp.pid"),
    logFile: process.env.LYNN_LOCAL_QWEN35_LOG_FILE || path.join(home, ".lynn-engine", "logs", "qwen36-27b-dsv4pro-coding-q4-mtp.client.log"),
    host: process.env.LYNN_LOCAL_QWEN35_HOST || "127.0.0.1",
    port: String(process.env.LYNN_LOCAL_QWEN35_PORT || "18099"),
  };
}

function expectedModelPath(state: LocalQwen35State = defaultState(), _variant = "imatrix"): string {
  // 2026-07-07: 默认改为 27B Coding GGUF Q4 imatrix MTP split;9B/4B 仅作为显式 downgrade。
  return path.join(os.homedir(), ".lynn", "models", "Q4_LynnStyle", MODEL_FILE_NAME);
}

function candidateModelPaths(state: LocalQwen35State = defaultState()): string[] {
  const home = os.homedir();
  return [
    expectedModelPath(state, "imatrix"),
    path.join(state.modelRoot, MODEL_FILE_NAME),
    path.join(state.modelRoot, "Q4_LynnStyle", MODEL_FILE_NAME),
    path.join(home, ".lynn", "models", "Q4_LynnStyle", MODEL_FILE_NAME),
    path.join(home, ".lynn", "models", MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", MODEL_ROOT_NAME, "Q4_LynnStyle", MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", MODEL_ROOT_NAME, "q4_lynnstyle", MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", MODEL_ROOT_NAME, MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF", "Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf"),
    path.join(home, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF", MODEL_FILE_NAME),
    path.join(home, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF", "q5_k_m", "Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf"),
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

export { localQwenListenerInvocation, localQwenProcessListInvocation, parseProcessCommandLines, parseWindowsListenerPids, selectQwen35ProcessPids } from "../local-model-processes.js";

async function listenerPids(port: string): Promise<number[]> {
  return localListenerPids(port);
}

async function qwen35ProcessPids(state: LocalQwen35State = defaultState()): Promise<number[]> {
  const modelPaths = candidateModelPaths(state);
  try {
    const processes = await localLlamaProcesses();
    return selectQwen35ProcessPids(processes, state.port, modelPaths);
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
    predicted_tps: null,
    tps_window_seconds: null,
  };
}

// 2026-05-24 A2 fix: runtimeDetails 一次开销 ~600-800ms (4 fetch + 2 execFile lsof+ps);
// 多组件 polling (StatusBar 15s / ProviderStatusBadge 12s / InputArea 15s / LocalModelDownloadStep 1.5s)
// 同时 hit 这条 route。加 1500ms 内存 cache + inflight dedup,避免 N 个并发 caller 各自 spawn lsof/ps。
const _RUNTIME_CACHE_TTL_MS = 1500;
let _runtimeCache: RuntimeCache = { at: 0, value: null, inflight: null };
let _metricRateSample: {
  pid: number | null;
  at: number;
  predictedTokens: number | null;
} | null = null;

function withMetricRates(metrics: MetricSummary | null, pid: number | null): MetricSummary | null {
  if (!metrics) return null;
  const now = Date.now();
  const predictedTokens = typeof metrics.predicted_tokens_total === "number" ? metrics.predicted_tokens_total : null;
  let predictedTps: number | null = null;
  let windowSeconds: number | null = null;
  if (
    predictedTokens !== null
    && _metricRateSample
    && _metricRateSample.pid === pid
    && typeof _metricRateSample.predictedTokens === "number"
    && predictedTokens >= _metricRateSample.predictedTokens
  ) {
    const elapsed = (now - _metricRateSample.at) / 1000;
    if (elapsed >= 0.5 && elapsed <= 60) {
      const raw = (predictedTokens - _metricRateSample.predictedTokens) / elapsed;
      predictedTps = Number.isFinite(raw) ? Number(raw.toFixed(1)) : null;
      windowSeconds = Number(elapsed.toFixed(1));
    }
  }
  _metricRateSample = { pid, at: now, predictedTokens };
  return {
    ...metrics,
    predicted_tps: predictedTps,
    tps_window_seconds: windowSeconds,
  };
}

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
  const servesDefaultModel = modelIds.some(id => localCatalog.tiers.some(tier => tier.modelId === id));
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
    metrics: withMetricRates(parseMetrics(metricsText), pid),
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

async function fastReadyPlan(runtime: RuntimeDetails, _variant = "imatrix"): Promise<JsonRecord> {
  const state = defaultState();
  const detected = await localHardware.detectLocalModelHardware();
  const selected = localCatalog.tiers.find(tier => runtime.model_ids?.includes(tier.modelId))
    || localCatalog.tiers.find(tier => tier.modelId === detected.recommended_model_id) || localCatalog.tiers[0];
  const totalMemoryGib = os.totalmem() / (1024 ** 3);
  const isMac = process.platform === "darwin";
  const chip = isMac ? os.cpus()?.[0]?.model || "Apple Silicon" : os.cpus()?.[0]?.model || null;
  // Hardware recommendation and the currently served tier are deliberately separate.
  const usable = detected.can_enable;
  const ctxSize = selected.contextSize;
  const parallel = 1;
  const oldModelPath = installedModelPath(state);
  const selectedPath = path.join(process.env.LYNN_HOME || path.join(os.homedir(), '.lynn'), 'models', selected.fileName);
  const modelPath = fs.existsSync(selectedPath) ? selectedPath : null;
  return {
    ok: true,
    provider_id: PROVIDER_ID,
    model: selected.modelId,
    display_name: selected.label,
    expected_file_name: selected.fileName,
    expected_model_path: selectedPath,
    setup_backend: "desktop_llamacpp_manager",
    python_bootstrap_required: false,
    local_model_downloader_available: true,
    runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    plan: {
      decision: runtime.endpoint_occupied ? "occupied" : runtime.endpoint_running ? "ready" : runtime.endpoint_loading ? "loading" : "inspect",
      base_url: runtime.base_url,
      observed: {
        endpoint_running: runtime.endpoint_running === true,
        endpoint_loading: runtime.endpoint_loading === true,
        endpoint_occupied: runtime.endpoint_occupied === true,
        served_model_ids: runtime.model_ids || [],
        gguf: modelPath,
        legacy_gguf: oldModelPath !== modelPath ? oldModelPath : null,
        llama_server: (runtime.endpoint_running || runtime.endpoint_loading || runtime.process_alive) ? "llama-server" : null,
        homebrew_available: null,
      },
      hardware: {
        can_enable: usable,
        recommendation: usable ? "recommended" : "not_recommended",
        chip,
        total_memory_gib: totalMemoryGib,
        ...detected,
        recommended_runtime: {
          name: selected.modelId,
          model_id: detected.recommended_model_id,
          label: usable ? selected.label : '显存/统一内存不足或未确认，不能安装；Q2 至少 14GiB',
          ctx_size: ctxSize,
          parallel,
          gpu_layers: 999,
        },
        warnings: detected.warnings,
        blockers: [],
        upgrade_options: [
          {
            id: "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix",
            label: "Qwen3.6-35B-A3B DSV4Pro Thinking Distill MTP Q5_K_M imatrix",
            profile: "32GB 显存/统一内存+ 可选 · 更高配本地编排器",
            metrics: ["25.3 GB Q5_K_M imatrix", "MTP 原生头", "GPQA-Diamond 80.3%", "端到端编排 26.6s"],
            reason: "35B-A3B Q5_K_M 是手动可选的旧版模型，文件和缓存占用更大。默认推荐 Qwen3.8-27B Coder390：24GB 及以上 Q3，24GB 以下（16GB 档） Q2。低于 14GiB 不能安装。",
            modelscope_url: "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF",
            download_label: "下载到本机",
            file_name: "Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf",
            requires_memory_gib: 32,
            can_run: (detected.accelerator_memory_gib || 0) >= 32,
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
    await execFileAsync("python3", ["--version"], { timeout: 5_000, windowsHide: true });
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
      fallback_provider: LOCAL_QWEN35_CLOUD_FALLBACK_PROVIDER,
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  }
  const pyCheck = await ensurePython3();
  if (!pyCheck.ok) {
    return {
      provider_id: PROVIDER_ID,
      fallback_provider: LOCAL_QWEN35_CLOUD_FALLBACK_PROVIDER,
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
      ...pyCheck,
    };
  }
  try {
    const { stdout } = await execFileAsync("python3", [bootstrap, "plan", ...commonArgs(state, variant)], {
      cwd: fromRoot(),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      provider_id: PROVIDER_ID,
      model: MODEL_ID,
      bootstrap,
      plan: parseJson(String(stdout)),
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      provider_id: PROVIDER_ID,
      bootstrap,
      error: errorMessage(err),
      stdout: errorOutput(err, "stdout"),
      stderr: errorOutput(err, "stderr"),
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  }
}

async function registerProvider(engine: LocalQwen35RouteEngine, options: RegisterProviderOptions = {}): Promise<boolean> {
  const state = defaultState();
  const actual = await runtimeDetails({ force: true });
  const tier = localCatalog.tiers.find(item => actual.model_ids?.includes(item.modelId));
  if (!tier || !actual.endpoint_running) return false;
  engine.providerRegistry.saveProvider(PROVIDER_ID, {
    display_name: "本地 Qwen3.8-27B Coder390",
    base_url: `http://${state.host}:${state.port}/v1`,
    api: "openai-completions",
    auth_type: "none",
    models: [{
      id: tier.modelId,
      name: tier.label,
      context: tier.contextSize,
      maxOutput: tier.contextSize,
    }],
  });
  await engine.syncModelsAndRefresh?.();
  await engine.refreshAvailableModels?.();
  if (options.activate) {
    await engine.setPendingModel?.(tier.modelId, PROVIDER_ID);
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
  return !!entry?.models?.some?.((m) => localCatalog.tiers.some(tier => tier.modelId === (typeof m === "object" && m !== null ? m.id : m)));
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
  // Deprecation telemetry: log ONCE on first real use so V0.84 removal can be data-driven
  // (no hits in logs across a release cycle = safe to delete).
  let warnedDeprecated = false;
  route.use("*", async (c, next) => {
    if (!warnedDeprecated) {
      warnedDeprecated = true;
      console.warn(`[local-qwen35] DEPRECATED Path B route hit (${c.req.method} ${c.req.path}) — Path A (desktop llamacpp-manager) is canonical; this route is scheduled for removal in V0.84`);
    }
    await next();
  });

  route.get("/local-qwen35-9b/status", async (c) => {
    const runtime = await runtimeDetails();
    const status = await fastReadyPlan(runtime);
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
        runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
      }, 403);
    }
    if (job?.status === "running") {
      return c.json({ ok: true, already_running: true, job: decorateJob(job), runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY }, 202);
    }

    if (process.env.LYNN_LOCAL_QWEN35_USE_BOOTSTRAP !== "1") {
      return c.json({
        ok: false,
        error: "desktop_downloader_required",
        message: "默认本地模型安装已迁移到 Lynn 桌面端内置下载器。请使用客户端内的“安装本地模型/启动”按钮。",
        provider_id: PROVIDER_ID,
        model: MODEL_ID,
        setup_backend: "desktop_llamacpp_manager",
        python_bootstrap_required: false,
        local_model_downloader_available: true,
        runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
      }, 409);
    }

    const bootstrap = bootstrapPath();
    const state = defaultState();
    if (!bootstrap) {
      return c.json({ ok: false, error: "bootstrap_not_found", runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY }, 503);
    }
    const pyCheck = await ensurePython3();
    if (!pyCheck.ok) {
      return c.json({
        ok: false,
        error: "desktop_downloader_required",
        message: "旧版 Python bootstrap 不可用。请使用 Lynn 桌面端内置的本地模型下载器安装并启动本地 Qwen3.6-27B。",
        detail: "python3 is not required for the current desktop downloader path; this compatibility endpoint only runs for old clients.",
        provider_id: PROVIDER_ID,
        model: MODEL_ID,
        setup_backend: "desktop_llamacpp_manager",
        python_bootstrap_required: false,
        local_model_downloader_available: true,
        runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
      }, 501);
    }

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

    const child = spawn("python3", args, { cwd: fromRoot(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    return c.json({ ok: true, job: decorateJob(job), runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY }, 202);
  });

  route.post("/local-qwen35-9b/register", async (c) => {
    const runtime = await runtimeDetails({ force: true });
    const status = await fastReadyPlan(runtime);
    if (!runtime.endpoint_running || !runtime.serves_default_model) {
      return c.json({
        ok: false,
        error: "endpoint_not_ready",
        message: "本地 Qwen3.6-27B 端点还没有通过 /health 和 /v1/models 就绪检查,暂不注册。",
        status,
      }, 409);
    }
    const registered = await registerProvider(engine, { activate: true });
    if (!registered) return c.json({ ok: false, error: 'endpoint_changed_during_registration' }, 409);
    return c.json({ ok: true, provider_id: PROVIDER_ID, model: runtime.model_ids?.find(id => localCatalog.tiers.some(tier => tier.modelId === id)) });
  });

  route.post("/local-qwen35-9b/stop", async (c) => {
    const state = defaultState();
    const before = await runtimeDetails();
    // Listening on our default port is not proof this is a Lynn-owned process.
    const targets = new Set(await qwen35ProcessPids(state));

    for (const pid of targets) {
      try { process.kill(pid, "SIGTERM"); } catch {
        // Process may have exited between discovery and termination.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    let remaining = await qwen35ProcessPids(state);
    if (remaining.length > 0) {
      for (const pid of remaining) {
        try { process.kill(pid, "SIGKILL"); } catch {
          // Process may have exited after SIGTERM.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      remaining = await qwen35ProcessPids(state);
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
