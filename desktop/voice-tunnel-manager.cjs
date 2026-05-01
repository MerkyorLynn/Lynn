/**
 * voice-tunnel-manager.cjs · Lynn V0.79+ 2026-05-01
 *
 * 跨平台 voice 服务 SSH tunnel 守护(macOS / Windows / Linux 同源)。
 *
 * 背景:
 *   Lynn voice 服务(Qwen3-ASR :18007 / emotion2vec+ :18008 / SenseVoice :18020 /
 *   CosyVoice 2 :18021)在 DGX 内网,通过 brain Tencent frps 反向暴露。Lynn 客户端
 *   需要 ssh -L 把这 4 个 brain 端口映射到本地 127.0.0.1。
 *
 *   macOS:已有 launchd `com.lynn.spark-asr-tunnel` + `lynn-voice-tunnel-watchdog.sh`
 *          24/7 守护 ssh tunnel,Lynn 关着也保持。
 *   Windows / Linux:无现成机制,Lynn 装上 voice 直接连不通 → Overlay "主链异常"。
 *
 * 本模块策略:
 *   1. 启动时先 health probe 4 端口
 *      → 全 200:认定外部已守护(macOS launchd / 用户手动 ssh -L),进 standby
 *      → 任一不通:Lynn 自己 spawn ssh -L,跟 Lynn 生命周期绑(Lynn 退出 kill)
 *   2. Spawn 后监听 child exit → 5s 重启(指数回避前期保持简单线性)
 *   3. 周期 30s health probe;不健康且无 child → 重 spawn
 *   4. SSH config 不存在 / 没 Host dgx → 直接 disabled,不阻塞 Lynn 启动
 *   5. ENV `LYNN_SKIP_VOICE_TUNNEL=1` 完全禁用(给 dev / 不需要 voice 的部署)
 *
 * 合规:memory feedback_no_tunneling_tools.md 严禁 frpc/ngrok/cloudflared,但**标准
 *      ssh 是允许的**(memory session_0426 注解)。本模块 spawn 系统 ssh / ssh.exe,
 *      不引入第三方隧道工具。
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const DEFAULT_CONFIG = Object.freeze({
  // SSH host alias —— 用户的 ~/.ssh/config 必须有 `Host dgx ...`
  sshHost: "dgx",
  // [localPort, remoteHost, remotePort]
  forwards: [
    [18007, "127.0.0.1", 18007], // Qwen3-ASR (V0.79)
    [18008, "127.0.0.1", 18008], // emotion2vec+ (V0.79)
    [18020, "127.0.0.1", 8004], // SenseVoice (V0.78 fallback)
    [18021, "127.0.0.1", 8005], // CosyVoice 2 TTS
  ],
  healthPorts: [18007, 18008, 18020, 18021],
  healthIntervalMs: 30000,
  healthTimeoutMs: 3000,
  restartDelayMs: 5000,
});

class VoiceTunnelManager {
  constructor(opts = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts };
    this.child = null;
    this.healthTimer = null;
    this.stopped = false;
    this.restartCount = 0;
    this.standby = false;
    this.lastHealthy = null;
    this.onLog = opts.onLog || (() => {});
    this.onState = opts.onState || (() => {});
    // DI hooks for tests
    this.spawnFn = opts.spawnFn || spawn;
    this.httpModule = opts.httpModule || http;
    this.fsModule = opts.fsModule || fs;
    this.envSkip = opts.envSkip
      ? () => opts.envSkip()
      : () => process.env.LYNN_SKIP_VOICE_TUNNEL === "1";
    this.homeDir = opts.homeDir || os.homedir();
    this.platform = opts.platform || process.platform;
  }

  async start() {
    if (this.stopped) return;
    if (this.envSkip()) {
      this.emitState({ status: "disabled", reason: "env-skip" });
      this.onLog("info", "[voice-tunnel] LYNN_SKIP_VOICE_TUNNEL=1 → disabled");
      return;
    }
    if (!this.hasSshConfig()) {
      this.emitState({ status: "disabled", reason: "no-ssh-config" });
      this.onLog(
        "warn",
        `[voice-tunnel] ~/.ssh/config 缺 Host ${this.config.sshHost} → disabled`,
      );
      return;
    }
    // 先 probe — 已有外部守护(macOS launchd / 用户手动)就让位
    const initiallyHealthy = await this.allHealthy();
    if (initiallyHealthy) {
      this.standby = true;
      this.emitState({ status: "standby", reason: "external-watchdog" });
      this.onLog(
        "info",
        "[voice-tunnel] 4 ports already healthy — assume external watchdog (Mac launchd?). Manager standby + monitor only.",
      );
      this.startHealthLoop();
      return;
    }
    this.standby = false;
    this.spawnChild();
    this.startHealthLoop();
  }

  hasSshConfig() {
    const cfg = path.join(this.homeDir, ".ssh", "config");
    if (!this.fsModule.existsSync(cfg)) return false;
    try {
      const text = this.fsModule.readFileSync(cfg, "utf-8");
      // 匹配 `Host xxx dgx yyy` 或 `Host dgx`(不区分大小写)
      const re = new RegExp(`^\\s*Host\\b[^\\n]*\\b${this.escapeRegex(this.config.sshHost)}\\b`, "im");
      return re.test(text);
    } catch {
      return false;
    }
  }

  escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  spawnChild() {
    if (this.child) return;
    const sshBin = this.platform === "win32" ? "ssh.exe" : "ssh";
    const args = [
      "-N",
      "-F",
      path.join(this.homeDir, ".ssh", "config"),
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ControlMaster=no",
    ];
    for (const [local, host, remote] of this.config.forwards) {
      args.push("-L", `127.0.0.1:${local}:${host}:${remote}`);
    }
    args.push(this.config.sshHost);
    this.onLog("info", `[voice-tunnel] spawn: ${sshBin} ${args.join(" ")}`);
    let child;
    try {
      child = this.spawnFn(sshBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.onLog("error", `[voice-tunnel] spawn threw: ${err?.message || err}`);
      this.emitState({ status: "spawn-error", error: err?.message || String(err) });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.emitState({ status: "starting", pid: child.pid });
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        this.onLog("debug", `[voice-tunnel:stdout] ${String(chunk).trim()}`);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        this.onLog("debug", `[voice-tunnel:stderr] ${String(chunk).trim()}`);
      });
    }
    child.once("exit", (code, signal) => {
      this.onLog("warn", `[voice-tunnel] ssh child exit code=${code} signal=${signal}`);
      this.child = null;
      if (this.stopped) return;
      this.restartCount += 1;
      this.emitState({ status: "reconnecting", restartCount: this.restartCount });
      this.scheduleRestart();
    });
    child.once("error", (err) => {
      this.onLog("error", `[voice-tunnel] child error: ${err?.message || err}`);
      this.emitState({ status: "spawn-error", error: err?.message || String(err) });
    });
  }

  scheduleRestart() {
    if (this.stopped) return;
    setTimeout(() => {
      if (this.stopped || this.child) return;
      this.spawnChild();
    }, this.config.restartDelayMs);
  }

  startHealthLoop() {
    if (this.healthTimer) return;
    const tick = async () => {
      if (this.stopped) return;
      const ok = await this.allHealthy();
      this.lastHealthy = ok;
      this.emitState({ status: ok ? "healthy" : "unhealthy", standby: this.standby });
      if (!ok && !this.standby && !this.child) {
        this.onLog("warn", "[voice-tunnel] unhealthy + no child running — respawning");
        this.spawnChild();
      }
      // standby 模式下,如果外部守护挂了(任一端口 down),Lynn 接管
      if (!ok && this.standby) {
        this.onLog(
          "warn",
          "[voice-tunnel] standby external watchdog appears down — taking over with Lynn-managed tunnel",
        );
        this.standby = false;
        this.spawnChild();
      }
    };
    this.healthTimer = setInterval(tick, this.config.healthIntervalMs);
    // 首次立即跑一次,但不要阻塞 start()
    void tick();
  }

  async allHealthy() {
    for (const port of this.config.healthPorts) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.healthOne(port);
      if (!ok) return false;
    }
    return true;
  }

  healthOne(port) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const req = this.httpModule.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            timeout: this.config.healthTimeoutMs,
          },
          (res) => {
            const code = res.statusCode || 0;
            res.resume();
            finish(code >= 200 && code < 400);
          },
        );
        req.on("error", () => finish(false));
        req.on("timeout", () => {
          try { req.destroy(); } catch { /* ignore */ }
          finish(false);
        });
      } catch {
        finish(false);
      }
    });
  }

  emitState(state) {
    try {
      this.onState({ ...state, ts: Date.now() });
    } catch (err) {
      this.onLog("error", `[voice-tunnel] onState handler threw: ${err?.message || err}`);
    }
  }

  /** 获取当前状态(供 IPC 上报) */
  getStatus() {
    return {
      stopped: this.stopped,
      standby: this.standby,
      hasChild: !!this.child,
      restartCount: this.restartCount,
      lastHealthy: this.lastHealthy,
    };
  }

  stop() {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    this.emitState({ status: "stopped" });
  }
}

module.exports = { VoiceTunnelManager, DEFAULT_CONFIG };
