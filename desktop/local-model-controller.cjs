const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { LlamaCppManager } = require("./llamacpp-manager.cjs");
const { ModelDownloader } = require("./model-downloader.cjs");
const {
  MODEL_DOWNLOADER_SOURCES,
  buildLlamacppArgsForAlias,
  decorateDownloadState,
  listLlamacppDownloadProfiles,
  resolveLlamacppDownloadProfile,
} = require("./llamacpp-profiles.cjs");

function createLocalModelController(deps) {
  const {
    BrowserWindow,
    shell,
    wrapIpcHandler,
    lynnHome,
    canReadPath,
    grantWebContentsAccess,
    resolveCanonicalPath,
    isPathInsideRoot,
  } = deps;

// ─────────────────────────────────────────────────────────────
// llama.cpp local inference runtime(2026-05-20). It is now strictly opt-in:
// querying state and downloading models must not claim VRAM until the user
// explicitly starts a local GGUF.
//   - 找 ~/.lynn/llamacpp/bin/llama-server[.exe] + ~/.lynn/models/<default>.gguf
//   - 任一缺 → emit needs-binary / needs-model state,UI 触发 Phase 2 download
//   - spawn + 健康监控 + crash auto-restart,跟 Lynn 生命周期绑
//   - ENV LYNN_SKIP_LLAMACPP=1 → 完全禁用
//   - LYNN_LLAMACPP_BIN / LYNN_LLAMACPP_MODEL 可覆盖路径(dev / 自定义安装)
let llamacpp = null;
let lastLlamacppState = { status: "idle" };
let activeModelDownloader = null;
let lastModelDownloadState = { state: "idle" };

const LOCAL_MODEL_IPC = Object.freeze({
  state: "llamacpp:state",
  stop: "llamacpp:stop",
  startDownload: "llamacpp:start-download",
  pauseDownload: "llamacpp:pause-download",
  cancelDownload: "llamacpp:cancel-download",
  sources: "llamacpp:sources",
  openModelDir: "llamacpp:open-model-dir",
  startCustomModel: "llamacpp:start-custom-model",
  downloadProgress: "llamacpp:download-progress",
  downloadState: "llamacpp:download-state",
});

function ipcOk(payload = {}) {
  return { ok: true, ...payload };
}

function ipcError(reason, payload = {}) {
  return { ok: false, reason: String(reason || "unknown-error"), ...payload };
}

function parseStartDownloadPayload(payload) {
  if (payload == null) return { ok: true, modelId: undefined, startAfterDownload: false };
  if (typeof payload === "string") {
    const modelId = payload.trim();
    const parsed = modelId ? validateLocalModelId(modelId) : { ok: true, modelId: undefined };
    return parsed.ok === false ? parsed : { ...parsed, startAfterDownload: false };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ipcError("invalid-payload");
  }
  const startAfterDownload = payload.startAfterDownload === true || process.env.LYNN_LOCAL_MODEL_AUTO_START === "1";
  if (payload.modelId == null) return { ok: true, modelId: undefined, startAfterDownload };
  if (typeof payload.modelId !== "string") return ipcError("invalid-model-id");
  const modelId = payload.modelId.trim();
  const parsed = modelId ? validateLocalModelId(modelId) : { ok: true, modelId: undefined };
  return parsed.ok === false ? parsed : { ...parsed, startAfterDownload };
}

function validateLocalModelId(modelId) {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(modelId)) return ipcError("invalid-model-id");
  return { ok: true, modelId };
}

function parseGgufModelPathPayload(payload, key = "modelPath") {
  const rawPath = typeof payload === "string" ? payload : payload?.[key];
  if (typeof rawPath !== "string" || !rawPath.trim()) return ipcError("missing-model-path");
  if (rawPath.includes("\0")) return ipcError("invalid-model-path");
  const modelPath = path.resolve(rawPath);
  if (path.extname(modelPath).toLowerCase() !== ".gguf") return ipcError("not-gguf");
  return { ok: true, modelPath };
}

function getAllowedLocalModelDirs() {
  return [path.join(lynnHome, "models"), path.join(os.homedir(), "Models", "Lynn")];
}

function isLocalModelPathAllowed(event, modelPath) {
  const canonical = resolveCanonicalPath(modelPath);
  if (!canonical) return false;
  if (getAllowedLocalModelDirs().some((root) => isPathInsideRoot(canonical, root))) return true;
  return canReadPath(event?.sender, canonical).allowed;
}

function broadcastToAllWindows(channel, payload) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  } catch (err) {
    console.warn(`[broadcast:${channel}]`, err?.message || err);
  }
}

function setLlamacppFailureState(reason, patch = {}) {
  lastLlamacppState = {
    ...(lastLlamacppState || {}),
    ...patch,
    status: "failed",
    healthy: false,
    reason: String(reason || "unknown-error"),
    ts: Date.now(),
  };
  broadcastToAllWindows(LOCAL_MODEL_IPC.state, lastLlamacppState);
}

function startLlamacpp() {
  if (llamacpp) return;
  try {
    llamacpp = new LlamaCppManager({
      onLog: (level, msg) => {
        if (level === "error") console.error(msg);
        else if (level === "warn") console.warn(msg);
        else console.log(msg);
      },
      onState: (state) => {
        lastLlamacppState = state;
        broadcastToAllWindows(LOCAL_MODEL_IPC.state, state);
      },
    });
    void llamacpp.start();
  } catch (err) {
    const reason = err?.message || err;
    console.warn("[llamacpp] start failed:", reason);
    llamacpp = null;
    setLlamacppFailureState(reason);
  }
}

async function startLlamacppCustomModel(modelPath) {
  const rawAlias = path.basename(modelPath, path.extname(modelPath)).slice(0, 80) || "local-gguf";
  const launchProfile = buildLlamacppArgsForAlias(rawAlias, modelPath);
  const modelAlias = launchProfile.alias;
  try { stopLlamacpp(); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 700));
  lastLlamacppState = {
    status: "starting",
    modelId: modelAlias,
    modelPath,
    customModel: true,
    ts: Date.now(),
  };
  broadcastToAllWindows(LOCAL_MODEL_IPC.state, lastLlamacppState);
  try {
    llamacpp = new LlamaCppManager({
      modelId: modelAlias,
      modelFileName: path.basename(modelPath),
      modelPath,
      serverArgs: launchProfile.args,
      onLog: (level, msg) => {
        if (level === "error") console.error(msg);
        else if (level === "warn") console.warn(msg);
        else console.log(msg);
      },
      onState: (state) => {
        lastLlamacppState = { ...state, modelId: modelAlias, modelPath, customModel: true };
        broadcastToAllWindows(LOCAL_MODEL_IPC.state, lastLlamacppState);
      },
    });
    void llamacpp.start();
    return ipcOk({ modelId: modelAlias, modelPath });
  } catch (err) {
    const reason = err?.message || err;
    llamacpp = null;
    setLlamacppFailureState(reason, { modelId: modelAlias, modelPath, customModel: true });
    throw err;
  }
}
function stopLlamacpp() {
  if (!llamacpp) return;
  try { llamacpp.stop(); } catch (err) {
    console.warn("[llamacpp] stop failed:", err?.message || err);
  }
  llamacpp = null;
}
// Legacy channel kept for backward compat.
wrapIpcHandler("llamacpp-status", () => (llamacpp ? llamacpp.getStatus() : { stopped: true }));

// New unified state channel — returns latest cached llamacpp manager state
// plus pending downloader state so renderer can hydrate in one round-trip.
wrapIpcHandler(LOCAL_MODEL_IPC.state, () => ({
  manager: llamacpp ? llamacpp.getStatus() : { ...lastLlamacppState, stopped: true },
  download: { ...lastModelDownloadState },
}));

wrapIpcHandler(LOCAL_MODEL_IPC.stop, async () => {
  try {
    stopLlamacpp();
    lastLlamacppState = {
      ...(lastLlamacppState || {}),
      status: "stopped",
      stopped: true,
      healthy: false,
      ts: Date.now(),
    };
    broadcastToAllWindows(LOCAL_MODEL_IPC.state, lastLlamacppState);
    return ipcOk();
  } catch (err) {
    return ipcError(err?.message || err);
  }
});

// Trigger model download. Returns immediately; progress streams via
// LOCAL_MODEL_IPC.downloadProgress / LOCAL_MODEL_IPC.downloadState channels.
wrapIpcHandler(LOCAL_MODEL_IPC.startDownload, async (event, payload = {}) => {
  const parsedPayload = parseStartDownloadPayload(payload);
  if (!parsedPayload.ok) return parsedPayload;
  const resolvedProfile = resolveLlamacppDownloadProfile(parsedPayload.modelId);
  if (!resolvedProfile.known) {
    return ipcError("unknown-model-id", {
      modelId: resolvedProfile.requestedModelId,
      availableModelIds: listLlamacppDownloadProfiles().map((profile) => profile.modelId),
    });
  }
  const profile = resolvedProfile.profile;
  if (activeModelDownloader && (lastModelDownloadState.state === "downloading"
      || lastModelDownloadState.state === "verifying")) {
    const runningModelId = lastModelDownloadState.modelId || "qwen35-9b-q4km-imatrix";
    const payload = {
      alreadyRunning: true,
      modelId: runningModelId,
      target: lastModelDownloadState.target,
    };
    return runningModelId === profile.modelId
      ? ipcOk(payload)
      : ipcError("another-download-running", payload);
  }
  const target = path.join(lynnHome, "models", profile.fileName);

  // #5: disk-space precheck — refuse to start if free space < expectedSize × 1.1 (account for .part + final)
  if (profile.expectedSize && profile.expectedSize > 0) {
    try {
      const modelsDir = path.dirname(target);
      try { fs.mkdirSync(modelsDir, { recursive: true }); } catch {}
      const stat = (fs.statfsSync || fs.statfs)?.(modelsDir);
      if (stat) {
        const free = Number(stat.bavail) * Number(stat.bsize);
        const need = Number(profile.expectedSize) * 1.1;
        if (Number.isFinite(free) && free < need) {
          const freeGB = (free / 1024 / 1024 / 1024).toFixed(2);
          const needGB = (need / 1024 / 1024 / 1024).toFixed(2);
          return ipcError("insufficient-disk-space", {
            detail: `Need ~${needGB} GB free in ${modelsDir}, have ${freeGB} GB. Free up space and retry.`,
            modelId: profile.modelId,
            target,
          });
        }
      }
    } catch (err) {
      // statfs unavailable on some platforms — best-effort, fall through
      console.warn("[disk-precheck] failed:", err?.message || err);
    }
  }

  let downloader;
  try {
    downloader = new ModelDownloader({
      target,
      fileName: profile.fileName,
      expectedSize: profile.expectedSize,
      expectedSha256: profile.expectedSha256,
      sources: profile.sources,
      parallelSegments: profile.parallelSegments,
    });
  } catch (err) {
    return ipcError("download-boundary-invalid", {
      detail: String(err?.message || err),
      modelId: profile.modelId,
      target,
    });
  }
  activeModelDownloader = downloader;
  downloader.on("progress", (s) => {
    lastModelDownloadState = decorateDownloadState(profile, s);
    broadcastToAllWindows(LOCAL_MODEL_IPC.downloadProgress, lastModelDownloadState);
  });
  downloader.on("state", (s) => {
    lastModelDownloadState = decorateDownloadState(profile, s);
    broadcastToAllWindows(LOCAL_MODEL_IPC.downloadState, lastModelDownloadState);
  });
  downloader.on("log", (level, msg) => {
    if (level === "error") console.error(msg);
    else if (level === "warn") console.warn(msg);
    else console.log(msg);
  });
  // fire-and-forget; resolve completion drives llamacpp restart
  downloader.start().then((result) => {
    if (result?.ok) {
      const doneState = decorateDownloadState(profile, { ...downloader.getState(), state: "done", target });
      lastModelDownloadState = doneState;
      broadcastToAllWindows(LOCAL_MODEL_IPC.downloadState, doneState);
      if (parsedPayload.startAfterDownload || profile.autoStart) {
        // Explicit local model startup — bounce llamacpp so it picks the model up.
        // #18: 1500ms conservative wait (was 600ms) + port-busy probe before spawn.
        // Manager.stop() SIGTERMs the child but only SIGKILLs after 5s;
        // we wait long enough for the typical clean exit, then verify the bind port is free
        // (lets the old child finish flushing). If port still busy, manager's own retry kicks in.
        try { stopLlamacpp(); } catch {}
        const probeAndStart = () => {
          const net = require('net');
          const probe = net.createConnection({ port: 18099, host: '127.0.0.1' });
          let settled = false;
          probe.once('error', () => { if (settled) return; settled = true; probe.destroy(); try { startLlamacpp(); } catch {} });
          probe.once('connect', () => { if (settled) return; settled = true; probe.end(); setTimeout(probeAndStart, 500); });
          setTimeout(() => { if (settled) return; settled = true; probe.destroy(); try { startLlamacpp(); } catch {} }, 800);
        };
        setTimeout(probeAndStart, 1500);
      }
    }
    if (activeModelDownloader === downloader) activeModelDownloader = null;
  }).catch((err) => {
    console.warn("[model-downloader] failed:", err?.message || err);
    if (activeModelDownloader === downloader) activeModelDownloader = null;
  });
  return ipcOk({ alreadyRunning: false, modelId: profile.modelId, target, parallelSegments: profile.parallelSegments });
});

wrapIpcHandler(LOCAL_MODEL_IPC.pauseDownload, () => {
  if (!activeModelDownloader) return ipcError("not-running");
  try { activeModelDownloader.pause(); } catch (err) {
    return ipcError(err?.message || err);
  }
  return ipcOk();
});

wrapIpcHandler(LOCAL_MODEL_IPC.cancelDownload, () => {
  if (!activeModelDownloader) {
    lastModelDownloadState = { state: "idle" };
    return ipcOk({ alreadyIdle: true });
  }
  try { activeModelDownloader.cancel(); } catch (err) {
    return ipcError(err?.message || err);
  }
  activeModelDownloader = null;
  return ipcOk();
});

wrapIpcHandler(LOCAL_MODEL_IPC.sources, () => ({
  ok: true,
  sources: MODEL_DOWNLOADER_SOURCES.map((s) => ({ id: s.id, label: s.label })),
  models: listLlamacppDownloadProfiles().map((profile) => ({
      modelId: profile.modelId,
      label: profile.label,
      fileName: profile.fileName,
      expectedSize: profile.expectedSize,
      parallelSegments: profile.parallelSegments,
      sources: profile.sources.map((s) => ({ id: s.id, label: s.label })),
    })),
}));

wrapIpcHandler(LOCAL_MODEL_IPC.openModelDir, async (event, payload = {}) => {
  const dir = path.join(lynnHome, "models");
  const userModelDir = path.join(os.homedir(), "Models", "Lynn");
  const allowedModelDirs = getAllowedLocalModelDirs();
  const isInside = (root, target) => {
    const relative = path.relative(root, target);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { fs.mkdirSync(userModelDir, { recursive: true }); } catch {}
  const rawTarget = typeof payload === "string" ? payload : payload?.targetPath;
  if (typeof rawTarget === "string" && rawTarget.trim()) {
    const target = path.resolve(rawTarget);
    const isSafeModelFile = path.extname(target).toLowerCase() === ".gguf"
      && allowedModelDirs.some((root) => isInside(root, target));
    if (isSafeModelFile && fs.existsSync(target)) {
      shell.showItemInFolder(target);
      return { ok: true, path: path.dirname(target), revealedPath: target, error: null };
    }
  }
  // Open Lynn's managed model library first so users immediately see the 9B/35B
  // files downloaded by the app. User-provided folders remain available through
  // the native GGUF picker.
  const openDir = dir;
  const error = await shell.openPath(openDir);
  return { ok: !error, path: openDir, error: error || null };
});

wrapIpcHandler(LOCAL_MODEL_IPC.startCustomModel, async (event, payload = {}) => {
  const parsedPath = parseGgufModelPathPayload(payload);
  if (!parsedPath.ok) return parsedPath;
  const { modelPath } = parsedPath;
  if (!fs.existsSync(modelPath)) {
    return ipcError("model-not-found");
  }
  if (!isLocalModelPathAllowed(event, modelPath)) {
    return ipcError("model-path-not-allowed", {
      detail: "Choose the GGUF through Lynn's file picker or place it in the local model directory.",
    });
  }
  grantWebContentsAccess(event.sender, modelPath, "read");
  try {
    return await startLlamacppCustomModel(modelPath);
  } catch (err) {
    return ipcError(err?.message || err);
  }
});

function stopManagedQwen35LlamaServer() {
  const pidFiles = [
    path.join(os.homedir(), ".lynn-engine", "run", "qwen35-4b-q4km.pid"),
    path.join(os.homedir(), ".lynn-engine", "run", "qwen35-9b-q4km-imatrix.pid"),
  ];
  const pids = new Set();
  for (const pidFile of pidFiles) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    } catch {}
  }
  // #19: ps grep narrowed to Lynn-managed model paths only (was matching any --port 18099)
  // Match the bootstrap-spawned llama-server by model file path under ~/Models/Lynn/
  // or the lynn-engine run dir convention. Prevents accidentally killing user's other llama-server.
  const lynnModelsDir = path.join(os.homedir(), "Models", "Lynn");
  const lynnEngineDir = path.join(os.homedir(), ".lynn-engine");
  try {
    const stdout = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 512 * 1024,
    });
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cmd = match[2] || "";
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!/llama-server\b/.test(cmd)) continue;
      // Require BOTH a Lynn-owned path indicator or known Lynn local model hint.
      const isLynnOwned =
        cmd.includes(lynnModelsDir)
        || cmd.includes(lynnEngineDir)
        || /qwen35-4b-q4km/i.test(cmd)
        || /qwen35-9b-q4km/i.test(cmd)
        || /Qwen3\.5-4B-Q4_K_M/i.test(cmd)
        || /Qwen3\.5-9B-Q4_K_M/i.test(cmd);
      if (isLynnOwned && cmd.includes("--port 18099")) {
        pids.add(pid);
      }
    }
  } catch {}
  if (pids.size === 0) {
    for (const pidFile of pidFiles) {
      try { fs.rmSync(pidFile, { force: true }); } catch {}
    }
    return;
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => {
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
  }, 5000);
  for (const pidFile of pidFiles) {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }
}



  function markExplicitStartRequired() {
    lastLlamacppState = {
      status: "stopped",
      stopped: true,
      healthy: false,
      reason: "explicit-start-required",
      ts: Date.now(),
    };
    console.log("[llamacpp] startup auto-start disabled; waiting for explicit user action");
  }

  function emitResumeHint() {
    try {
      const modelsDir = path.join(lynnHome, "models");
      const partFiles = (fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : [])
        .filter((f) => f.endsWith(".part"));
      if (partFiles.length > 0) {
        const stats = partFiles.map((f) => {
          try {
            const s = fs.statSync(path.join(modelsDir, f));
            return { fileName: f, size: s.size, mtimeMs: s.mtimeMs };
          } catch { return null; }
        }).filter(Boolean);
        setImmediate(() => {
          broadcastToAllWindows("llamacpp:resume-hint", { partFiles: stats });
        });
      }
    } catch (err) {
      console.warn("[resume-hint] check failed:", err?.message || err);
    }
  }

  return {
    start: startLlamacpp,
    stop: stopLlamacpp,
    stopManagedQwen35LlamaServer,
    markExplicitStartRequired,
    emitResumeHint,
  };
}

module.exports = { createLocalModelController };
