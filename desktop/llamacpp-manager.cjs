/**
 * llamacpp-manager.cjs · Lynn V0.79+ 2026-05-20
 *
 * 跨平台 llama.cpp local 推理服务守护(macOS / Windows / Linux 同源)。
 *
 * 背景:
 *   5/20 战略 pivot 后 Lynn 客户端默认本地推理底层 = llama.cpp。
 *   Mac Q4_K_M GGUF / Linux CUDA Q4_K_M / Win x64 CUDA Q4_K_M 全平台 ship。
 *   2026-05-28 更新: 默认 ship 模型使用新版 Qwen3.5-9B Q4_K_M imatrix MTP
 *     (5.78GB / 5.38GiB,DGX Spark 单流 36.61 → 60.95 TPS,24GB 显存/统一内存推荐)。
 *   4B Q4_K_M imatrix 保留为低配降级档,但 thinking-on 可能空正文长思考。
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

// ─────────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  // 默认 ship 模型 — Qwen3.5-9B Q4_K_M imatrix MTP,避免 4B thinking-on 空正文长思考。
  // 降级路径: 8~16G 设备可手动选 4B,但产品层会提示 thinking-on 风险。
  modelId: "qwen35-9b-q4km-imatrix",
  modelFileName: "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
  modelExpectedSize: 5_780_090_944, // 5.78 GB / 5.38 GiB
  // Product default: one comfortable 32K local slot. llama.cpp splits context
  // across parallel slots, so keep -np/--parallel at 1 for the local-first UX.
  serverArgs: [
    "--ctx-size", "32768",
    "--threads", "4",
    "--parallel", "1",
    "--n-gpu-layers", "999",
    "-a", "qwen35-9b-q4km-imatrix",
    "--jinja",
    "--spec-type", "draft-mtp",
    "--spec-draft-n-max", "4",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    // Keep thinking available for 9B; 4B downgrade is guarded elsewhere.
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

function defaultBinaryPath(homeDir, platform) {
  const root = defaultLynnRoot(homeDir);
  const binName = platform === "win32" ? "llama-server.exe" : "llama-server";
  return path.join(root, "llamacpp", "bin", binName);
}

function systemBinaryCandidates(platform) {
  if (platform === "win32") return [];
  const candidates = [
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  ];
  try {
    const resolved = spawnSync("which", ["llama-server"], { encoding: "utf8", timeout: 1000 });
    const fromPath = String(resolved.stdout || "").trim();
    if (fromPath) candidates.unshift(fromPath);
  } catch {
    // which is best-effort only; static candidates cover the common Mac/Linux paths.
  }
  return [...new Set(candidates)];
}

function defaultModelPath(homeDir, fileName) {
  return path.join(defaultLynnRoot(homeDir), "models", fileName);
}

function legacyModelPathCandidates(homeDir, modelId, fileName) {
  const candidates = [
    defaultModelPath(homeDir, fileName),
  ];
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
  if (modelId === "qwen36-35b-a3b-q4km-imatrix") {
    // Legacy Q4_K_M id: keep old file discovery so existing users do not need
    // to move files. New downloads map this id to the APEX-MTP profile.
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", fileName),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "apex_mtp", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-APEX-MTP", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
    );
  }
  if (modelId === "qwen36-35b-a3b-apex-mtp") {
    // 2026-05-28 canonical high-end local file: APEX-MTP I-Balanced.
    candidates.push(
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "apex_mtp", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B-APEX-MTP", "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf"),
      path.join(homeDir, "Models", "Lynn", "Qwen3.6-35B-A3B", "q4_k_m", "Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf"),
    );
  }
  return [...new Set(candidates)];
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
    this.httpModule = opts.httpModule || http;
    this.netModule = opts.netModule || net;
    this.fsModule = opts.fsModule || fs;
    this.homeDir = opts.homeDir || os.homedir();
    this.platform = opts.platform || process.platform;
    this.envSkip = opts.envSkip
      ? () => opts.envSkip()
      : () => process.env.LYNN_SKIP_LLAMACPP === "1";
    // path overrides (env vars for dev / custom install)
    this.binaryOverride = opts.binaryPath || process.env.LYNN_LLAMACPP_BIN || null;
    this.modelOverride = opts.modelPath || process.env.LYNN_LLAMACPP_MODEL || null;
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
    const candidate = defaultBinaryPath(this.homeDir, this.platform);
    if (this.fsModule.existsSync(candidate)) return candidate;
    for (const systemCandidate of systemBinaryCandidates(this.platform)) {
      if (this.fsModule.existsSync(systemCandidate)) return systemCandidate;
    }
    return null;
  }

  resolveModelPath() {
    if (this.modelOverride && this.fsModule.existsSync(this.modelOverride)) {
      return this.modelOverride;
    }
    for (const candidate of legacyModelPathCandidates(this.homeDir, this.config.modelId, this.config.modelFileName)) {
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
      if (this.stopped) return;
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
    if (this.stopped) return;
    if (this.consecutiveCrashes >= this.config.maxConsecutiveCrashes) {
      this.onLog("error", `[llamacpp] consecutive crashes ${this.consecutiveCrashes} ≥ max ${this.config.maxConsecutiveCrashes}, giving up`);
      this.emitState({ status: "failed", reason: "too-many-crashes" });
      return;
    }
    setTimeout(() => {
      if (!this.stopped) void this.spawnServer();
    }, this.config.restartDelayMs);
  }

  // ── Server spawn ──

  binarySupportsFlag(flag) {
    // #34: cache --help output per-binary-path to avoid 50-200ms spawn on every server start
    if (!this._helpCache) this._helpCache = new Map();
    const cached = this._helpCache.get(this.binaryPath);
    let helpText = cached;
    if (!helpText) {
      try {
        const out = spawnSync(this.binaryPath, ["--help"], { encoding: "utf8", timeout: 2500 });
        helpText = `${out.stdout || ""}\n${out.stderr || ""}`;
        this._helpCache.set(this.binaryPath, helpText);
      } catch {
        return false;
      }
    }
    return helpText.includes(flag);
  }

  buildServerArgs() {
    const args = [...this.config.serverArgs];
    let next = args;
    if (next.includes("--metrics") && !this.binarySupportsFlag("--metrics")) {
      next = next.filter((arg) => arg !== "--metrics");
    }
    if (next.includes("--reasoning-budget") && !this.binarySupportsFlag("--reasoning-budget")) {
      const out = [];
      for (let i = 0; i < next.length; i += 1) {
        if (next[i] === "--reasoning-budget") {
          i += 1;
          continue;
        }
        out.push(next[i]);
      }
      next = out;
    }
    if (next.includes("--spec-type") && !this.binarySupportsFlag("--spec-type")) {
      const out = [];
      for (let i = 0; i < next.length; i += 1) {
        if (next[i] === "--spec-type" || next[i] === "--spec-draft-n-max") {
          i += 1;
          continue;
        }
        out.push(next[i]);
      }
      next = out;
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

    this.onLog("info", `[llamacpp] spawn ${this.binaryPath} ${args.join(" ")}`);
    this.emitState({ status: "starting", port, args });

    try {
      this.child = this.spawnFn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      this.onLog("error", `[llamacpp] spawn failed: ${err?.message || err}`);
      this.emitState({ status: "failed", reason: "spawn-error", error: String(err?.message || err) });
      this.child = null;
      this.consecutiveCrashes += 1;
      this.scheduleRestart();
      return;
    }

    if (this.child.stdout) {
      this.child.stdout.on("data", (buf) => {
        const s = buf.toString().trim();
        if (s) this.onLog("info", `[llamacpp:stdout] ${s.split("\n").slice(-2).join(" | ")}`);
      });
    }
    if (this.child.stderr) {
      this.child.stderr.on("data", (buf) => {
        const s = buf.toString().trim();
        if (s) this.onLog("info", `[llamacpp:stderr] ${s.split("\n").slice(-2).join(" | ")}`);
      });
    }
    this.child.on("exit", (code, sig) => {
      this.onLog("warn", `[llamacpp] child exited code=${code} sig=${sig}`);
      this.child = null;
      this.emitState({ status: "crashed", exitCode: code, exitSignal: sig });
      this.consecutiveCrashes += 1;
      if (!this.stopped) this.scheduleRestart();
    });

    // wait for /health 200 within startup timeout
    const t0 = Date.now();
    while (Date.now() - t0 < this.config.startupTimeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500));
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.probeHealth(port);
      if (ok) {
        this.consecutiveCrashes = 0;
        this.lastHealthy = Date.now();
        this.restartCount += 1;
        this.emitState({ status: "ready", healthy: true, port });
        this.onLog("info", `[llamacpp] ready on port ${port} (after ${Date.now() - t0}ms)`);
        this.startHealthLoop();
        return;
      }
      if (!this.child) {
        this.onLog("warn", "[llamacpp] child died during startup");
        return;
      }
    }
    this.onLog("error", `[llamacpp] startup timeout ${this.config.startupTimeoutMs}ms`);
    this.emitState({ status: "failed", reason: "startup-timeout" });
    try { this.child?.kill("SIGTERM"); } catch {}
    this.child = null;
  }

  // ── Public API ──

  async start() {
    if (this.stopped) return;
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
      const candidate = defaultBinaryPath(this.homeDir, this.platform);
      this.emitState({ status: "needs-binary", expectedPath: candidate });
      this.onLog("warn", `[llamacpp] binary not found at ${candidate} — UI should trigger install`);
      return;
    }
    this.modelPath = this.resolveModelPath();
    if (!this.modelPath) {
      const candidate = defaultModelPath(this.homeDir, this.config.modelFileName);
      this.emitState({
        status: "needs-model",
        expectedPath: candidate,
        candidatePaths: legacyModelPathCandidates(this.homeDir, this.config.modelId, this.config.modelFileName),
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
  defaultModelPath,
  DEFAULT_CONFIG,
};
