/**
 * llamacpp-manager.cjs · Lynn V0.79+ 2026-05-20
 *
 * 跨平台 llama.cpp local 推理服务守护(macOS / Windows / Linux 同源)。
 *
 * 背景:
 *   5/20 战略 pivot 后 Lynn 客户端默认本地推理底层 = llama.cpp。
 *   Mac Q4_K_M GGUF / Linux CUDA Q4_K_M / Win x64 CUDA Q4_K_M 全平台 ship。
 *   2026-07-07 更新: 默认 ship 模型切到 Qwen3.6-27B DSV4Pro
 *     GLM52-SFT-GPT55-RL Coding GGUF Q4 imatrix MTP (4 split shards,
 *     19.6GB total, 24GB+ 推荐)。
 *   9B / 4B 保留为低配降级档。
 *
 * 本模块策略:
 *   1. start():
 *      a) ENV LYNN_SKIP_LLAMACPP=1 → 完全禁用
 *      b) probe 已有端口 → 全 200 = 外部用户已起 server, 进 standby
 *      c) 找 binary (~/.lynn/llamacpp/bin/llama-server[.exe])
 *      d) 找 model (~/.lynn/models/<default-model>.gguf)
 *      e) 任一缺 → emit needs-install state, 等 UI 触发 download (Phase 2 自动 download)
 *      f) spawn llama-server, 跟 Lynn 生命周期绑
 *   2. health loop 30s, /health 不 200 → restart (5s 回避)
 *   3. crash exit → 5s 重启
 *   4. stop() → SIGTERM, 5s 后 SIGKILL
 *
 * Port allocation:
 *   - DEFAULT_PORT = 18099 (Lynn 命名空间)
 *   - 若占用 → 自动 +1 试 (max 5 次)
 *   - 最终 port 通过 emitState 报给 main, provider-registry 用此 port 注册 base_url
 *
 * 合规:
 *   - 仅 spawn 本地 binary(用户事先 download/install,不引入第三方 tunnel/proxy)
 *   - Phase 2 自动 download 会校验 sha256 + size,失败 fallback CDN/HF 镜像
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");
const localCatalog = require('../shared/qwen38-local-models.json');

// ─────────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  // 默认 ship 模型 — Qwen3.6-27B DSV4Pro GLM52-SFT-GPT55-RL Coding Q4 imatrix MTP。
  // 降级路径: 9B / 4B 仍可手动选,但不再作为首推。
  modelId: localCatalog.defaultModelId,
  modelFileName: localCatalog.tiers[0].fileName,
  modelExpectedSize: localCatalog.tiers[0].expectedSize,
  // Product default: one comfortable 32K local slot. llama.cpp splits context
  // across parallel slots, so keep -np/--parallel at 1 for the local-first UX.
  serverArgs: [
    "--ctx-size", "8192",
    "--threads", "4",
    "--parallel", "1",
    "--n-gpu-layers", "999",
    "-a", localCatalog.defaultModelId,
    "--jinja",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    // Keep thinking available for distilled 27B; request policy should use
    // temperature 0.6 / top_p 0.95 for thinking tasks.
    "--reasoning", "auto",
    "--reasoning-budget", "-1",
    "--metrics",
    "--host", "127.0.0.1",
  ],
  // port 分配
  preferredPort: 18099,
  portRetryCount: 5,
  // health probe
  healthPath: "/health",
  healthIntervalMs: 30000,
  healthTimeoutMs: 3000,
  startupTimeoutMs: 60000,
  // restart policy
  restartDelayMs: 5000,
  maxConsecutiveCrashes: 5,
});

// ─────────────────────────────────────────────────────────────
// 路径解析
// ─────────────────────────────────────────────────────────────

function defaultLynnRoot(homeDir) {
  return path.join(homeDir, ".lynn");
}

function expandHomePath(rawPath, homeDir = os.homedir()) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, homeDir));
}

function binaryPathForLynnRoot(lynnRoot, platform) {
  const binName = platform === "win32" ? "llama-server.exe" : "llama-server";
  return path.join(lynnRoot, "llamacpp", "bin", binName);
}

function defaultBinaryPath(homeDir, platform) {
  return binaryPathForLynnRoot(defaultLynnRoot(homeDir), platform);
}

function bundledBinaryPath(resourcesPath, platform) {
  if (!resourcesPath || platform !== "win32") return "";
  return path.join(resourcesPath, "llamacpp", "bin", "llama-server.exe");
}

function systemBinaryCandidates(platform, spawnSyncFn = spawnSync) {
  const candidates = platform === "win32" ? [] : [
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  ];
  try {
    const locator = platform === "win32" ? "where.exe" : "which";
    const resolved = spawnSyncFn(locator, ["llama-server"], { encoding: "utf8", timeout: 1000, windowsHide: true });
    const fromPath = String(resolved.stdout || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    candidates.unshift(...fromPath);
  } catch {
    // PATH discovery is best-effort; static candidates cover common Mac/Linux paths.
  }
  return [...new Set(candidates)];
}

function lynnHomeModelPath(lynnHome, fileName) {
  return path.join(lynnHome, "models", fileName);
}

function defaultModelPath(homeDir, fileName) {
  return lynnHomeModelPath(defaultLynnRoot(homeDir), fileName);
}

function legacyModelPathCandidates(homeDir, modelId, fileName, lynnHome = defaultLynnRoot(homeDir)) {
  const candidates = [
    lynnHomeModelPath(lynnHome, fileName),
  ];
  const defaultHomeModelPath = defaultModelPath(homeDir, fileName);
  if (defaultHomeModelPath !== candidates[0]) {
    candidates.push(defaultHomeModelPath);
  }
  if (modelId === "qwen35-4b-q4km") {
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.5-4B", "q4_k_m", "Qwen3.5-4B-Q4_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.5-4B", "q4_k_m", fileName),
      // Legacy unsloth locations remain as fallback only; new installs should use the Lynn imatrix artifact above.
      path.join(homeDir, "Models", "Lynn", "Qwen3.5-4B", "q4_k_m", "Qwen3.5-4B-Q4_K_M.gguf"),
      path.join(homeDir, "Models", "Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf"),
    );
  }
  if (modelId === "qwen35-9b-q4km-imatrix") {
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.5-9B", "q4_k_m", "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.5-9B", "q4_k_m", fileName),
    );
  }
  if (modelId === "qwen36-27b-dsv4pro-coding-q4-mtp" || modelId === "qwen36-27b-dsv4pro-distill-q5km-imatrix") {
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF", "Q4_LynnStyle", "Q4-imatrix-MTP-00001-of-00004.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF", "q4_lynnstyle", "Q4-imatrix-MTP-00001-of-00004.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B", "q4_lynnstyle", "Q4-imatrix-MTP-00001-of-00004.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF", "Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B-DSV4Pro-Thinking-Distill-GGUF", "q5_k_m", fileName),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-27B", "q5_k_m", fileName),
    );
  }
  if (modelId === "qwen36-35b-a3b-q4km-imatrix") {
    // Legacy Q4_K_M id: keep old file discovery so existing users do not need
    // to move files. New downloads map this id to the distilled Q4_K_M profile.
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", fileName),
    );
  }
  if (modelId === "qwen36-35b-a3b-dsv4pro-distill-q4km-imatrix" || modelId === "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix") {
    // Canonical high-end local file: DS-V4-Pro thinking-on distill. Keep the
    // older Q4 discovery paths so existing users do not need to move files.
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF", "Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF", "q5_k_m", fileName),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-lynn-prod-Q4_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill", "Qwen3.6-35B-A3B-lynn-prod-Q4_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill", "gguf", "Qwen3.6-35B-A3B-lynn-prod-Q4_K_M-imatrix.gguf"),
    );
  }
  if (modelId === "qwen36-35b-a3b-apex-mtp") {
    // Legacy APEX-MTP discovery only. The downloadable 35B profile now maps to
    // the distilled Q4_K_M artifact, but existing local files can still launch.
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "apex_mtp", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-APEX-MTP", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf"),
    );
  }
  return [...new Set(candidates)];
}

function removeBareFlag(args, flag) {
  return args.filter((arg) => arg !== flag);
}

function removeFlagsWithValues(args, flags) {
  const flagSet = new Set(flags);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (flagSet.has(args[i])) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function compactChildOutput(value, max = 4000) {
  const text = String(value || "").replace(/\0/g, "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(-max) : text;
}

// ─────────────────────────────────────────────────────────────
// LlamaCppManager
// ─────────────────────────────────────────────────────────────

class LlamaCppManager {
  constructor(opts = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts };
    this.child = null;
    this.healthTimer = null;
    this.stopped = false;
    this.startupFailed = false;
    this.restartCount = 0;
    this.consecutiveCrashes = 0;
    this.standby = false;
    this.activePort = null;
    this.lastHealthy = null;
    this.binaryPath = null;
    this.modelPath = null;
    this.state = { status: "idle" };
    this.onLog = opts.onLog || (() => {});
    this.onState = opts.onState || (() => {});
    // DI for tests
    this.spawnFn = opts.spawnFn || spawn;
    this.spawnSyncFn = opts.spawnSyncFn || spawnSync;
    this.httpModule = opts.httpModule || http;
    this.netModule = opts.netModule || net;
    this.fsModule = opts.fsModule || fs;
    this.homeDir = opts.homeDir || os.homedir();
    this.lynnHome = expandHomePath(opts.lynnHome, this.homeDir) || defaultLynnRoot(this.homeDir);
    this.platform = opts.platform || process.platform;
    this.resourcesPath = opts.resourcesPath != null ? opts.resourcesPath : (process.resourcesPath || "");
    this.envSkip = opts.envSkip
      ? () => opts.envSkip()
      : () => process.env.LYNN_SKIP_LLAMACPP === "1";
    // path overrides (env vars for dev / custom install)
    this.binaryOverride = opts.binaryPath || process.env.LYNN_LLAMACPP_BIN || null;
    this.modelOverride = opts.modelPath || process.env.LYNN_LLAMACPP_MODEL || null;
    this.lastChildOutput = "";
  }

  emitState(patch) {
    this.state = { ...this.state, ...patch, ts: Date.now() };
    try { this.onState(this.state); } catch {}
  }

  getStatus() {
    return {
      ...this.state,
      stopped: this.stopped,
      standby: this.standby,
      activePort: this.activePort,
      binaryPath: this.binaryPath,
      modelPath: this.modelPath,
      restartCount: this.restartCount,
      consecutiveCrashes: this.consecutiveCrashes,
      lastHealthy: this.lastHealthy,
    };
  }

  // ── 路径 / 存在性 ──

  resolveBinaryPath() {
    if (this.binaryOverride && this.fsModule.existsSync(this.binaryOverride)) {
      return this.binaryOverride;
    }
    const candidate = binaryPathForLynnRoot(this.lynnHome, this.platform);
    if (this.fsModule.existsSync(candidate)) return candidate;
    const bundledCandidate = bundledBinaryPath(this.resourcesPath, this.platform);
    if (bundledCandidate && this.fsModule.existsSync(bundledCandidate)) return bundledCandidate;
    for (const systemCandidate of systemBinaryCandidates(this.platform, this.spawnSyncFn)) {
      if (this.fsModule.existsSync(systemCandidate)) return systemCandidate;
    }
    return null;
  }

  resolveModelPath() {
    if (this.modelOverride && this.fsModule.existsSync(this.modelOverride)) {
      return this.modelOverride;
    }
    for (const candidate of legacyModelPathCandidates(this.homeDir, this.config.modelId, this.config.modelFileName, this.lynnHome)) {
      if (this.fsModule.existsSync(candidate)) return candidate;
    }
    return null;
  }

  // ── Port allocation ──

  async portInUse(port) {
    return new Promise((resolve) => {
      const tester = this.netModule.createServer()
        .once("error", () => resolve(true))
        .once("listening", () => {
          tester.close();
          resolve(false);
        })
        .listen(port, "127.0.0.1");
    });
  }

  async findFreePort() {
    let port = this.config.preferredPort;
    for (let i = 0; i < this.config.portRetryCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      const busy = await this.portInUse(port);
      if (!busy) return port;
      port += 1;
    }
    return null;
  }

  // ── Health probe ──

  probeHealth(port) {
    return new Promise((resolve) => {
      const req = this.httpModule.get(
        { host: "127.0.0.1", port, path: this.config.healthPath, timeout: this.config.healthTimeoutMs },
        (res) => {
          // llama-server /health returns 200 when loaded
          resolve(res.statusCode === 200);
          res.resume();
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  startHealthLoop() {
    if (this.healthTimer) return;
    const tick = async () => {
      if (this.stopped || this.startupFailed) return;
      const ok = await this.probeHealth(this.activePort);
      if (ok) {
        this.lastHealthy = Date.now();
        this.emitState({ status: this.standby ? "standby" : "ready", healthy: true });
      } else {
        this.emitState({ status: "unhealthy", healthy: false });
        if (!this.standby && !this.child) {
          this.onLog("warn", "[llamacpp] unhealthy + no child → schedule restart");
          this.scheduleRestart();
        }
      }
    };
    this.healthTimer = setInterval(tick, this.config.healthIntervalMs);
  }

  stopHealthLoop() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  scheduleRestart() {
    if (this.stopped || this.startupFailed) return;
    if (this.consecutiveCrashes >= this.config.maxConsecutiveCrashes) {
      this.onLog("error", `[llamacpp] consecutive crashes ${this.consecutiveCrashes} ≥ max ${this.config.maxConsecutiveCrashes}, giving up`);
      this.emitState({
        status: "failed",
        healthy: false,
        reason: "too-many-crashes",
        error: this.lastChildOutput || null,
      });
      return;
    }
    setTimeout(() => {
      if (!this.stopped && !this.startupFailed) void this.spawnServer();
    }, this.config.restartDelayMs);
  }

  // ── Server spawn ──

  binarySupportsFlag(flag) {
    // #34: cache --help output per-binary-path to avoid 50-200ms spawn on every server start
    if (!this._helpCache) this._helpCache = new Map();
    const cacheKey = this.binaryPath || "";
    let helpText = "";
    if (this._helpCache.has(cacheKey)) {
      helpText = this._helpCache.get(cacheKey) || "";
    } else {
      try {
        const out = spawnSync(cacheKey, ["--help"], { encoding: "utf8", timeout: 2500, windowsHide: true });
        helpText = `${out.stdout || ""}\n${out.stderr || ""}`;
        this._helpCache.set(cacheKey, helpText);
      } catch {
        this._helpCache.set(cacheKey, "");
        return false;
      }
    }
    return helpText.includes(flag);
  }

  buildServerArgs() {
    const args = [...this.config.serverArgs];
    let next = args;
    if (next.includes("--metrics") && !this.binarySupportsFlag("--metrics")) {
      this.onLog("warn", "[llamacpp] binary does not support --metrics; launching without metrics");
      next = removeBareFlag(next, "--metrics");
    }
    if (next.includes("--jinja") && !this.binarySupportsFlag("--jinja")) {
      this.onLog("warn", "[llamacpp] binary does not support --jinja; launching without explicit chat-template flag");
      next = removeBareFlag(next, "--jinja");
    }
    if (next.includes("--reasoning") && !this.binarySupportsFlag("--reasoning")) {
      this.onLog("warn", "[llamacpp] binary does not support --reasoning; launching without reasoning flag");
      next = removeFlagsWithValues(next, ["--reasoning"]);
    }
    if (next.includes("--reasoning-budget") && !this.binarySupportsFlag("--reasoning-budget")) {
      this.onLog("warn", "[llamacpp] binary does not support --reasoning-budget; launching without reasoning budget");
      next = removeFlagsWithValues(next, ["--reasoning-budget"]);
    }
    if (next.includes("--spec-type") && !this.binarySupportsFlag("--spec-type")) {
      this.onLog("warn", "[llamacpp] binary does not support --spec-type; launching without MTP draft decoding");
      next = removeFlagsWithValues(next, ["--spec-type", "--spec-draft-n-max"]);
    }
    if (next.includes("--cache-type-k") && !this.binarySupportsFlag("--cache-type-k")) {
      this.onLog("warn", "[llamacpp] binary does not support --cache-type-k; launching with default K cache");
      next = removeFlagsWithValues(next, ["--cache-type-k"]);
    }
    if (next.includes("--cache-type-v") && !this.binarySupportsFlag("--cache-type-v")) {
      this.onLog("warn", "[llamacpp] binary does not support --cache-type-v; launching with default V cache");
      next = removeFlagsWithValues(next, ["--cache-type-v"]);
    }
    return next;
  }

  async spawnServer() {
    if (this.stopped) return;
    if (this.child) {
      this.onLog("warn", "[llamacpp] spawnServer called but child already alive");
      return;
    }

    const port = await this.findFreePort();
    if (!port) {
      this.emitState({ status: "failed", reason: "no-free-port" });
      this.onLog("error", `[llamacpp] no free port near ${this.config.preferredPort}`);
      return;
    }
    this.activePort = port;

    const args = [
      "-m", this.modelPath,
      ...this.buildServerArgs(),
      "--port", String(port),
    ];

    this.lastChildOutput = "";
    this.onLog("info", `[llamacpp] spawn ${this.binaryPath} ${args.join(" ")}`);
    this.emitState({ status: "starting", port, args, reason: null, error: null, exitCode: null, exitSignal: null });

    try {
      this.child = this.spawnFn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
      });
    } catch (err) {
      this.onLog("error", `[llamacpp] spawn failed: ${err?.message || err}`);
      this.emitState({ status: "failed", reason: "spawn-error", error: String(err?.message || err) });
      this.child = null;
      this.consecutiveCrashes += 1;
      this.scheduleRestart();
      return;
    }

    const launchedChild = this.child;
    launchedChild.on("error", (error) => {
      if (this.child !== launchedChild) return;
      this.child = null;
      this.startupFailed = true;
      this.stopHealthLoop();
      this.emitState({ status: "failed", healthy: false, reason: "spawn-error", error: String(error?.message || error) });
    });
    if (this.child.stdout) {
      this.child.stdout.on("data", (buf) => {
        const s = buf.toString().trim();
        this.lastChildOutput = compactChildOutput(`${this.lastChildOutput}\n${s}`);
        if (s) this.onLog("info", `[llamacpp:stdout] ${s.split("\n").slice(-2).join(" | ")}`);
      });
    }
    if (this.child.stderr) {
      this.child.stderr.on("data", (buf) => {
        const s = buf.toString().trim();
        this.lastChildOutput = compactChildOutput(`${this.lastChildOutput}\n${s}`);
        if (s) this.onLog("info", `[llamacpp:stderr] ${s.split("\n").slice(-2).join(" | ")}`);
      });
    }
    launchedChild.on("exit", (code, sig) => {
      if (this.child !== launchedChild) return;
      this.onLog("warn", `[llamacpp] child exited code=${code} sig=${sig}`);
      this.child = null;
      if (this.stopped) {
        this.emitState({ status: "stopped", healthy: false });
        return;
      }
      this.emitState({
        status: "crashed",
        healthy: false,
        reason: "child-exited",
        error: this.lastChildOutput || null,
        exitCode: code,
        exitSignal: sig,
      });
      this.consecutiveCrashes += 1;
      if (!this.stopped) this.scheduleRestart();
    });

    // wait for /health 200 within startup timeout
    const t0 = Date.now();
    while (Date.now() - t0 < this.config.startupTimeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500));
      if (this.stopped || this.child !== launchedChild) return;
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.probeHealth(port);
      if (this.stopped || this.child !== launchedChild) return;
      if (ok) {
        this.consecutiveCrashes = 0;
        this.lastHealthy = Date.now();
        this.restartCount += 1;
        this.emitState({ status: "ready", healthy: true, port, reason: null, error: null });
        this.onLog("info", `[llamacpp] ready on port ${port} (after ${Date.now() - t0}ms)`);
        this.startHealthLoop();
        return;
      }
      if (!this.child) {
        this.onLog("warn", "[llamacpp] child died during startup");
        return;
      }
    }
    if (this.child !== launchedChild || this.stopped) return;
    this.startupFailed = true;
    this.stopHealthLoop();
    this.child = null;
    this.onLog("error", `[llamacpp] startup timeout ${this.config.startupTimeoutMs}ms`);
    this.emitState({
      status: "failed",
      healthy: false,
      reason: "startup-timeout",
      error: this.lastChildOutput || null,
    });
    try { launchedChild.kill("SIGTERM"); } catch {}
  }

  // ── Public API ──

  async start() {
    if (this.stopped) return;
    this.startupFailed = false;
    if (this.envSkip()) {
      this.emitState({ status: "disabled", reason: "env-skip" });
      this.onLog("info", "[llamacpp] LYNN_SKIP_LLAMACPP=1 → disabled");
      return;
    }

    // probe preferred port: external instance already serving?
    const externalOk = await this.probeHealth(this.config.preferredPort);
    if (externalOk) {
      this.standby = true;
      this.activePort = this.config.preferredPort;
      this.emitState({ status: "standby", reason: "external-instance", port: this.activePort });
      this.onLog("info", `[llamacpp] port ${this.activePort} already serving — manager standby + monitor`);
      this.startHealthLoop();
      return;
    }

    // resolve binary + model
    this.binaryPath = this.resolveBinaryPath();
    if (!this.binaryPath) {
      const candidate = binaryPathForLynnRoot(this.lynnHome, this.platform);
      this.emitState({ status: "needs-binary", expectedPath: candidate });
      this.onLog("warn", `[llamacpp] binary not found at ${candidate} — UI should trigger install`);
      return;
    }
    this.modelPath = this.resolveModelPath();
    if (!this.modelPath) {
      const candidate = lynnHomeModelPath(this.lynnHome, this.config.modelFileName);
      this.emitState({
        status: "needs-model",
        expectedPath: candidate,
        candidatePaths: legacyModelPathCandidates(this.homeDir, this.config.modelId, this.config.modelFileName, this.lynnHome),
        modelId: this.config.modelId,
      });
      this.onLog("warn", `[llamacpp] model not found at ${candidate} — UI should trigger download`);
      return;
    }
    this.onLog("info", `[llamacpp] binary=${this.binaryPath} model=${this.modelPath}`);
    await this.spawnServer();
  }

  async stop() {
    this.stopped = true;
    this.stopHealthLoop();
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch {}
      // SIGKILL fallback after 5s
      const c = this.child;
      setTimeout(() => {
        try { if (c && !c.killed) c.kill("SIGKILL"); } catch {}
      }, 5000);
      this.child = null;
    }
    this.emitState({ status: "stopped" });
  }
}

module.exports = {
  LlamaCppManager,
  defaultLynnRoot,
  defaultBinaryPath,
  bundledBinaryPath,
  defaultModelPath,
  lynnHomeModelPath,
  systemBinaryCandidates,
  DEFAULT_CONFIG,
};
