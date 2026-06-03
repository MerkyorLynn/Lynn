/**
 * Lynn Desktop — Electron 主进程
 *
 * 职责：
 * 1. 创建启动窗口（splash）
 * 2. spawn() 启动 Lynn Server
 * 3. 等待 server 就绪 + 主窗口初始化完成
 * 4. 关闭 splash，显示主窗口
 * 5. 优雅关闭
 */
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification, powerSaveBlocker } = require("electron");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const yaml = require("js-yaml");
const { initAutoUpdater, checkForUpdatesAuto, setMainWindow: setUpdaterMainWindow, setUpdateChannel } = require("./auto-updater.cjs");
const { setIpcSenderValidator, wrapIpcHandler, wrapIpcOn } = require('./ipc-wrapper.cjs');
const { normalizeConfiguredShortcut, registerFirstAvailableGlobalShortcut } = require("./shortcut-policy.cjs");
const { VoiceTunnelManager } = require("./voice-tunnel-manager.cjs");
const { LlamaCppManager } = require("./llamacpp-manager.cjs");
const { ModelDownloader } = require("./model-downloader.cjs");
const { getCliEnvStatus, getWorkerSpawnServerEnv } = require("./cli-env-manager.cjs");
const {
  MODEL_DOWNLOADER_SOURCES,
  buildLlamacppArgsForAlias,
  decorateDownloadState,
  listLlamacppDownloadProfiles,
  resolveLlamacppDownloadProfile,
} = require("./llamacpp-profiles.cjs");

// macOS/Linux: Electron 从 Dock/Finder 启动时 PATH 只有系统默认值，
// Homebrew、npm global 等路径全部丢失。用登录 shell 解析完整 PATH。
if (process.platform !== "win32") {
  try {
    const loginShell = process.env.SHELL || "/bin/zsh";
    const resolved = execFileSync(loginShell, ["-l", "-c", "printenv PATH"], {
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    if (resolved) process.env.PATH = resolved;
  } catch {}
}

function safeReadJSON(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (err) {
    console.error(`[safeReadJSON] ${filePath}: ${err.message}`);
    return fallback;
  }
}

const lynnHome = process.env.LYNN_HOME
  ? path.resolve(process.env.LYNN_HOME.replace(/^~/, os.homedir()))
  : process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".lynn");

// 按 LYNN_HOME 隔离 Electron userData（localStorage / cache / session）
// 生产: ~/Library/Application Support/Lynn
// 开发: ~/Library/Application Support/Lynn-dev
const defaultHome = path.join(os.homedir(), ".lynn");
if (lynnHome !== defaultHome) {
  const suffix = path.basename(lynnHome).replace(/^\./, ""); // "lynn-dev"
  const appName = suffix.charAt(0).toUpperCase() + suffix.slice(1); // "Lynn-dev"
  app.setPath("userData", path.join(app.getPath("appData"), appName));
}

let splashWindow = null;
let mainWindow = null;
let onboardingWindow = null;
let _mainWindowReadyWaiters = [];

let settingsWindow = null;
let settingsWindowInitialNavigationTarget = null;
let settingsWindowContentStamp = null;
let preferredPrimaryWindowKind = "main";

let browserViewerWindow = null;
let _browserWebView = null;        // 当前活跃的 WebContentsView
const _browserViews = new Map();   // sessionPath → WebContentsView（挂起的浏览器）
let _currentBrowserSession = null; // 当前浏览器绑定的 sessionPath

setIpcSenderValidator((channel, event) => isTrustedAppWebContents(event?.sender, channel));

// 有任务进行时禁止系统挂起。使用 prevent-app-suspension 保持任务执行，
// 但不强制点亮屏幕，避免长任务时额外耗电或打扰用户。
const wakeLockReasons = new Set();
let wakeLockId = null;

function wakeLockState() {
  return {
    active: wakeLockId != null && powerSaveBlocker.isStarted(wakeLockId),
    blockerId: wakeLockId,
    reasons: Array.from(wakeLockReasons),
  };
}

function refreshWakeLock() {
  if (wakeLockReasons.size > 0) {
    if (wakeLockId == null || !powerSaveBlocker.isStarted(wakeLockId)) {
      wakeLockId = powerSaveBlocker.start("prevent-app-suspension");
      console.log(`[desktop] wake lock enabled: ${Array.from(wakeLockReasons).join(", ")}`);
    }
    return wakeLockState();
  }

  if (wakeLockId != null) {
    try {
      if (powerSaveBlocker.isStarted(wakeLockId)) powerSaveBlocker.stop(wakeLockId);
    } catch (err) {
      console.warn(`[desktop] wake lock stop failed: ${err?.message || err}`);
    }
    console.log("[desktop] wake lock released");
    wakeLockId = null;
  }
  return wakeLockState();
}

function setWakeLockReason(reason, active) {
  const key = String(reason || "").trim();
  if (!key) return wakeLockState();
  if (active) wakeLockReasons.add(key);
  else wakeLockReasons.delete(key);
  return refreshWakeLock();
}

/** Vite 入口页面统一加载（dev → Vite dev server，prod → dist-renderer，fallback → src） */
const _isDev = process.argv.includes("--dev");
const _distRenderer = path.join(__dirname, "dist-renderer");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadWindowErrorPage(win, pageName, err) {
  const detail = escapeHtml(err?.message || err || "unknown error");
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageName)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: #f8f5ed;
      color: #4f5b66;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      width: min(560px, 100%);
      background: rgba(255,255,255,0.88);
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(74, 92, 106, 0.12);
      padding: 24px 28px;
    }
    h1 { margin: 0 0 10px; font-size: 20px; color: #3f4a55; }
    p { margin: 0; line-height: 1.7; }
    code {
      display: block;
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(79, 91, 102, 0.08);
      color: #556372;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(pageName)} 加载失败</h1>
    <p>这个窗口没有正确加载出来。重新打开一次试试；如果仍然出现，请把下面这段错误信息发给开发者。</p>
    <code>${detail}</code>
  </div>
</body>
</html>`;
  return win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
}

function loadWindowURL(win, pageName, opts) {
  if (_isDev && process.env.VITE_DEV_URL) {
    let url = `${process.env.VITE_DEV_URL}/${pageName}.html`;
    if (opts?.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }
    return win.loadURL(url);
  } else {
    const built = path.join(_distRenderer, `${pageName}.html`);
    if (_isDev) {
      return win.loadFile(path.join(__dirname, "src", `${pageName}.html`), opts);
    }
    if (!fs.existsSync(built)) {
      const err = new Error(`renderer entry missing: ${built}`);
      console.error(`[desktop] ${pageName} 页面入口缺失: ${built}`);
      return loadWindowErrorPage(win, pageName, err);
    }
    return win.loadFile(built, opts).catch((err) => {
      console.error(`[desktop] ${pageName} 页面加载失败: ${err.message}`);
      return loadWindowErrorPage(win, pageName, err);
    });
  }
}

function getWindowEntryStamp(pageName) {
  try {
    const entryPath = _isDev
      ? path.join(__dirname, "src", `${pageName}.html`)
      : path.join(_distRenderer, `${pageName}.html`);
    const stat = fs.statSync(entryPath);
    return `${entryPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return `${pageName}:missing`;
  }
}

/** 校验浏览器 URL：仅允许 http/https */
// SSRF-guarded URL check for the model-driven browser agent (see browser-url-guard.cjs).
const { isAllowedBrowserUrl } = require("./browser-url-guard.cjs");
let _browserViewerTheme = "warm-paper"; // 当前主题（用于 backgroundColor）
const TITLEBAR_HEIGHT = 44;        // 浏览器窗口标题栏高度（px）
let isQuitting = false;  // 区分关窗口（hide）和真正退出（quit）
let tray = null;
let isExitingServer = false; // 只有托盘"退出"时才 kill server，其余路径仅关前端
let forceQuitApp = false;   // 启动失败等场景需要真正退出，绕过"隐藏保持运行"拦截
let _localAuthHeaderHookInstalled = false;

// ── 主进程 i18n ──
// 从 agent config.yaml 读取 locale，加载对应语言包的 "main" 部分
// 主进程 i18n 已抽到 main-i18n.cjs（注入 lynnHome + localesDir）。
const { createMainI18n } = require("./main-i18n.cjs");
const { mt, resetMainI18n } = createMainI18n({ lynnHome, localesDir: path.join(__dirname, "src", "locales") });

/** 跨平台杀进程：Windows 用 taskkill，POSIX 用 signal */
function killPid(pid, force = false) {
  if (process.platform === "win32") {
    try {
      require("child_process").execFileSync("taskkill",
        force ? ["/F", "/T", "/PID", String(pid)] : ["/PID", String(pid)],
        { stdio: "ignore", windowsHide: true });
    } catch {}
  } else {
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

function resolveMainWindowReady(ok = true) {
  const waiters = _mainWindowReadyWaiters;
  _mainWindowReadyWaiters = [];
  for (const finish of waiters) {
    try { finish(ok); } catch {}
  }
}

function waitForMainWindowReady(timeoutMs = 15000) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    _mainWindowReadyWaiters.push(finish);
    setTimeout(() => finish(false), timeoutMs);
  });
}

function revealMainWindowAndCloseStartupShell(reason = "unknown") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } catch (err) {
      console.error(`[desktop] show main window failed (${reason}):`, err?.message || err);
    }
  }
  resolveMainWindowReady(true);

  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.close(); } catch {}
    }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      try { onboardingWindow.close(); } catch {}
    }
  }, 200);
}

function shouldAttachLocalAuthHeader(urlString) {
  try {
    const parsed = new URL(urlString);
    const isLocalHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const serverPort = serverController.getPort();
    return parsed.protocol === "http:" && isLocalHost && (!serverPort || parsed.port === String(serverPort));
  } catch {
    return false;
  }
}

function ensureLocalAuthHeaderHook() {
  if (_localAuthHeaderHookInstalled || !session.defaultSession) return;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const serverToken = serverController.getToken();
    if (!serverToken || !shouldAttachLocalAuthHeader(details.url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = { ...details.requestHeaders };
    if (!requestHeaders.Authorization) {
      requestHeaders.Authorization = `Bearer ${serverToken}`;
    }
    callback({ requestHeaders });
  });
  _localAuthHeaderHookInstalled = true;
}

const _fileAccessGrants = new Map();
const _trackedGrantWebContents = new Set();

const { normalizePolicyPath, resolveCanonicalPath, isPathInsideRoot, uniqueCanonicalPaths } = require("./path-policy.cjs");

function readUserPreferences() {
  return safeReadJSON(path.join(lynnHome, "user", "preferences.json"), {}) || {};
}

function writeUserPreferences(nextPrefs) {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(nextPrefs, null, 2) + "\n", "utf-8");
}

// v0.79 policy: the built-in default model is Brain v2. Older desktop builds
// persisted v1 roots in ~/.lynn; migrate only the first-party "brain" provider
// so BYOK/custom providers stay untouched.
const { CANONICAL_BRAIN_API_ROOT, CANONICAL_BRAIN_PROVIDER_BASE_URL, normalizeBrainUrl, isDeprecatedBrainApiRoot, isDeprecatedBrainProviderBaseUrl } = require("./brain-url-policy.cjs");

function migrateBrainProviderStorage() {
  const providersPath = path.join(lynnHome, "added-models.yaml");
  try {
    const raw = fs.readFileSync(providersPath, "utf-8");
    const data = yaml.load(raw) || {};
    const brainProvider = data?.providers?.brain;
    if (!brainProvider || typeof brainProvider !== "object") return false;
    if (!isDeprecatedBrainProviderBaseUrl(brainProvider.base_url)) return false;
    brainProvider.base_url = CANONICAL_BRAIN_PROVIDER_BASE_URL;
    fs.writeFileSync(providersPath, yaml.dump(data, { lineWidth: 120 }), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function deriveBrainApiRootFromProviders() {
  try {
    const providersPath = path.join(lynnHome, "added-models.yaml");
    const raw = fs.readFileSync(providersPath, "utf-8");
    const data = yaml.load(raw) || {};
    const baseUrl = String(data?.providers?.brain?.base_url || "").trim().replace(/\/+$/, "");
    if (!baseUrl) return "";
    return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
  } catch {
    return "";
  }
}

function readBrainRuntimeConfig() {
  const migratedProviderStorage = migrateBrainProviderStorage();
  const prefs = readUserPreferences();
  let changedPrefs = false;

  const normalize = normalizeBrainUrl;
  let persistedApiRoot = normalize(prefs.brain_api_root || prefs.default_model_api_root);
  if (isDeprecatedBrainApiRoot(persistedApiRoot)) {
    persistedApiRoot = CANONICAL_BRAIN_API_ROOT;
    prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
    if (isDeprecatedBrainApiRoot(prefs.default_model_api_root)) {
      prefs.default_model_api_root = CANONICAL_BRAIN_API_ROOT;
    }
    changedPrefs = true;
  }

  const derivedApiRoot = persistedApiRoot || deriveBrainApiRootFromProviders();
  if (!persistedApiRoot && derivedApiRoot) {
    prefs.brain_api_root = derivedApiRoot;
    changedPrefs = true;
  }

  if (migratedProviderStorage && !prefs.brain_api_root) {
    prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
    changedPrefs = true;
  }

  if (changedPrefs) {
    writeUserPreferences(prefs);
  }
  return {
    apiRoot: derivedApiRoot,
    host: normalize(prefs.brain_api_host || prefs.default_model_api_host),
    legacyApiRoot: normalize(prefs.brain_legacy_api_root),
    legacyHost: normalize(prefs.brain_legacy_host),
  };
}

function normalizeTrustedRoot(rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
}

function uniqueTrustedRoots(paths) {
  const out = [];
  const seen = new Set();
  for (const entry of paths || []) {
    const normalized = normalizeTrustedRoot(entry);
    if (!normalized) continue;
    const key = normalizePolicyPath(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function getDefaultDesktopRoot() {
  return path.join(os.homedir(), "Desktop");
}

function isLegacyDesktopWorkspaceSeed(prefs = {}, configuredRoots = null) {
  if (prefs?.setupComplete === true) return false;

  const desktopRoot = getDefaultDesktopRoot();
  const topLevelHome = normalizeTrustedRoot(prefs?.home_folder);
  const deskHome = normalizeTrustedRoot(prefs?.desk?.home_folder);
  const topLevelRoots = configuredRoots ?? uniqueTrustedRoots(
    Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []
  );
  const deskRoots = uniqueTrustedRoots(
    Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []
  );

  if (deskHome || deskRoots.length > 0) return false;

  const usesDesktopHome = topLevelHome === desktopRoot;
  const usesOnlyDesktopRoots = topLevelRoots.length > 0 && topLevelRoots.every((root) => root === desktopRoot);
  const hasOnlyLegacyTopLevelRoots = topLevelRoots.length === 0 || usesOnlyDesktopRoots;

  return hasOnlyLegacyTopLevelRoots && (usesDesktopHome || usesOnlyDesktopRoots);
}

function getPreferredHomeFolder(prefs = {}) {
  const configured = normalizeTrustedRoot(prefs?.home_folder)
    || normalizeTrustedRoot(prefs?.desk?.home_folder);
  if (!configured) return null;
  return isLegacyDesktopWorkspaceSeed(prefs) ? null : configured;
}

function getConfiguredTrustedRoots(prefs = {}) {
  const configuredRoots = uniqueTrustedRoots([
    ...(Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []),
    ...(Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []),
  ]);
  return isLegacyDesktopWorkspaceSeed(prefs, configuredRoots) ? [] : configuredRoots;
}

function getEffectiveTrustedRoots(prefs = {}) {
  return uniqueTrustedRoots([
    getPreferredHomeFolder(prefs),
    ...getConfiguredTrustedRoots(prefs),
  ]);
}

function getConfiguredWorkspaceRoots(config = {}, prefs = {}) {
  const history = Array.isArray(config?.cwd_history) ? config.cwd_history : [];
  return uniqueTrustedRoots([
    ...getEffectiveTrustedRoots(prefs),
    config?.last_cwd,
    ...history,
  ]);
}

function readCurrentAgentConfig() {
  const agentId = getCurrentAgentId();
  if (!agentId) return {};
  try {
    const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
    return yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

function listAgentRoots(subdir) {
  const agentsDir = path.join(lynnHome, "agents");
  try {
    return fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml")))
      .map(entry => path.join(agentsDir, entry.name, subdir));
  } catch {
    return [];
  }
}

function getWorkspaceRoots() {
  const prefs = readUserPreferences();
  const config = readCurrentAgentConfig();
  return uniqueCanonicalPaths(getConfiguredWorkspaceRoots(config, prefs));
}

function getExternalSkillRoots() {
  const prefs = readUserPreferences();
  return uniqueCanonicalPaths(Array.isArray(prefs.external_skill_paths) ? prefs.external_skill_paths : []);
}

function getTrustedPathPolicy() {
  const workspaceRoots = getWorkspaceRoots();
  const uploadsRoots = workspaceRoots.map(root => path.join(root, ".lynn-uploads"));
  return {
    read: uniqueCanonicalPaths([
      path.join(lynnHome, "skills"),
      path.join(lynnHome, "audio"),
      ...listAgentRoots("desk"),
      ...listAgentRoots("learned-skills"),
      ...workspaceRoots,
      ...uploadsRoots,
      path.join(os.tmpdir(), ".lynn-uploads"),
      ...getExternalSkillRoots(),
    ]),
    write: uniqueCanonicalPaths([
      ...workspaceRoots,
      ...uploadsRoots,
      path.join(os.tmpdir(), ".lynn-uploads"),
    ]),
  };
}

function resolveGrantTarget(target) {
  if (!target) return null;
  if (typeof target.id === "number" && typeof target.send === "function") return target;
  if (target.webContents && typeof target.webContents.id === "number") return target.webContents;
  return null;
}

function getGrantBucket(target) {
  const webContents = resolveGrantTarget(target);
  if (!webContents) return null;
  let bucket = _fileAccessGrants.get(webContents.id);
  if (!bucket) {
    bucket = { read: new Set(), write: new Set() };
    _fileAccessGrants.set(webContents.id, bucket);
  }
  if (!_trackedGrantWebContents.has(webContents.id)) {
    _trackedGrantWebContents.add(webContents.id);
    webContents.once("destroyed", () => {
      _fileAccessGrants.delete(webContents.id);
      _trackedGrantWebContents.delete(webContents.id);
    });
  }
  return bucket;
}

function grantWebContentsAccess(target, rawPath, level = "read") {
  const canonical = resolveCanonicalPath(rawPath);
  const bucket = getGrantBucket(target);
  if (!canonical || !bucket) return null;
  bucket.read.add(canonical);
  if (level === "write" || level === "readwrite") {
    bucket.write.add(canonical);
  }
  return canonical;
}

function hasGrantedAccess(target, canonicalPath, mode) {
  const webContents = resolveGrantTarget(target);
  if (!webContents) return false;
  const bucket = _fileAccessGrants.get(webContents.id);
  if (!bucket) return false;

  const candidates = mode === "write"
    ? [...bucket.write]
    : [...bucket.read, ...bucket.write];
  return candidates.some(root => isPathInsideRoot(canonicalPath, root));
}

function hasTrustedAccess(canonicalPath, mode) {
  const policy = getTrustedPathPolicy();
  const roots = mode === "write" ? policy.write : policy.read;
  return roots.some(root => isPathInsideRoot(canonicalPath, root));
}

function canAccessPath(target, rawPath, mode = "read") {
  const canonical = resolveCanonicalPath(rawPath);
  if (!canonical) return { allowed: false, canonical: null };
  return {
    allowed: hasTrustedAccess(canonical, mode) || hasGrantedAccess(target, canonical, mode),
    canonical,
  };
}

function canReadPath(target, rawPath) {
  return canAccessPath(target, rawPath, "read");
}

function canWritePath(target, rawPath) {
  return canAccessPath(target, rawPath, "write");
}

/** 跨平台标题栏选项：macOS hiddenInset + 红绿灯，Windows/Linux 无框 */
function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  // Windows/Linux：无框窗口 + 前端自绘 window controls
  return { frame: false };
}

/**
 * 获取当前 agent ID（不依赖 server）
 * 优先读 user/preferences.json，fallback 扫描 agents/ 第一个有效目录
 */
function getCurrentAgentId() {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  const agentsDir = path.join(lynnHome, "agents");

  // 1. 读 preferences
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    if (prefs.primaryAgent) {
      // 确认这个 agent 真的存在（可能已被删除）
      const agentDir = path.join(agentsDir, prefs.primaryAgent);
      if (fs.existsSync(path.join(agentDir, "config.yaml"))) {
        return prefs.primaryAgent;
      }
    }
  } catch {}

  // 2. 扫描 agents/ 目录，返回第一个有效 agent
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
        return entry.name;
      }
    }
  } catch {}

  // 3. 没有任何 agent（首次启动 first-run 还没跑，或全被删了）
  return null;
}

/**
 * 检查是否已完成首次配置引导
 * 优先看 preferences.json 的 setupComplete 标记；
 * 兜底检查：如果用户已有 session 文件（说明已正常使用过），自动补写标记并跳过 onboarding
 */
function isSetupComplete() {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    if (prefs.setupComplete === true) return true;
  } catch {}

  // 兜底：检查是否已有 session 文件（证明用户已正常使用过）
  try {
    const agentsDir = path.join(lynnHome, "agents");
    const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of agents) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const sessDir = path.join(agentsDir, entry.name, "sessions");
      if (!fs.existsSync(sessDir)) continue;
      const sessions = fs.readdirSync(sessDir).filter(f => f.endsWith(".jsonl"));
      if (sessions.length > 0) {
        // 自动补写 setupComplete 标记，下次启动不再检查
        try {
          let prefs = {};
          try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch {}
          prefs.setupComplete = true;
          fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
          console.log("[desktop] 检测到已有 session，自动标记 setupComplete");
        } catch {}
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * 检查当前 agent 的 config.yaml 是否已有有效 api_key
 * 用于老用户兼容：有 key 说明配置过了，跳过填写直接看教程
 */
function hasExistingConfig() {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return false;
    const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
    const configText = fs.readFileSync(configPath, "utf-8");

    // 兼容旧版：api_key 直接写在当前 agent 的 config.yaml
    if (/api_key:\s*["']?[^"'\s]+/.test(configText)) {
      return true;
    }

    const parsedConfig = yaml.load(configText) || {};
    const currentProvider = String(parsedConfig?.api?.provider || "").trim();

    // 兼容新版：provider 凭证已经迁移到全局 ~/.lynn/added-models.yaml
    const providersPath = path.join(lynnHome, "added-models.yaml");
    const providersRaw = fs.readFileSync(providersPath, "utf-8");
    const providersData = yaml.load(providersRaw) || {};
    const providers = providersData?.providers || {};
    const hasProviderKey = (entry) => typeof entry?.api_key === "string" && String(entry.api_key).trim().length > 0;

    if (currentProvider && hasProviderKey(providers[currentProvider])) {
      return true;
    }

    return Object.values(providers).some(hasProviderKey);
  } catch {}
  return false;
}

// Server process logic lives in server-process.cjs. createServerProcessController
// owns the canonical process/port/token/logs state + crash-monitor + heartbeat
// (S2-S4); main.cjs is the composition root that injects Electron/Node deps.
const { createServerProcessController } = require("./server-process.cjs");

// Server lifecycle owner. main.cjs is the composition root: it constructs the
// controller with Electron/Node capabilities injected. The controller owns the
// canonical process/port/token/logs state and exposes getters for main readers.
const serverController = createServerProcessController({
  app,
  fetch,
  spawn,
  fs,
  mt,
  lynnHome,
  dirname: __dirname,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
  platform: process.platform,
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  getWorkerSpawnServerEnv,
  readBrainRuntimeConfig,
  killPid,
  onLocalAuthHeaderNeeded: () => ensureLocalAuthHeaderHook(),
  dialog,
  writeCrashLog,
  isQuitting: () => isQuitting,
  // Called on each internal restart (monitor/heartbeat): re-sync the legacy
  // readers through controller getters, then notify renderer windows.
  onServerRestarted: ({ port, token }) => {
    let sent = 0;
    for (const win of [mainWindow, settingsWindow]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("server-restarted", { port, token });
        sent++;
      }
    }
    console.log(`[desktop] server-restarted sent to ${sent} window(s), port: ${port}`);
  },
});

async function startServer() {
  await serverController.start();
}

// Server crash-monitor, heartbeat, and shutdown live in serverController.

/**
 * 显示当前最相关窗口
 */
function markPreferredPrimaryWindow(kind) {
  if (typeof kind === "string" && kind) preferredPrimaryWindowKind = kind;
}

function getPreferredPrimaryWindow() {
  const windowByKind = {
    settings: settingsWindow,
    onboarding: onboardingWindow,
    browser: browserViewerWindow,
    editor: editorWindow,
    main: mainWindow,
  };
  const preferred = windowByKind[preferredPrimaryWindowKind];
  if (preferred && !preferred.isDestroyed()) return preferred;
  return settingsWindow
    || onboardingWindow
    || browserViewerWindow
    || editorWindow
    || mainWindow
    || null;
}

function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = getPreferredPrimaryWindow();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

/**
 * 创建系统托盘图标
 * - 双击：显示主窗口
 * - 右键菜单：显示 Lynn / 设置 / 退出
 */
function createTray() {
  if (process.platform === "darwin") {
    tray = null;
    return;
  }
  const isDev = lynnHome !== path.join(os.homedir(), ".lynn");
  let icon;
  if (process.platform === "win32") {
    // Windows 优先用 .ico，缺失则回退到 .png
    const icoName = isDev ? "tray-dev.ico" : "tray.ico";
    const icoPath = path.join(__dirname, "src", "assets", icoName);
    if (fs.existsSync(icoPath)) {
      icon = nativeImage.createFromPath(icoPath);
    } else {
      const pngName = isDev ? "tray-dev-template.png" : "tray-template.png";
      icon = nativeImage.createFromPath(path.join(__dirname, "src", "assets", pngName));
    }
  } else {
    const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
    const iconPath = path.join(__dirname, "src", "assets", iconName);
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin") icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(isDev ? "Lynn (dev)" : "Lynn");

  const buildMenu = () => Menu.buildFromTemplate([
    { label: mt("tray.show", null, "Show Lynn"), click: () => showPrimaryWindow() },
    { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
    { type: "separator" },
    { label: mt("tray.quit", null, "Quit"), click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on("right-click", () => tray.setContextMenu(buildMenu()));
  tray.on("double-click", () => showPrimaryWindow());
}

/**
 * 将崩溃日志写入 LYNN_HOME/crash.log（默认 ~/.lynn/crash.log）并返回日志内容
 */
function writeCrashLog(errorMessage) {
  const logs = serverController.getLogs().join("");
  const timestamp = new Date().toISOString();

  // 没有任何输出时，附加诊断信息帮助定位问题
  let diagnostics = "";
  if (!logs) {
    // production 时 server 在 resources/server/，dev 时在 __dirname/../server/
    const isPackaged = process.resourcesPath &&
      fs.existsSync(path.join(process.resourcesPath, "server"));
    const serverDir = isPackaged
      ? path.join(process.resourcesPath, "server")
      : path.join(__dirname, "..", "server");
    const sqlitePath = path.join(serverDir, "node_modules", "better-sqlite3",
      "build", "Release", "better_sqlite3.node");
    const bundlePath = path.join(serverDir, "bundle", "index.js");

    const items = [
      ``,
      `--- Diagnostics ---`,
      `LYNN_HOME: ${lynnHome}`,
      `Server dir: ${serverDir}`,
      `Packaged: ${!!isPackaged}`,
      `bundle/index.js exists: ${fs.existsSync(bundlePath)}`,
      `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
      `ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE || "unset"}`,
      `Node ABI: ${process.versions.modules || "unknown"}`,
    ];

    // Windows: 检查 server 二进制、手动调试 wrapper 和 MinGit
    if (process.platform === "win32" && isPackaged) {
      const exePath = path.join(serverDir, "lynn-server.exe");
      const cmdPath = path.join(serverDir, "lynn-server.cmd");
      const gitRoot = path.join(process.resourcesPath, "git");
      items.push(`lynn-server.exe exists: ${fs.existsSync(exePath)}`);
      items.push(`lynn-server.cmd exists (manual debug): ${fs.existsSync(cmdPath)}`);
      items.push(`MinGit dir exists: ${fs.existsSync(gitRoot)}`);
      items.push(``);
      items.push(`Manual debug: open cmd.exe, cd to "${serverDir}", run lynn-server.cmd`);
    }

    diagnostics = items.join("\n");
  }

  const content = [
    `=== Lynn Crash Log ===`,
    `Time: ${timestamp}`,
    `Error: ${errorMessage}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron || "unknown"}`,
    `Node: ${process.versions.node || "unknown"}`,
    ``,
    `--- Server Output ---`,
    logs || "(no output captured)",
    diagnostics,
    ``,
  ].join("\n");

  // 写入文件（best effort）
  try {
    const crashLogPath = path.join(lynnHome, "crash.log");
    fs.mkdirSync(lynnHome, { recursive: true });
    fs.writeFileSync(crashLogPath, content, "utf-8");
  } catch (e) {
    console.error("[desktop] 写入 crash.log 失败:", e.message);
  }

  return content;
}

// ── 创建启动窗口 ──
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: "Lynn",
    transparent: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === "darwin" && splashWindow.setWindowButtonVisibility) {
    splashWindow.setWindowButtonVisibility(false);
  }

  loadWindowURL(splashWindow, "splash");

  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

// ── 窗口状态记忆 ──
const windowStatePath = path.join(lynnHome, "user", "window-state.json");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeMainWindowState(state) {
  if (!state || process.platform !== "darwin" || state.isMaximized) return state;
  const next = { ...state };
  // 兼容旧版本遗留的顶部空隙：窗口会被记在菜单栏下方一小段距离，
  // 重新启动后就像屏幕顶端多出一条“通栏”。mac 下直接贴顶恢复。
  if (typeof next.y === "number" && next.y >= 0 && next.y <= TITLEBAR_HEIGHT) {
    next.y = 0;
  }
  return next;
}

let _saveWindowStateTimer = null;
function saveWindowState() {
  if (_saveWindowStateTimer) clearTimeout(_saveWindowStateTimer);
  _saveWindowStateTimer = setTimeout(() => {
    _saveWindowStateTimer = null;
    if (!mainWindow) return;
    const isMaximized = mainWindow.isMaximized();
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const state = { ...bounds, isMaximized };
    try {
      fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2) + "\n");
    } catch (e) {
      console.error("[desktop] 保存窗口状态失败:", e.message);
    }
  }, 500);
}

// ── 创建主窗口 ──
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const saved = normalizeMainWindowState(loadWindowState());

  const opts = {
    width: saved?.width || 960,
    height: saved?.height || 820,
    minWidth: 420,
    minHeight: 500,
    title: "Lynn",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F4F0E4",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // 恢复位置（仅当坐标有效时）
  if (saved?.x != null && saved?.y != null) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  mainWindow = new BrowserWindow(opts);

  // 自动更新：注册 IPC handlers
  initAutoUpdater(mainWindow, isTrustedAppWebContents);

  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  loadWindowURL(mainWindow, "index", process.env.LYNN_UI_SMOKE === "1" ? { query: { uiSmoke: "1" } } : undefined);

  // 前端初始化超时保护：没收到 app-ready 也必须退出 splash。
  // 否则主窗口已连上 server 时，用户仍会被留在启动页，看起来像白屏。
  const initTimeout = setTimeout(() => {
    console.warn("[desktop] ⚠ 主窗口初始化超时，强制显示并关闭 splash");
    revealMainWindowAndCloseStartupShell("main-init-timeout");
  }, 8000);
  mainWindow.webContents.once("did-finish-load", () => {
    // did-finish-load 只是 HTML 加载完成，JS init 可能还在跑
    console.log("[desktop] 主窗口 HTML 加载完成，等待前端 init...");
  });
  mainWindow.once("show", () => clearTimeout(initTimeout));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  // renderer 崩溃恢复：自动 reload
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        try { mainWindow.reload(); } catch {}
      }, 1000);
    }
  });

  mainWindow.on("unresponsive", () => {
    console.warn("[desktop] 主窗口无响应");
  });

  mainWindow.on("responsive", () => {
    console.log("[desktop] 主窗口已恢复响应");
  });

  // 窗口移动/缩放时保存状态
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);

  // 窗口获焦时清除 Dock badge
  mainWindow.on("focus", () => {
    markPreferredPrimaryWindow("main");
    if (process.platform === "darwin") {
      _pendingNotificationCount = 0;
      app.dock.setBadge("");
    }
  });

  // 拦截页面内链接导航：外部 URL 用系统浏览器打开，不要导航 Electron 窗口
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  // 广播最大化状态变化（Windows/Linux 自绘标题栏的最大化/还原按钮需要）
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized"));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));

  // macOS 风格：点关闭按钮只是隐藏窗口，Dock 保留黑点
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      // 不调 app.dock.hide()，Dock 上保留图标和黑点
      // 同时隐藏子窗口
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
      if (editorWindow && !editorWindow.isDestroyed()) editorWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
      settingsWindow = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.destroy();
      browserViewerWindow = null;
    }
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.destroy();
      editorWindow = null;
    }
  });

  return mainWindow;
}


const THEME_BG = {
  "warm-paper":   "#F8F5ED",
  "midnight":     "#2D4356",
  "high-contrast":"#FAF9F6",
  "grass-aroma":  "#F5F8F3",
  "contemplation":"#F3F5F7",
};

function normalizeSettingsNavigationTarget(target) {
  if (!target) return null;
  if (typeof target === "string") return { tab: target };
  if (typeof target !== "object") return null;
  const next = {};
  if (typeof target.tab === "string" && target.tab) next.tab = target.tab;
  if (target.providerId === null || typeof target.providerId === "string") next.providerId = target.providerId ?? null;
  if (target.resetProviderSelection === true) next.resetProviderSelection = true;
  if (target.agentId === null || typeof target.agentId === "string") next.agentId = target.agentId ?? null;
  if (target.resetAgentSelection === true) next.resetAgentSelection = true;
  if (target.reviewerKind === "hanako" || target.reviewerKind === "butter") next.reviewerKind = target.reviewerKind;
  return Object.keys(next).length > 0 ? next : null;
}

// ── 创建设置窗口 ──
function createSettingsWindow(target, theme) {
  const navigationTarget = normalizeSettingsNavigationTarget(target);
  const desiredStamp = getWindowEntryStamp("settings");
  let settingsHealAttempts = 0;
  const verifySettingsRenderer = () => {
    const win = settingsWindow;
    if (!win || win.isDestroyed()) return;
    setTimeout(() => {
      const current = settingsWindow;
      if (!current || current.isDestroyed() || current !== win) return;
      current.webContents.executeJavaScript(`
        (() => {
          const root = document.getElementById('react-root');
          const bodyText = (document.body && document.body.innerText || '').slice(0, 800);
          return {
            href: location.href,
            title: document.title || '',
            rootChildren: root ? root.childElementCount : -1,
            bodyText,
          };
        })()
      `, true).then((snapshot) => {
        const text = String(snapshot?.bodyText || "");
        const lowerText = text.toLowerCase();
        const looksLikeSource = [
          "<!doctype",
          "<html",
          "<head",
          "<body",
          "<script",
          "<link",
          "stylesheet",
          "react-root",
          "settings-main",
          "窗口控制按钮",
        ].some((needle) => lowerText.includes(String(needle).toLowerCase()));
        const emptyRoot = Number(snapshot?.rootChildren || 0) <= 0;
        if (!emptyRoot && !looksLikeSource) return;
        if (settingsHealAttempts >= 1) {
          console.warn("[desktop] settings renderer sanity check failed after reload", snapshot);
          void loadWindowErrorPage(current, "settings", new Error(`settings renderer stayed empty/raw after reload: ${JSON.stringify(snapshot).slice(0, 500)}`));
          return;
        }
        settingsHealAttempts += 1;
        console.warn("[desktop] settings renderer looked empty/raw; reloading entry", snapshot);
        void loadWindowURL(current, "settings");
      }).catch((err) => {
        console.warn("[desktop] settings renderer sanity check failed:", err?.message || err);
      });
    }, 900);
  };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // renderer 已崩溃：销毁旧窗口，走下方重建流程
    if (settingsWindow.webContents.isCrashed()) {
      console.warn("[desktop] settings renderer 已崩溃，重建窗口");
      settingsWindow.destroy();
      settingsWindow = null;
    } else if ((settingsWindow.webContents.getURL() || "").startsWith("data:text/html")) {
      console.warn("[desktop] settings window 处于错误页，重建窗口");
      settingsWindow.destroy();
      settingsWindow = null;
    } else if (settingsWindowContentStamp && settingsWindowContentStamp !== desiredStamp) {
      console.warn("[desktop] settings window 资源已更新，重建窗口");
      settingsWindow.destroy();
      settingsWindow = null;
    } else {
      if (navigationTarget) settingsWindow.webContents.send("settings-switch-tab", navigationTarget);
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
  }

  settingsWindowInitialNavigationTarget = navigationTarget;
  settingsWindowContentStamp = desiredStamp;
  markPreferredPrimaryWindow("settings");

  settingsWindow = new BrowserWindow({
    width: 1580,
    height: 960,
    minWidth: 1280,
    minHeight: 720,
    title: "Settings",
    ...titleBarOpts({ x: 16, y: 14 }),
    backgroundColor: THEME_BG[theme || _browserViewerTheme] || THEME_BG["warm-paper"],
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.once("ready-to-show", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      markPreferredPrimaryWindow("settings");
      settingsWindow.show();
      settingsWindow.focus();
    }
  });

  settingsWindow.on("focus", () => {
    markPreferredPrimaryWindow("settings");
  });

  settingsWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[desktop] settings did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);
    if (settingsWindow && !settingsWindow.isDestroyed() && !String(validatedURL || "").startsWith("data:text/html")) {
      void loadWindowErrorPage(settingsWindow, "settings", new Error(`${errorCode} ${errorDescription}`));
    }
  });

  settingsWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.warn(`[desktop] settings console(${level}) ${sourceId}:${line} ${message}`);
    }
  });

  settingsWindow.webContents.on("did-finish-load", verifySettingsRenderer);

  void Promise.allSettled([
    settingsWindow.webContents.session.clearCache(),
    settingsWindow.webContents.session.clearStorageData({ storages: ["cachestorage", "serviceworkers"] }),
  ]).finally(() => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      void loadWindowURL(settingsWindow, "settings");
    }
  });

  // 拦截设置窗口内的链接导航
  settingsWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  // renderer 崩溃恢复：标记为 null，下次打开时重建
  settingsWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] settings renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }
    settingsWindow = null;
  });

  settingsWindow.on("closed", () => {
    if (preferredPrimaryWindowKind === "settings") {
      preferredPrimaryWindowKind = "main";
    }
    settingsWindowInitialNavigationTarget = null;
    settingsWindowContentStamp = null;
    settingsWindow = null;
  });
}

// ── Skill 预览 → 主窗口 overlay ──
function _showSkillViewer(skillInfo) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("show-skill-viewer", skillInfo);
    mainWindow.show();
    mainWindow.focus();
  }
}

/** 递归扫描目录，返回文件树 */
function scanSkillDir(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      // 目录排前面，SKILL.md 排最前
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(e => {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath, rootDir) };
    }
    return { name: e.name, path: fullPath, isDir: false };
  });
}

// ── 创建浏览器查看器窗口（嵌入式 BrowserView） ──
// opts.show: 是否立刻显示（默认 true），resume 时传 false
function createBrowserViewerWindow(opts = {}) {
  const shouldShow = opts.show !== false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    if (shouldShow) {
      browserViewerWindow.show();
      browserViewerWindow.focus();
      // 窗口从隐藏变为可见时重算 bounds（隐藏窗口的 getContentSize 可能不准确）
      _updateBrowserViewBounds();
      // 窗口复用时也要 focus WebContentsView，否则滚动/键盘不工作
      if (_browserWebView) {
        setTimeout(() => {
          if (_browserWebView) _browserWebView.webContents.focus();
        }, 50);
      }
    }
    return;
  }

  browserViewerWindow = new BrowserWindow({
    width: 1200,
    height: 1080,
    minWidth: 480,
    minHeight: 360,
    title: "Browser",
    frame: false,
    backgroundColor: THEME_BG[_browserViewerTheme] || THEME_BG["warm-paper"],
    hasShadow: true,
    show: shouldShow,
    acceptFirstMouse: true, // macOS: 第一次点击不仅激活窗口，还穿透到内容
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadWindowURL(browserViewerWindow, "browser-viewer");

  // HTML 加载完成后，若浏览器已在运行则附加 WebContentsView
  browserViewerWindow.webContents.on("did-finish-load", () => {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      // 避免重复添加：先移除再添加，确保在最顶层
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      browserViewerWindow.contentView.addChildView(_browserWebView);
      _updateBrowserViewBounds();
      const url = _browserWebView.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      console.log("[browser-viewer] did-finish-load: view 已挂载, bounds:", _browserWebView.getBounds());
      // 延迟 focus，等 layout 稳定
      setTimeout(() => {
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          console.log("[browser-viewer] delayed focus applied, isFocused:", _browserWebView.webContents.isFocused());
        }
      }, 200);
    }
  });

  browserViewerWindow.on("resize", () => _updateBrowserViewBounds());
  // 窗口从隐藏变为可见时重算 bounds（Windows 隐藏窗口的 getContentSize 可能返回错误值）
  browserViewerWindow.on("show", () => _updateBrowserViewBounds());

  // 窗口获得焦点时，将输入焦点转发到 WebContentsView（否则无法滚动/打字）
  browserViewerWindow.on("focus", () => {
    markPreferredPrimaryWindow("browser");
    if (_browserWebView) {
      _browserWebView.webContents.focus();
      console.log("[browser-viewer] window focus → view.focus(), isFocused:", _browserWebView.webContents.isFocused());
    }
  });

  // 浏览器运行时只隐藏不关闭
  browserViewerWindow.on("close", (e) => {
    if (!isQuitting && _browserWebView) {
      e.preventDefault();
      browserViewerWindow.hide();
    }
  });

  browserViewerWindow.on("closed", () => {
    if (preferredPrimaryWindowKind === "browser") {
      preferredPrimaryWindowKind = "main";
    }
    browserViewerWindow = null;
  });
}

// ══════════════════════════════════════════
//  嵌入式浏览器控制
//  Server 通过 WebSocket (/internal/browser) 发送 browser-cmd，
//  主进程在 WebContentsView 上执行操作
// ══════════════════════════════════════════

// DOM 遍历脚本：生成页面快照（类似 AXTree）
// 优化：同构兄弟（≥3）压缩为单行，保留全部 ref 和关键文本；超 30k 字符头尾截断
const { SNAPSHOT_SCRIPT } = require("./browser-snapshot.cjs");

function _ensureBrowser() {
  if (!_browserWebView) throw new Error("Browser not launched. Call start first.");
}

function _delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _updateBrowserViewBounds() {
  if (!_browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
  const [width, height] = browserViewerWindow.getContentSize();
  // 卡片式布局：四周留边距
  const mx = 8, mt = 4, mb = 8;
  const bounds = {
    x: mx,
    y: TITLEBAR_HEIGHT + mt,
    width: Math.max(0, width - mx * 2),
    height: Math.max(0, height - TITLEBAR_HEIGHT - mt - mb),
  };
  if (bounds.width === 0 || bounds.height === 0) {
    console.warn("[browser] bounds 计算为零:", { contentSize: [width, height], bounds, visible: browserViewerWindow.isVisible() });
  }
  _browserWebView.setBounds(bounds);
}

function _notifyViewerUrl(url) {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed() && _browserWebView) {
    browserViewerWindow.webContents.send("browser-update", {
      url,
      title: _browserWebView.webContents.getTitle(),
      canGoBack: _browserWebView.webContents.canGoBack(),
      canGoForward: _browserWebView.webContents.canGoForward(),
    });
  }
}

async function handleBrowserCommand(cmd, params) {
  switch (cmd) {

    // ── launch ──
    case "launch": {
      if (_browserWebView) return {};
      const ses = session.fromPartition("persist:hana-browser");
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      // 监听导航事件，实时更新 URL 栏
      view.webContents.on("did-navigate", (_e, url) => _notifyViewerUrl(url));
      view.webContents.on("did-navigate-in-page", (_e, url) => _notifyViewerUrl(url));

      // 在新窗口中打开链接（target=_blank）时，在当前视图中打开
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedBrowserUrl(url)) {
          view.webContents.loadURL(url);
        }
        return { action: "deny" };
      });

      // 页面标题变化时更新标题栏
      view.webContents.on("page-title-updated", () => {
        _notifyViewerUrl(view.webContents.getURL());
      });

      // 卡片圆角
      view.setBorderRadius(10);

      // 绑定到 session
      _browserWebView = view;
      _currentBrowserSession = params.sessionPath || null;
      if (_currentBrowserSession) {
        _browserViews.set(_currentBrowserSession, view);
      }

      // 始终静默创建窗口（不弹出），等用户手动点击才 show
      createBrowserViewerWindow({ show: false });
      // 如果 HTML 已加载完毕（窗口复用），did-finish-load 不会再触发，手动挂载
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        browserViewerWindow.contentView.addChildView(_browserWebView);
        _updateBrowserViewBounds();
        console.log("[browser] launch: view 已挂载 (silent), bounds:", _browserWebView.getBounds());
        setTimeout(() => {
          if (_browserWebView) {
            _browserWebView.webContents.focus();
          }
        }, 300);
      }
      return {};
    }

    // ── close ──（真正销毁当前浏览器实例）
    case "close": {
      if (_browserWebView) {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        _browserWebView.webContents.close();
        // 从 Map 中移除
        if (_currentBrowserSession) {
          _browserViews.delete(_currentBrowserSession);
        }
        _browserWebView = null;
        _currentBrowserSession = null;
      }
      // 通知浮窗状态变化，但不自动隐藏（让用户自己决定关不关）
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.webContents.send("browser-update", { running: false });
      }
      return {};
    }

    // ── suspend ──（从窗口摘下来，但不销毁，页面状态完全保留）
    case "suspend": {
      if (_browserWebView) {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        // view 留在 _browserViews Map 里，不 close
        _browserWebView = null;
        _currentBrowserSession = null;
      }
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.webContents.send("browser-update", { running: false });
      }
      return {};
    }

    // ── resume ──（把挂起的 view 挂回窗口，但不自动弹出）
    case "resume": {
      const sp = params.sessionPath;
      if (!sp || !_browserViews.has(sp)) {
        return { found: false };
      }
      const view = _browserViews.get(sp);
      _browserWebView = view;
      _currentBrowserSession = sp;

      // 挂载 view 到窗口（不 show，等用户手动打开）
      createBrowserViewerWindow({ show: false });
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.contentView.addChildView(view);
        _updateBrowserViewBounds();
        // 恢复输入焦点（否则无法滚动/交互）
        view.webContents.focus();
      }
      // 通知标题栏更新
      const url = view.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      return { found: true, url };
    }

    // ── navigate ──
    case "navigate": {
      if (!isAllowedBrowserUrl(params.url)) {
        throw new Error("Only http/https URLs are allowed");
      }
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      await wc.loadURL(params.url);
      await _delay(500);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { url: snap.currentUrl, title: snap.title, snapshot: snap.text };
    }

    // ── snapshot ──
    case "snapshot": {
      _ensureBrowser();
      const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── screenshot ──
    case "screenshot": {
      _ensureBrowser();
      const img = await _browserWebView.webContents.capturePage();
      const jpeg = img.toJPEG(75);
      return { base64: jpeg.toString("base64") };
    }

    // ── thumbnail ──
    case "thumbnail": {
      _ensureBrowser();
      const img = await _browserWebView.webContents.capturePage();
      const resized = img.resize({ width: 400 });
      const jpeg = resized.toJPEG(60);
      return { base64: jpeg.toString("base64") };
    }

    // ── click ──
    case "click": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const clickRef = Number(params.ref);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + clickRef + "\"]');" +
        " if (!el) throw new Error('Element [" + clickRef + "] not found');" +
        " el.scrollIntoView({block:'center'}); el.click(); })()"
      );
      await _delay(800);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── type ──
    case "type": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      if (params.ref != null) {
        const typeRef = Number(params.ref);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-hana-ref=\"" + typeRef + "\"]');" +
          " if (!el) throw new Error('Element [" + typeRef + "] not found');" +
          " el.scrollIntoView({block:'center'}); el.focus();" +
          " if (el.select) el.select(); })()"
        );
        await _delay(100);
      }
      await wc.insertText(params.text);
      if (params.pressEnter) {
        await _delay(100);
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await _delay(800);
      }
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    // ── scroll ──
    case "scroll": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
      await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
      await _delay(500);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── select ──
    case "select": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const selRef = Number(params.ref);
      const safeValue = JSON.stringify(params.value);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + selRef + "\"]');" +
        " if (!el) throw new Error('Element [" + selRef + "] not found');" +
        " el.value = " + safeValue + ";" +
        " el.dispatchEvent(new Event('change',{bubbles:true})); })()"
      );
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── pressKey ──
    case "pressKey": {
      _ensureBrowser();
      const wc = _browserWebView.webContents;
      const parts = params.key.split("+");
      const keyCode = parts[parts.length - 1];
      const modifiers = parts.slice(0, -1).map(function(m) { return m.toLowerCase(); });
      const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
      const mappedKey = keyMap[keyCode] || keyCode;
      wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
      await _delay(300);
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── wait ──
    case "wait": {
      _ensureBrowser();
      const timeout = Math.min(params.timeout || 5000, 10000);
      await _delay(timeout);
      const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
      return { text: snap.text };
    }

    // ── evaluate ──
    // 2026-05-25 P1-3 (security hardening):
    // 1. 长度上限 10000 → 4000 字符(合法页面操作 < 1KB,>4KB 几乎确定可疑)
    // 2. **完整 expression** 进 audit log(之前只 log 头 200 字,exfil-script 截不到尾)
    // 3. LYNN_BROWSER_EVAL_DENY_SENSITIVE=1 时拒绝含 cookie / localStorage / sessionStorage /
    //    indexedDB / document.domain 等 exfil 关键词的 expression。默认关(向后兼容),
    //    生产高 paranoia 部署可 opt-in。
    case "evaluate": {
      if (!params.expression || params.expression.length > 4000) {
        throw new Error("Expression too long (max 4000 chars; was 10000 — tightened 2026-05-25 P1-3 security)");
      }
      // 完整 expression audit log,而不是头 200 字 — exfil 脚本常把敏感操作藏在尾部
      console.log(`[browser:evaluate audit][${new Date().toISOString()}][len=${params.expression.length}] ${params.expression}`);
      // 高 paranoia 模式:阻断典型 cookie / 存储 exfil 关键词
      if (process.env.LYNN_BROWSER_EVAL_DENY_SENSITIVE === "1") {
        const sensitivePatterns = /\b(document\.cookie|localStorage|sessionStorage|indexedDB|document\.domain|navigator\.credentials)\b/i;
        if (sensitivePatterns.test(params.expression)) {
          throw new Error("browser:evaluate denied — expression accesses sensitive storage (LYNN_BROWSER_EVAL_DENY_SENSITIVE=1)");
        }
      }
      _ensureBrowser();
      const result = await _browserWebView.webContents.executeJavaScript(params.expression);
      const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { value: serialized || "undefined" };
    }

    // ── show ──
    case "show": {
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.show();
        browserViewerWindow.focus();
        // 延迟 focus：等窗口完全显示后再转移焦点到 WebContentsView
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          setTimeout(() => {
            if (_browserWebView) _browserWebView.webContents.focus();
          }, 100);
        }
      } else if (_browserWebView) {
        createBrowserViewerWindow();
      }
      return {};
    }

    // ── destroyView ──（销毁指定 session 的挂起 view）
    case "destroyView": {
      const sp = params.sessionPath;
      if (sp && _browserViews.has(sp)) {
        const view = _browserViews.get(sp);
        if (view === _browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try { browserViewerWindow.contentView.removeChildView(view); } catch {}
          }
          _browserWebView = null;
          _currentBrowserSession = null;
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            browserViewerWindow.webContents.send("browser-update", { running: false });
            browserViewerWindow.hide();
          }
        }
        view.webContents.close();
        _browserViews.delete(sp);
      }
      return {};
    }

    default:
      throw new Error("Unknown browser command: " + cmd);
  }
}

/** 通过 WebSocket 监听 server 的浏览器命令 */
function setupBrowserCommands() {
  const serverPort = serverController.getPort();
  const serverToken = serverController.getToken();
  if (!serverPort || !serverToken) return;

  const WebSocket = require("ws");
  const url = `ws://127.0.0.1:${serverPort}/internal/browser`;
  const protocols = serverToken ? ["hana-browser", `token.${serverToken}`] : ["hana-browser"];
  let ws;

  function connect() {
    ws = new WebSocket(url, protocols);
    ws.on("open", () => {
      console.log("[desktop] Browser control WS connected");
    });
    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type !== "browser-cmd") return;
      const { id, cmd, params } = msg;
      const _bLog = (line) => { try { require("fs").appendFileSync(require("path").join(require("os").homedir(), ".lynn", "browser-cmd.log"), `${new Date().toISOString()} ${line}\n`); } catch {} };
      _bLog(`→ received cmd=${cmd} id=${id}`);
      try {
        const result = await handleBrowserCommand(cmd, params || {});
        _bLog(`✓ cmd=${cmd} result=${JSON.stringify(result).slice(0, 200)} wsReady=${ws.readyState}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, result }));
          _bLog(`✓ sent result`);
        } else {
          _bLog(`✗ ws not ready (${ws.readyState}), result dropped`);
        }
      } catch (err) {
        _bLog(`✗ cmd=${cmd} error=${err.message}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, error: err.message }));
        }
      }
    });
    ws.on("close", () => {
      if (!isQuitting) {
        setTimeout(connect, 2000);
      }
    });
    ws.on("error", () => {}); // close event handles reconnect
  }

  connect();
}

// ── 创建 Onboarding 窗口 ──
// query: 可选的 URL 参数，如 { skipToTutorial: "1" } 或 { preview: "1" }
async function completeOnboardingAndOpenMain({ markSetupComplete = true } = {}) {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  if (markSetupComplete) {
    try {
      let prefs = {};
      try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch {}
      prefs.setupComplete = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
    } catch (err) {
      console.error("[desktop] Failed to write setupComplete:", err);
    }
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  const ready = await waitForMainWindowReady();
  if (!ready && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.show(); } catch {}
    return false;
  }
  return true;
}

function createOnboardingWindow(query = {}) {
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: "Lynn",
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F4F0E4",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadWindowURL(onboardingWindow, "onboarding", { query });

  onboardingWindow.once("ready-to-show", () => {
    // 关闭 splash，显示 onboarding
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    onboardingWindow.show();
  });

  onboardingWindow.on("focus", () => {
    markPreferredPrimaryWindow("onboarding");
  });

  onboardingWindow.on("closed", () => {
    if (preferredPrimaryWindowKind === "onboarding") {
      preferredPrimaryWindowKind = "main";
    }
    const shouldSkipIntoApp = query.preview !== "1" && !forceQuitApp && (!mainWindow || mainWindow.isDestroyed());
    onboardingWindow = null;
    if (shouldSkipIntoApp) {
      void completeOnboardingAndOpenMain({ markSetupComplete: true });
    }
  });
}

// ── 更新检查（统一走 auto-updater.cjs）──
async function checkForUpdates() {
  await checkForUpdatesAuto();
}

// ── IPC ──
wrapIpcHandler("get-server-port", () => serverController.getPort());
wrapIpcHandler("get-server-token", () => serverController.getToken());
wrapIpcHandler("get-app-version", () => app.getVersion());
wrapIpcHandler("cli:status", () => getCliEnvStatus());
wrapIpcHandler("wake-lock-set", (_event, payload = {}) => (
  setWakeLockReason(payload.reason, !!payload.active)
));
wrapIpcHandler("wake-lock-state", () => wakeLockState());
// 旧版兼容：check-update 返回 auto-updater 状态中的可用版本信息
const { getState: getUpdateState } = require("./auto-updater.cjs");
wrapIpcHandler("check-update", () => {
  const s = getUpdateState();
  if (s.status === "available" || s.status === "downloaded") {
    return { version: s.version, downloadUrl: s.downloadUrl || s.releaseUrl };
  }
  return null;
});

wrapIpcHandler("open-settings", (_event, tab, theme) => createSettingsWindow(tab, theme));
wrapIpcHandler("get-initial-settings-navigation-target", (event) => {
  if (!settingsWindow || settingsWindow.isDestroyed()) return null;
  if (event.sender !== settingsWindow.webContents) return null;
  const target = settingsWindowInitialNavigationTarget;
  settingsWindowInitialNavigationTarget = null;
  return target;
});

// 浏览器查看器窗口
wrapIpcHandler("open-browser-viewer", (_event, theme) => {
  if (theme) _browserViewerTheme = theme;
  createBrowserViewerWindow();
});
wrapIpcHandler("browser-go-back", () => { if (_browserWebView) _browserWebView.webContents.goBack(); });
wrapIpcHandler("browser-go-forward", () => { if (_browserWebView) _browserWebView.webContents.goForward(); });
wrapIpcHandler("browser-reload", () => { if (_browserWebView) _browserWebView.webContents.reload(); });
wrapIpcHandler("close-browser-viewer", () => {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.close();
});
wrapIpcHandler("browser-emergency-stop", () => {
  // 紧急停止：销毁当前浏览器实例，释放 AI 控制
  if (_browserWebView) {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
    }
    _browserWebView.webContents.close();
    if (_currentBrowserSession) {
      _browserViews.delete(_currentBrowserSession);
    }
    _browserWebView = null;
    _currentBrowserSession = null;
  }
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    browserViewerWindow.webContents.send("browser-update", { running: false });
  }
});

// ── 编辑器独立窗口 ──
let editorWindow = null;
let _editorFileData = null; // { filePath, title, type, language }

wrapIpcHandler("open-editor-window", (event, data) => {
  if (!data?.filePath || !canWritePath(event.sender, data.filePath).allowed) return;
  _editorFileData = data;
  if (editorWindow && !editorWindow.isDestroyed()) {
    grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
    editorWindow.show();
    editorWindow.focus();
    editorWindow.webContents.send("editor-load", data);
    return;
  }

  const isDark = nativeTheme.shouldUseDarkColors;
  const theme = isDark ? "midnight" : "warm-paper";

  editorWindow = new BrowserWindow({
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    title: data.title || "Editor",
    frame: false,
    backgroundColor: THEME_BG[theme] || THEME_BG["warm-paper"],
    hasShadow: true,
    show: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
  loadWindowURL(editorWindow, "editor-window");

  editorWindow.webContents.on("did-finish-load", () => {
    if (_editorFileData && editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.webContents.send("editor-load", _editorFileData);
    }
  });

  editorWindow.on("focus", () => {
    markPreferredPrimaryWindow("editor");
  });

  editorWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      editorWindow.hide();
      // 通知主窗口 editor 已关闭
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("editor-detached", false);
      }
    }
  });

  editorWindow.on("closed", () => {
    if (preferredPrimaryWindowKind === "editor") {
      preferredPrimaryWindowKind = "main";
    }
    editorWindow = null;
    _editorFileData = null;
    // 清理编辑器窗口关联的文件监听
    for (const [, watcher] of _fileWatchers) watcher.close();
    _fileWatchers.clear();
  });
});

wrapIpcHandler("editor-dock", () => {
  // 放回主面板：通知主窗口重新打开 preview，然后隐藏编辑器窗口
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("editor-detached", false);
    if (_editorFileData) {
      mainWindow.webContents.send("editor-dock-file", _editorFileData);
    }
  }
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.hide();
  }
});

wrapIpcHandler("editor-close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("editor-detached", false);
  }
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.hide();
  }
});

// 设置窗口 → 主窗口的消息转发
wrapIpcOn("settings-changed", (_event, type, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings-changed", type, data);
  }
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && settingsWindow.webContents.id !== _event.sender.id
  ) {
    settingsWindow.webContents.send("settings-changed", type, data);
  }
  if (type === "theme-changed" && data?.theme) {
    const name = data.theme;
    _browserViewerTheme = name === "auto"
      ? (nativeTheme.shouldUseDarkColors ? "midnight" : "warm-paper")
      : name;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send("settings-changed", type, data);
    }
  }
  if (type === "locale-changed") {
    resetMainI18n();
    // 重建托盘菜单，使标签跟随新 locale
    if (tray && !tray.isDestroyed()) {
      const buildMenu = () => Menu.buildFromTemplate([
        { label: mt("tray.show", null, "Show Lynn"), click: () => showPrimaryWindow() },
        { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
        { type: "separator" },
        { label: mt("tray.quit", null, "Quit"), click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
      ]);
      tray.setContextMenu(buildMenu());
    }
  }
});

// 获取头像本地路径（splash 用，不依赖 server）
wrapIpcHandler("get-avatar-path", (_event, role) => {
  if (role !== "agent" && role !== "user") return null;
  // First check the user-uploaded avatar slot (P2-3 onboarding upload).
  try {
    const uploadedDir = path.join(lynnHome, "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(uploadedDir, `${role}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const agentId = getCurrentAgentId();
  // agent 头像在 agents/{id}/avatars/，user 头像在 user/avatars/
  const baseDir = role === "user"
    ? path.join(lynnHome, "user")
    : agentId ? path.join(lynnHome, "agents", agentId) : null;
  if (!baseDir) return null;
  const avatarDir = path.join(baseDir, "avatars");
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const p = path.join(avatarDir, `${role}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
});

// P2-3: Upload a user-supplied avatar image into ~/.lynn/avatars/ keyed by role.
// Returns { ok, path } on success. Used by onboarding NameStep.
wrapIpcHandler("avatar:upload", async (event, role) => {
  try {
    if (role !== "agent" && role !== "user") return { ok: false, reason: "bad-role" };
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
      title: role === "user" ? "Select your avatar" : "Select agent avatar",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: "cancelled" };
    const src = filePaths[0];
    const stat = fs.statSync(src);
    // Reject anything larger than 8 MB so the renderer doesn't strain.
    if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: "too-large" };
    const ext = (path.extname(src) || ".png").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    const targetDir = path.join(lynnHome, "avatars");
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${role}${safeExt}`);
    // Remove any prior avatar (different ext) so lookup is unambiguous.
    for (const e of [".png", ".jpg", ".jpeg", ".webp"]) {
      const stale = path.join(targetDir, `${role}${e}`);
      if (stale !== targetPath) { try { fs.rmSync(stale, { force: true }); } catch {} }
    }
    fs.copyFileSync(src, targetPath);
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
});

// 读取 config.yaml 基本信息（splash 用，不依赖 server）
wrapIpcHandler("get-splash-info", () => {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "lynn" };
    const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
    const text = fs.readFileSync(configPath, "utf-8");
    // 简易提取：agent:\n  name: xxx / yuan: xxx 和顶层 locale: xxx
    const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
    const localeMatch = text.match(/^locale:\s*(.+)/m);
    const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
    return {
      agentName: agentMatch?.[1]?.trim() || null,
      locale: localeMatch?.[1]?.trim() || null,
      yuan: yuanMatch?.[1]?.trim() || "lynn",
    };
  } catch {
    return { agentName: null, locale: "zh-CN", yuan: "lynn" };
  }
});

// 选择文件夹（系统原生对话框）
wrapIpcHandler("select-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: mt("dialog.selectFolder", null, "Select Working Folder"),
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = result.filePaths[0];
  grantWebContentsAccess(event.sender, selectedPath, "readwrite");
  return selectedPath;
});

wrapIpcHandler("get-onboarding-defaults", () => {
  const desktopRoot = path.join(os.homedir(), "Desktop");
  const workspacePath = path.join(desktopRoot, "Lynn");
  const installRoot = path.resolve(process.cwd());
  try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
  return {
    workspacePath,
    desktopRoot,
    installRoot,
    trustedRoots: Array.from(new Set([desktopRoot, workspacePath].filter(Boolean))),
  };
});

// 选择技能文件/文件夹（支持 .zip / .skill / 文件夹）
wrapIpcHandler("select-skill", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectSkill", null, "Select Skill"),
    filters: [
      { name: "Skill", extensions: ["zip", "skill"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = result.filePaths[0];
  grantWebContentsAccess(event.sender, selectedPath, "read");
  return selectedPath;
});

wrapIpcHandler("select-gguf-model", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    title: "选择 GGUF 模型",
    filters: [
      { name: "GGUF Model", extensions: ["gguf"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const parsedPath = parseGgufModelPathPayload(result.filePaths[0]);
  if (!parsedPath.ok || !fs.existsSync(parsedPath.modelPath)) return null;
  grantWebContentsAccess(event.sender, parsedPath.modelPath, "read");
  return parsedPath.modelPath;
});

// ── Skill 预览窗口 IPC ──
wrapIpcHandler("open-skill-viewer", (event, data) => {
  if (!data) return;

  if (data.skillPath) {
    const skillPathAccess = canReadPath(event.sender, data.skillPath);
    if (!skillPathAccess.allowed) return;
  }

  if (data.baseDir) {
    const baseDirAccess = canReadPath(event.sender, data.baseDir);
    if (!baseDirAccess.allowed) return;
  }

  // .skill / .zip 文件 → 优先查找已安装目录，否则解压临时目录
  if (data.skillPath && path.isAbsolute(data.skillPath)) {
    const fileExt = path.extname(data.skillPath).toLowerCase();
    if (fileExt === ".skill" || fileExt === ".zip") {
      const baseName = path.basename(data.skillPath, fileExt);

      // 先检查同名 skill 是否已安装在 skills 目录
      const installedDir = path.join(lynnHome, "skills", baseName);
      if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
        grantWebContentsAccess(mainWindow, installedDir, "read");
        _showSkillViewer({ name: baseName, baseDir: installedDir, installed: false });
        return;
      }

      // 否则解压 .skill 文件
      if (!fs.existsSync(data.skillPath)) {
        console.warn("[skill-viewer] .skill file not found:", data.skillPath);
        return;
      }
      try {
        const { execFileSync } = require("child_process");
        const tmpDir = path.join(app.getPath("temp"), "hana-skill-preview-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === "win32") {
          execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ], { stdio: "ignore", windowsHide: true });
        } else {
          execFileSync("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
        }

        let skillDir = null;
        if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
          skillDir = tmpDir;
        } else {
          const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith("."));
          const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
          if (found) skillDir = path.join(tmpDir, found.name);
        }
        if (!skillDir) return;

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;

        grantWebContentsAccess(mainWindow, skillDir, "read");
        _showSkillViewer({ name, baseDir: skillDir, installed: false });
      } catch (err) {
        console.error("[skill-viewer] Failed to extract .skill file:", err.message);
      }
      return;
    }
  }

  if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
  grantWebContentsAccess(mainWindow, data.baseDir, "read");
  _showSkillViewer(data);
});

wrapIpcHandler("skill-viewer-list-files", (event, baseDir) => {
  const access = canReadPath(event.sender, baseDir);
  if (!baseDir || !path.isAbsolute(baseDir) || !access.allowed) return [];
  try {
    if (!fs.statSync(access.canonical).isDirectory()) return [];
    return scanSkillDir(access.canonical, access.canonical);
  } catch {
    return [];
  }
});

wrapIpcHandler("skill-viewer-read-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical, "utf-8");
  } catch {
    return null;
  }
});

// close-skill-viewer: overlay 模式下由渲染进程 setState 关闭，保留 handler 避免 preload 报错
wrapIpcHandler("close-skill-viewer", () => {});

// 在系统文件管理器中打开文件夹（限制为目录且为绝对路径）
wrapIpcHandler("open-folder", (event, folderPath) => {
  const access = canReadPath(event.sender, folderPath);
  if (!folderPath || !path.isAbsolute(folderPath) || !access.allowed) return;
  try {
    if (!fs.statSync(access.canonical).isDirectory()) return;
  } catch { return; }
  shell.openPath(access.canonical);
});

// 原生拖拽：书桌文件拖到 Finder / 聊天区
wrapIpcOn("start-drag", async (event, filePaths) => {
  const requestedPaths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const paths = requestedPaths
    .map(filePath => canReadPath(event.sender, filePath))
    .filter(result => result.allowed && result.canonical)
    .map(result => result.canonical);
  if (paths.length === 0) return;

  let icon;
  try {
    icon = await app.getFileIcon(paths[0], { size: "small" });
  } catch {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
    );
  }
  if (paths.length === 1) {
    event.sender.startDrag({ file: paths[0], icon });
  } else {
    event.sender.startDrag({ files: paths, icon });
  }
});

wrapIpcHandler("show-in-finder", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
  shell.showItemInFolder(access.canonical);
});

wrapIpcHandler("open-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
  try {
    if (!fs.statSync(access.canonical).isFile()) return;
  } catch { return; }
  shell.openPath(access.canonical);
});

const STANDALONE_HTML_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: https: file:; style-src 'unsafe-inline' https:; font-src https: data:; connect-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'\">";

function sanitizeStandaloneHtml(html) {
  let next = String(html || "").slice(0, 5 * 1024 * 1024);
  next = next
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<\s*(iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=\"#\"");

  if (/<head\b[^>]*>/i.test(next)) {
    return next.replace(/<head\b([^>]*)>/i, `<head$1>${STANDALONE_HTML_CSP}`);
  }
  return `${STANDALONE_HTML_CSP}\n${next}`;
}

wrapIpcHandler("open-html-in-browser", async (_event, html, title) => {
  if (typeof html !== "string" || !html) return;
  const safeTitle = String(title || "lynn-report").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const tmpFile = path.join(os.tmpdir(), `${safeTitle}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmpFile, sanitizeStandaloneHtml(html), "utf-8");
    await shell.openPath(tmpFile);
  } catch (err) {
    log.error("[open-html-in-browser]", err.message || err);
  }
});

/**
 * export-html-to-png — 用离屏 BrowserWindow 把 HTML 渲染为 PNG。
 *
 * 流程:
 *   1. sanitizeStandaloneHtml(html) 注入 CSP, 去 script / on* / iframe
 *   2. 写到 tmpFile, file:// 加载(支持长 HTML, 避开 data: URL 长度限制)
 *   3. 等 document.fonts.ready + 1.5s buffer (Google Fonts CDN)
 *   4. 测全文档高度, resize 离屏窗口
 *   5. capturePage() → PNG → 写到 ~/Downloads/<title>-<ts>.png
 *   6. 可选自动 showInFinder
 *
 * 安全: BrowserWindow webPreferences 关 nodeIntegration / contextIsolation,
 *       sandbox: true, 不加载 preload, 等价于普通浏览器 tab 的隔离。
 *       CSP script-src 'none' 阻止 HTML 内 inline script 执行。
 */
wrapIpcHandler("export-html-to-png", async (_event, html, title, opts = {}) => {
  if (typeof html !== "string" || !html) return null;
  const safeTitle = String(title || "lynn-export").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const width = Math.max(320, Math.min(opts.width || 1180, 4096));
  const tmpFile = path.join(os.tmpdir(), `lynn-png-${Date.now()}.html`);
  let win = null;
  try {
    fs.writeFileSync(tmpFile, sanitizeStandaloneHtml(html), "utf-8");

    win = new BrowserWindow({
      show: false,
      width,
      height: 800,
      useContentSize: true,
      backgroundColor: opts.background || "#ffffff",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true, // 仅用于 main → renderer 的 executeJavaScript 测高
        webSecurity: true,
      },
    });

    await win.loadFile(tmpFile);

    // 等字体加载(Google Fonts) + 短 buffer 给 layout 收敛
    try {
      await win.webContents.executeJavaScript(
        "(async () => { if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} } return true; })()",
        true,
      );
    } catch { /* fonts API 不可用就 fallback 到 timeout */ }
    await new Promise((r) => setTimeout(r, 1500));

    // 测全文档高度
    let fullHeight = 800;
    try {
      fullHeight = await win.webContents.executeJavaScript(
        "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 800)",
        true,
      );
    } catch { /* 测不到就用默认 800 */ }
    fullHeight = Math.min(Math.max(800, fullHeight), 32000); // 32k 像素上限

    win.setContentSize(width, fullHeight);
    await new Promise((r) => setTimeout(r, 300)); // 让 resize 后 reflow 收敛

    const image = await win.webContents.capturePage();
    const png = image.toPNG();

    const outDir = app.getPath("downloads") || os.tmpdir();
    fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `${safeTitle}-${Date.now()}.png`);
    fs.writeFileSync(filePath, png);

    if (opts.revealAfter !== false) {
      try { shell.showItemInFolder(filePath); } catch { /* finder 失败不致命 */ }
    }

    const size = image.getSize();
    return {
      filePath,
      bytes: png.length,
      width: size.width,
      height: size.height,
    };
  } catch (err) {
    log.error("[export-html-to-png]", err.message || err);
    return null;
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* destroy 失败忽略 */ }
    try { fs.unlinkSync(tmpFile); } catch { /* tmp 清理失败忽略 */ }
  }
});

wrapIpcHandler("save-file-dialog", async (event, opts = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    title: opts.title || mt("common.save", null, "Save"),
    defaultPath: opts.defaultPath,
    filters: Array.isArray(opts.filters) ? opts.filters : undefined,
  });
  if (result.canceled || !result.filePath) return null;
  grantWebContentsAccess(event.sender, result.filePath, "readwrite");
  return result.filePath;
});

wrapIpcHandler("open-external", (_event, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(url);
    }
  } catch {}
});

wrapIpcHandler("confirm-action", async (event, opts = {}) => {
  const sender = event.sender;
  const webContents = sender?.isDestroyed?.() ? null : sender;
  if (!webContents) return false;

  const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return await new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(false);
    }, 5 * 60 * 1000);

    const handleResponse = (respEvent, payload = {}) => {
      if (respEvent?.sender !== webContents) {
        console.warn("[confirm-action] rejected response from untrusted sender");
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(payload.approved === true);
    };

    ipcMain.once(`confirm-action-response:${requestId}`, handleResponse);

    try {
      webContents.send("confirm-action-request", {
        requestId,
        title: opts.title || "Lynn",
        message: opts.message || mt("common.confirm", null, "Confirm"),
        detail: opts.detail || "",
        confirmLabel: opts.confirmLabel || mt("common.confirm", null, "Confirm"),
        cancelLabel: opts.cancelLabel || mt("common.cancel", null, "Cancel"),
        tone: opts.tone === "danger" ? "danger" : "default",
      });
    } catch (err) {
      clearTimeout(timeout);
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(false);
    }
  });
});

// 读取文件内容（仅文本文件，用于 Artifacts 预览）
wrapIpcHandler("read-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 5 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical, "utf-8");
  } catch { return null; }
});

// 写入文本文件（artifact 编辑用）
wrapIpcHandler("write-file", (event, filePath, content) => {
  const access = canWritePath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed || typeof content !== "string") return false;
  try {
    fs.writeFileSync(access.canonical, content, "utf-8");
    return true;
  } catch { return false; }
});

// 文件监听（artifact 编辑 — 外部变更刷新用）
const _fileWatchers = new Map();
wrapIpcHandler("watch-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return false;
  if (_fileWatchers.has(access.canonical)) {
    _fileWatchers.get(access.canonical).close();
    _fileWatchers.delete(access.canonical);
  }
  try {
    const watcher = fs.watch(access.canonical, { persistent: false }, (eventType) => {
      if (eventType === "change") {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send("file-changed", access.canonical);
        }
      }
    });
    _fileWatchers.set(access.canonical, watcher);
    return true;
  } catch { return false; }
});

wrapIpcHandler("unwatch-file", (_event, filePath) => {
  const canonical = resolveCanonicalPath(filePath);
  if (canonical && _fileWatchers.has(canonical)) {
    _fileWatchers.get(canonical).close();
    _fileWatchers.delete(canonical);
  }
  return true;
});

// 读取二进制文件为 base64（图片、PDF 等）
wrapIpcHandler("read-file-base64", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical).toString("base64");
  } catch { return null; }
});

// 读取 docx 文件并转为 HTML（mammoth）
wrapIpcHandler("read-docx-html", async (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const mammoth = require("mammoth");
    const result = await mammoth.convertToHtml({ path: access.canonical });
    return result.value;
  } catch { return null; }
});

// 读取 xlsx 文件并转为 HTML 表格（ExcelJS）
wrapIpcHandler("read-xlsx-html", async (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(access.canonical);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) return null;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "<table>";
    sheet.eachRow((row) => {
      html += "<tr>";
      for (let i = 1; i <= sheet.columnCount; i++) {
        html += `<td>${esc(row.getCell(i).text)}</td>`;
      }
      html += "</tr>";
    });
    html += "</table>";
    return html;
  } catch { return null; }
});

wrapIpcHandler("grant-file-access", (event, filePath) => !!grantWebContentsAccess(event.sender, filePath, "read"));

// 重新加载主窗口（DevTools 用）
wrapIpcHandler("reload-main-window", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

function getNotificationPermissionStatus() {
  if (!Notification.isSupported()) return "unsupported";
  if (process.platform !== "darwin") return "granted";

  const settings = systemPreferences.getNotificationSettings?.();
  const status = settings?.authorizationStatus;
  if (status === "authorized" || status === "provisional" || status === "ephemeral") {
    return "granted";
  }
  if (status === "denied") return "denied";
  if (status === "not-determined") return "not-determined";
  return "granted";
}

async function requestNotificationPermission() {
  const currentStatus = getNotificationPermissionStatus();
  if (currentStatus !== "not-determined") return currentStatus;

  try {
    const notif = new Notification({
      title: "Lynn",
      body: mt("notification.ready", null, "Notifications enabled"),
      silent: true,
    });
    notif.show();
  } catch {}

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const nextStatus = getNotificationPermissionStatus();
    if (nextStatus !== "not-determined") return nextStatus;
  }

  return getNotificationPermissionStatus();
}

wrapIpcHandler("get-notification-permission-status", () => getNotificationPermissionStatus());
wrapIpcHandler("request-notification-permission", () => requestNotificationPermission());

// 系统通知（由 agent 的 notify 工具触发）
let _pendingNotificationCount = 0;
wrapIpcHandler("show-notification", (_event, title, body) => {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: title || "Lynn",
    body: body || "",
    silent: false,
  });
  notif.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();
  // Dock badge: 窗口不可见或未聚焦时累加 badge 数字
  if (process.platform === "darwin" && mainWindow && (!mainWindow.isVisible() || !mainWindow.isFocused())) {
    _pendingNotificationCount++;
    app.dock.setBadge(String(_pendingNotificationCount));
  }
});

// Debug: 打开 Onboarding 窗口（DevTools 用）
wrapIpcHandler("debug-open-onboarding", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow();
});

// Debug: 预览模式打开 Onboarding（不调 API 不写配置）
wrapIpcHandler("debug-open-onboarding-preview", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow({ preview: "1" });
});

// Onboarding 完成后，写标记 → 创建主窗口
wrapIpcHandler("onboarding-complete", async () => {
  return completeOnboardingAndOpenMain({ markSetupComplete: true });
});

// ── 窗口控制 IPC（Windows/Linux 自绘标题栏用）──
wrapIpcHandler("get-platform", () => process.platform);
wrapIpcHandler("get-global-summon-shortcut-status", () => globalSummonShortcutStatus);
wrapIpcHandler("set-global-summon-shortcut", (_event, accelerator) => {
  const configured = writeGlobalSummonShortcutPreference(accelerator);
  return registerGlobalSummon(configured);
});
wrapIpcHandler("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
wrapIpcHandler("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.restore(); else win?.maximize();
});
wrapIpcHandler("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
wrapIpcHandler("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

function isTrustedAppWebContents(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const owner = BrowserWindow.fromWebContents(webContents);
  if (
    owner === mainWindow ||
    owner === splashWindow ||
    owner === settingsWindow ||
    owner === onboardingWindow ||
    owner === browserViewerWindow ||
    owner === editorWindow
  ) {
    return true;
  }
  try {
    const url = webContents.getURL?.() || "";
    if (url.startsWith("file://")) return true;
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(url)) return true;
  } catch {}
  return false;
}

function installMediaPermissionHandlers() {
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission === "media") {
        const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
        const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes("audio");
        callback(Boolean(wantsAudio && isTrustedAppWebContents(webContents)));
        return;
      }
      callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
      if (permission !== "media") return false;
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes("audio");
      return Boolean(wantsAudio && isTrustedAppWebContents(webContents));
    });
  } catch (err) {
    console.warn("[desktop] install media permission handler failed:", err?.message || err);
  }
}

// 前端初始化完成后调用，关闭 splash / onboarding，显示主窗口
wrapIpcHandler("app-ready", () => {
  revealMainWindowAndCloseStartupShell("app-ready");
});

// ── Voice tunnel manager(2026-05-01)──────────────────────────────────
// 跨平台 ssh -L 守护(macOS / Windows / Linux 同源)。
//   macOS:已有 launchd `com.lynn.spark-asr-tunnel` watchdog 时,manager 自动 standby
//   Win/Linux:Lynn 自己 spawn ssh,跟 Lynn 生命周期绑
//   ENV LYNN_SKIP_VOICE_TUNNEL=1 → 完全禁用
let voiceTunnel = null;
function startVoiceTunnel() {
  if (voiceTunnel) return;
  try {
    voiceTunnel = new VoiceTunnelManager({
      onLog: (level, msg) => {
        if (level === "error") console.error(msg);
        else if (level === "warn") console.warn(msg);
        else console.log(msg);
      },
      onState: (state) => {
        // 状态广播给 renderer(供 Overlay 显示具体哪个端口断)
        try {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send("voice-tunnel-state", state);
          }
        } catch (err) {
          console.warn("[voice-tunnel] state broadcast failed:", err?.message || err);
        }
      },
    });
    void voiceTunnel.start();
  } catch (err) {
    console.warn("[voice-tunnel] start failed:", err?.message || err);
    voiceTunnel = null;
  }
}
function stopVoiceTunnel() {
  if (!voiceTunnel) return;
  try { voiceTunnel.stop(); } catch (err) {
    console.warn("[voice-tunnel] stop failed:", err?.message || err);
  }
  voiceTunnel = null;
}
wrapIpcHandler("voice-tunnel-status", () => (voiceTunnel ? voiceTunnel.getStatus() : { stopped: true }));

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

// ── App 生命周期 ──
app.whenReady().then(async () => {
  installMediaPermissionHandlers();

  // 设置应用菜单（macOS 需要 Edit 菜单才能使用 Cmd+C/V/A 等快捷键）
  const appMenu = Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  try {
    if (process.env.LYNN_UI_SMOKE === "1") {
      createMainWindow();
      return;
    }

    // 1. 立刻显示启动窗口
    createSplashWindow();
    const splashShownAt = Date.now();

    // 2. 后台启动 server
    console.log("[desktop] 启动 Lynn Server...");
    await startServer();
    console.log(`[desktop] Server 就绪，端口: ${serverController.getPort()}`);
    serverController.monitor();
    serverController.startHeartbeat();
    setupBrowserCommands();
    createTray();

    // 2b. 2026-05-01 — 启动 voice tunnel manager(跨平台 ssh 隧道守护)
    //     macOS 已有 launchd watchdog 时自动 standby + 仅监控;Win/Linux 接管 spawn。
    startVoiceTunnel();

    // 2c. Local GGUF is opt-in. Qwen3.5-9B occupies several GB of VRAM/UMA,
    // so app startup must never spawn llama.cpp unless the user explicitly
    // enabled it or an operator sets LYNN_LOCAL_MODEL_AUTO_START=1.
    if (process.env.LYNN_LOCAL_MODEL_AUTO_START === "1") {
      startLlamacpp();
    } else {
      lastLlamacppState = {
        status: "stopped",
        stopped: true,
        healthy: false,
        reason: "explicit-start-required",
        ts: Date.now(),
      };
      console.log("[llamacpp] startup auto-start disabled; waiting for explicit user action");
    }

    // #11: 2026-05-22 — resume-download relaunch hint
    // If a `.part` file exists in ~/.lynn/models/, surface it to UI so user can resume
    // (download was interrupted by app quit). Fire-and-forget — broadcast event,
    // renderer's onboarding/settings can subscribe to llamacpp:resume-hint.
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
        // Defer to next tick so windows are ready to receive
        setImmediate(() => {
          broadcastToAllWindows("llamacpp:resume-hint", { partFiles: stats });
        });
      }
    } catch (err) {
      console.warn("[resume-hint] check failed:", err?.message || err);
    }

    // 3. 控制 splash 最短停留时间。冷启动优化后不再额外卡住 3 秒。
    const elapsed = Date.now() - splashShownAt;
    const minSplashMs = 1200;
    if (elapsed < minSplashMs) {
      await new Promise(r => setTimeout(r, minSplashMs - elapsed));
    }

    // 4. 检测是否需要 onboarding
    if (isSetupComplete()) {
      // 已完成配置：直接创建主窗口
      createMainWindow();
    } else if (hasExistingConfig()) {
      // 老用户：已有 api_key，跳过填写直接看教程
      console.log("[desktop] 检测到已有配置，跳到教程页");
      createOnboardingWindow({ skipToTutorial: "1" });
    } else {
      // 全新用户：完整 onboarding 向导
      console.log("[desktop] 首次启动，显示 Onboarding 向导");
      createOnboardingWindow();
    }

    // 5. 注册全局快捷键唤醒 Jarvis Runtime overlay
    registerGlobalSummon();

    // 6. 后台检查更新（不阻塞启动）
    // 从 preferences.json 同步更新通道
    try {
      const prefsPath = path.join(lynnHome, "user", "preferences.json");
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        if (prefs.update_channel) setUpdateChannel(prefs.update_channel);
      }
    } catch {}
    checkForUpdates().catch(() => {});
  } catch (err) {
    console.error("[desktop] 启动失败:", err.message);
    // 写入 crash.log 并获取详细日志
    const crashInfo = writeCrashLog(err.message);
    // 截取最后 800 字符放进 dialog（太长会显示不全）
    const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
    dialog.showErrorBox(
      mt("dialog.launchFailedTitle", null, "Lynn Launch Failed"),
      mt("dialog.launchFailedBody", { detail: tail, logPath: path.join(lynnHome, "crash.log") })
    );
    forceQuitApp = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // 有托盘时保持常驻：macOS 通过 dock 重新打开，Windows 通过托盘双击
  // 托盘不存在时（创建失败或未初始化）直接退出，避免幽灵进程
  if (!tray || tray.isDestroyed()) {
    forceQuitApp = true;
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverController.getPort()) {
    if (isSetupComplete()) {
      createMainWindow();
      // 不在这里 show()，前端 init 完成后会通过 app-ready IPC 触发显示
    } else if (hasExistingConfig()) {
      createOnboardingWindow({ skipToTutorial: "1" });
    } else {
      createOnboardingWindow();
    }
  } else {
    showPrimaryWindow();
  }
});

// ── 全局快捷键唤醒 ──
let globalSummonShortcutStatus = {
  ok: false,
  accelerator: null,
  fallbackUsed: false,
  attempted: [],
  configured: null,
  defaultAccelerator: null,
  layer: null,
  errors: {},
};
let globalSummonRegisteredAccelerators = new Set();

function readGlobalSummonShortcutPreference() {
  const prefs = readUserPreferences();
  return normalizeConfiguredShortcut(prefs.jarvis_global_shortcut);
}

function writeGlobalSummonShortcutPreference(accelerator) {
  const prefs = readUserPreferences();
  const normalized = normalizeConfiguredShortcut(accelerator);
  if (normalized) {
    prefs.jarvis_global_shortcut = normalized;
  } else {
    delete prefs.jarvis_global_shortcut;
  }
  writeUserPreferences(prefs);
  return normalized;
}

function unregisterGlobalSummonShortcuts() {
  for (const accelerator of globalSummonRegisteredAccelerators) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {}
  }
  globalSummonRegisteredAccelerators.clear();
}

function toggleGlobalSummonWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    // Jarvis Runtime 快捷键只切换 overlay，不再隐藏/最小化主窗口。
    mainWindow.webContents.send("global-summon");
  } else {
    showPrimaryWindow();
  }
}

function registerGlobalSummon(configuredAccelerator = readGlobalSummonShortcutPreference()) {
  unregisterGlobalSummonShortcuts();
  const result = registerFirstAvailableGlobalShortcut(
    globalShortcut,
    toggleGlobalSummonWindow,
    process.platform,
    configuredAccelerator
  );
  globalSummonShortcutStatus = result;
  globalSummonRegisteredAccelerators = new Set(result.attempted || []);
  if (result.ok) {
    const layer = result.layer === "configured" ? " (custom)" : result.fallbackUsed ? " (fallback)" : "";
    console.log(`[desktop] 全局快捷键 ${result.accelerator} 已注册${layer}`);
  } else {
    console.warn(`[desktop] 全局快捷键注册失败（已尝试: ${result.attempted.join(", ")}）`);
  }
  return result;
}

// ── 优雅关闭 ──
app.on("will-quit", () => {
  serverController.stopHeartbeat();
  wakeLockReasons.clear();
  refreshWakeLock();
  globalShortcut.unregisterAll();
  // 销毁托盘图标
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  isExitingServer = true; // Cmd+Q 走完全退出路径，连 server 一起关

  // 2026-05-01 — 停 voice tunnel manager(kill 子 ssh)
  stopVoiceTunnel();

  // 2026-05-20 — 停 llama.cpp local 推理(SIGTERM → 5s SIGKILL)
  stopLlamacpp();
  stopManagedQwen35LlamaServer();

  // 立刻隐藏所有窗口，让用户感觉已退出，server 清理在后台进行
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide();
  }

  // 完全退出：清理浏览器实例（仅在真正退出时执行，避免隐藏路径打断后台浏览器能力）
  for (const [sp, view] of _browserViews) {
    try { view.webContents.close(); } catch {}
  }
  _browserViews.clear();
  _browserWebView = null;
  _currentBrowserSession = null;

  // 完全退出：同时关闭 server
  if (serverController.hasServer()) {
    event.preventDefault();
    await serverController.shutdown();
    app.quit();
  }
});

// ── 全局错误兜底（结构化日志）──
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] uncaughtException: ${err.message}`);
  console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] unhandledRejection: ${err.message}`);
  console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
});
