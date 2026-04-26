/**
 * auto-updater.cjs — 跨平台自动更新
 *
 * 两条通道:
 * 1. 手写 manifest 做版本检测(.github/update-manifest.json),不依赖 GitHub REST API
 * 2. electron-updater 接管下载+安装(需要 yml 文件存在)
 *
 * 当 native 下载/安装失败(dev 环境、yml 未发布等)自动回退到浏览器跳转。
 * beta 开关读 preferences.update_channel,通过 IPC 传入。
 */
const { ipcMain, shell } = require("electron");
const { app } = require("electron");

let _autoUpdater = null;
try {
  _autoUpdater = require("electron-updater").autoUpdater;
  _autoUpdater.autoDownload = false;
  _autoUpdater.autoInstallOnAppQuit = false;
  _autoUpdater.logger = null;
} catch (err) {
  console.warn("[auto-updater] electron-updater unavailable, fallback only:", err?.message);
}

let _mainWindow = null;
let _updateChannel = "stable"; // "stable" | "beta"
let _nativeWired = false;

let _updateState = {
  status: "idle",      // idle | checking | available | downloading | downloaded | error | latest
  version: null,
  releaseNotes: null,
  releaseUrl: null,     // GitHub release page URL
  downloadUrl: null,    // direct download URL (asset)
  progress: null,       // { percent, bytesPerSecond, transferred, total }
  error: null,
};

function getState() {
  return { ..._updateState };
}

function sendToRenderer(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

function setState(patch) {
  Object.assign(_updateState, patch);
  sendToRenderer("auto-update-state", getState());
}

function resetState() {
  _updateState = {
    status: "idle", version: null, releaseNotes: null,
    releaseUrl: null, downloadUrl: null, progress: null, error: null,
  };
}

function wireNativeUpdater() {
  if (_nativeWired || !_autoUpdater) return;
  _nativeWired = true;

  _autoUpdater.on("download-progress", (info) => {
    setState({
      status: "downloading",
      progress: {
        percent: info?.percent || 0,
        bytesPerSecond: info?.bytesPerSecond || 0,
        transferred: info?.transferred || 0,
        total: info?.total || 0,
      },
    });
  });

  _autoUpdater.on("update-downloaded", (info) => {
    setState({
      status: "downloaded",
      version: info?.version || _updateState.version,
    });
  });

  _autoUpdater.on("error", (err) => {
    console.warn("[auto-updater] native error:", err?.message || err);
  });
}

async function tryNativeDownload() {
  if (!_autoUpdater || !app.isPackaged) return false;
  try {
    wireNativeUpdater();
    const result = await _autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) return false;
    setState({ status: "downloading", progress: { percent: 0 } });
    await _autoUpdater.downloadUpdate();
    return true;
  } catch (err) {
    console.warn("[auto-updater] native download failed, falling back:", err?.message || err);
    return false;
  }
}

// ── 版本比较 ──
function isNewerVersion(latest, current) {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ══════════════════════════════════════
// 静态更新清单（所有平台共用）
// ══════════════════════════════════════
const REPO_BASE_URL = "https://github.com/MerkyorLynn/Lynn";
const UPDATE_MANIFEST_URLS = [
  "https://raw.githubusercontent.com/MerkyorLynn/Lynn/main/.github/update-manifest.json",
  "https://cdn.jsdelivr.net/gh/MerkyorLynn/Lynn@main/.github/update-manifest.json",
];

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/, "");
}

function buildReleaseUrl(version) {
  return `${REPO_BASE_URL}/releases/tag/v${version}`;
}

function buildReleaseDownloadBase(version) {
  return `${REPO_BASE_URL}/releases/download/v${version}`;
}

function getConventionalAssetName(version) {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return `Lynn-${version}-macOS-Apple-Silicon.dmg`;
    if (process.arch === "x64") return `Lynn-${version}-macOS-Intel.dmg`;
  }
  if (process.platform === "win32") {
    return `Lynn-${version}-Windows-Setup.exe`;
  }
  return null;
}

function getAssetOverride(release) {
  const assets = release?.assets;
  if (!assets || typeof assets !== "object") return null;
  const key = `${process.platform}-${process.arch}`;
  const candidates = [key, process.platform, process.arch, "default"];
  for (const name of candidates) {
    const value = assets[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickManifestRelease(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const stable = manifest.stable && typeof manifest.stable === "object"
    ? manifest.stable
    : manifest;
  if (_updateChannel === "beta") {
    return manifest.beta && typeof manifest.beta === "object"
      ? manifest.beta
      : stable;
  }
  return stable;
}

async function fetchUpdateManifest() {
  const cacheBust = `ts=${Date.now()}`;
  let lastError = null;

  for (const baseUrl of UPDATE_MANIFEST_URLS) {
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${cacheBust}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Lynn" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        lastError = `manifest ${res.status}`;
        continue;
      }
      const data = await res.json();
      if (data && typeof data === "object") return data;
      lastError = "manifest invalid";
    } catch (err) {
      lastError = err?.message || String(err);
    }
  }

  throw new Error(lastError || "update manifest unavailable");
}

async function checkUpdate() {
  setState({ status: "checking", error: null, version: null });
  try {
    const manifest = await fetchUpdateManifest();
    const release = pickManifestRelease(manifest);
    if (!release) {
      setState({ status: "latest" });
      return null;
    }
    const latest = normalizeVersion(release.version || release.tag || release.tag_name);
    const current = app.getVersion();
    if (!latest || !isNewerVersion(latest, current)) {
      setState({ status: "latest" });
      return null;
    }
    const releaseUrl = release.releaseUrl || release.html_url || buildReleaseUrl(latest);
    const assetOverride = getAssetOverride(release);
    const conventionalAssetName = getConventionalAssetName(latest);
    const downloadUrl = assetOverride
      || (conventionalAssetName ? `${buildReleaseDownloadBase(latest)}/${encodeURIComponent(conventionalAssetName)}` : null)
      || releaseUrl;

    setState({
      status: "available",
      version: latest,
      releaseNotes: release.notes || release.body || null,
      releaseUrl,
      downloadUrl,
    });
    return latest;
  } catch (err) {
    setState({ status: "error", error: err?.message || String(err) });
    return null;
  }
}

// ══════════════════════════════════════
// 公共 API
// ══════════════════════════════════════

function initAutoUpdater(mainWindow) {
  _mainWindow = mainWindow;

  ipcMain.handle("auto-update-check", async () => {
    resetState();
    return checkUpdate();
  });

  ipcMain.handle("auto-update-download", async () => {
    if (_updateState.status !== "available") return false;
    const nativeOk = await tryNativeDownload();
    if (nativeOk) return true;
    if (_updateState.downloadUrl) {
      shell.openExternal(_updateState.downloadUrl);
    }
    return true;
  });

  ipcMain.handle("auto-update-install", () => {
    if (_updateState.status === "downloaded" && _autoUpdater && app.isPackaged) {
      try {
        _autoUpdater.quitAndInstall();
        return;
      } catch (err) {
        console.warn("[auto-updater] quitAndInstall failed, falling back:", err?.message || err);
      }
    }
    if (_updateState.releaseUrl) {
      shell.openExternal(_updateState.releaseUrl);
    }
  });

  ipcMain.handle("auto-update-state", () => {
    return getState();
  });

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    setUpdateChannel(channel);
  });
}

async function checkForUpdatesAuto() {
  return checkUpdate();
}

function setUpdateChannel(channel) {
  _updateChannel = channel === "beta" ? "beta" : "stable";
  if (_autoUpdater) {
    _autoUpdater.allowPrerelease = _updateChannel === "beta";
  }
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { initAutoUpdater, checkForUpdatesAuto, setMainWindow, setUpdateChannel, getState };
