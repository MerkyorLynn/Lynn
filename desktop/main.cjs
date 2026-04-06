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
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification } = require("electron");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const yaml = require("js-yaml");
const { initAutoUpdater, checkForUpdatesAuto, setMainWindow: setUpdaterMainWindow, setUpdateChannel } = require("./auto-updater.cjs");
const { wrapIpcHandler, wrapIpcOn } = require('./ipc-wrapper.cjs');

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

let browserViewerWindow = null;
let _browserWebView = null;        // 当前活跃的 WebContentsView
const _browserViews = new Map();   // sessionPath → WebContentsView（挂起的浏览器）
let _currentBrowserSession = null; // 当前浏览器绑定的 sessionPath

/** Vite 入口页面统一加载（dev → Vite dev server，prod → dist-renderer，fallback → src） */
const _isDev = process.argv.includes("--dev");
const _distRenderer = path.join(__dirname, "dist-renderer");

function loadWindowURL(win, pageName, opts) {
  if (_isDev && process.env.VITE_DEV_URL) {
    let url = `${process.env.VITE_DEV_URL}/${pageName}.html`;
    if (opts?.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }
    win.loadURL(url);
  } else {
    const built = path.join(_distRenderer, `${pageName}.html`);
    if (!_isDev && fs.existsSync(built)) {
      win.loadFile(built, opts);
    } else {
      win.loadFile(path.join(__dirname, "src", `${pageName}.html`), opts);
    }
  }
}

/** 校验浏览器 URL：仅允许 http/https */
function isAllowedBrowserUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch { return false; }
}
let _browserViewerTheme = "warm-paper"; // 当前主题（用于 backgroundColor）
const TITLEBAR_HEIGHT = 44;        // 浏览器窗口标题栏高度（px）
let serverProcess = null;
let serverPort = null;
let serverToken = null;
let isQuitting = false;  // 区分关窗口（hide）和真正退出（quit）
let tray = null;
let reusedServerPid = null; // 复用已有 server 时记录其 PID，退出时发 SIGTERM
let isExitingServer = false; // 只有托盘"退出"时才 kill server，其余路径仅关前端
let forceQuitApp = false;   // 启动失败等场景需要真正退出，绕过"隐藏保持运行"拦截
let _localAuthHeaderHookInstalled = false;

// ── 主进程 i18n ──
// 从 agent config.yaml 读取 locale，加载对应语言包的 "main" 部分
let _mainI18nData = null;

function _resolveLocaleKey(locale) {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

function _getMainI18n() {
  if (_mainI18nData) return _mainI18nData;
  try {
    // 从 preferences.json 读取全局 locale（和 server/renderer 一致）
    let locale = null;
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(lynnHome, "preferences.json"), "utf-8"));
      locale = prefs.locale || null;
    } catch { /* preferences.json 不存在时 fallback */ }
    const key = _resolveLocaleKey(locale);
    const file = path.join(__dirname, "src", "locales", `${key}.json`);
    const all = JSON.parse(fs.readFileSync(file, "utf-8"));
    _mainI18nData = all.main || {};
  } catch {
    _mainI18nData = {};
  }
  return _mainI18nData;
}

/**
 * 主进程翻译函数
 * @param {string} dotPath  如 "tray.show" → main.tray.show
 * @param {object} [vars]   占位符变量 {key: value}
 * @param {string} [fallback] 找不到时的回退文本
 */
function mt(dotPath, vars, fallback) {
  const data = _getMainI18n();
  const val = dotPath.split(".").reduce((obj, k) => obj?.[k], data);
  let text = (typeof val === "string") ? val : (fallback || dotPath);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return text;
}

/** 重置 i18n 缓存（locale 变更时调用） */
function resetMainI18n() { _mainI18nData = null; }

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

function shouldAttachLocalAuthHeader(urlString) {
  try {
    const parsed = new URL(urlString);
    const isLocalHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    return parsed.protocol === "http:" && isLocalHost && (!serverPort || parsed.port === String(serverPort));
  } catch {
    return false;
  }
}

function ensureLocalAuthHeaderHook() {
  if (_localAuthHeaderHookInstalled || !session.defaultSession) return;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
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

function normalizePolicyPath(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function resolveCanonicalPath(rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const absolute = path.resolve(trimmed);
  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (err?.code !== "ENOENT") return null;

    const pending = [];
    let current = absolute;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      pending.unshift(path.basename(current));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...pending);
      } catch (parentErr) {
        if (parentErr?.code !== "ENOENT") return null;
        current = parent;
      }
    }
  }
}

function isPathInsideRoot(targetPath, rootPath) {
  const target = normalizePolicyPath(path.resolve(targetPath));
  const root = normalizePolicyPath(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function uniqueCanonicalPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const canonical = resolveCanonicalPath(p);
    if (!canonical) continue;
    const key = normalizePolicyPath(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

function readUserPreferences() {
  return safeReadJSON(path.join(lynnHome, "user", "preferences.json"), {}) || {};
}

function writeUserPreferences(nextPrefs) {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(nextPrefs, null, 2) + "\n", "utf-8");
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
  const prefs = readUserPreferences();
  const normalize = (value) => {
    const text = String(value || "").trim();
    return text ? text.replace(/\/+$/, "") : "";
  };
  const persistedApiRoot = normalize(prefs.brain_api_root || prefs.default_model_api_root);
  const derivedApiRoot = persistedApiRoot || deriveBrainApiRootFromProviders();
  if (!persistedApiRoot && derivedApiRoot) {
    writeUserPreferences({ ...prefs, brain_api_root: derivedApiRoot });
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
 * 只看 preferences.json 的 setupComplete 标记
 */
function isSetupComplete() {
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")).setupComplete === true;
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
    return /api_key:\s*["']?[^"'\s]+/.test(configText);
  } catch {}
  return false;
}

// ── 启动 Server ──
// 收集 server 的 stdout/stderr 用于崩溃诊断
let _serverLogs = [];

/**
 * 轮询 server-info.json 等待 server 就绪
 */
function pollServerInfo(infoPath, { timeout = 60000, interval = 200, process: proc } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let exited = false;

    if (proc) {
      proc.on("exit", (code, signal) => {
        exited = true;
        reject(new Error(
          signal
            ? mt("dialog.serverKilledBySignal", { signal })
            : mt("dialog.serverExitedWithCode", { code })
        ));
      });
    }

    const check = () => {
      if (exited) return;
      if (Date.now() > deadline) {
        reject(new Error(mt("dialog.serverStartTimeout", null, "Server start timed out (60s)")));
        return;
      }
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        // 确认 PID 存活
        try { process.kill(info.pid, 0); } catch { setTimeout(check, interval); return; }
        resolve(info);
      } catch {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

async function startServer() {
  const serverInfoPath = path.join(lynnHome, "server-info.json");

  // ── 1. 检查是否有已运行的 server（Electron crash 后遗留的守护进程） ──
  let existingInfo = null;
  try {
    existingInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
  } catch { /* 文件不存在或解析失败，启动新 server */ }

  if (existingInfo) {
    const pidAlive = (() => {
      try { process.kill(existingInfo.pid, 0); return true; } catch { return false; }
    })();

    if (pidAlive) {
      // PID 存活，尝试 health check
      let reused = false;
      try {
        const res = await fetch(`http://127.0.0.1:${existingInfo.port}/api/health`, {
          headers: { Authorization: `Bearer ${existingInfo.token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          console.log(`[desktop] 复用已运行的 server，端口: ${existingInfo.port}`);
          serverPort = existingInfo.port;
          serverToken = existingInfo.token;
          reusedServerPid = existingInfo.pid;
          // 复用现有 server 时也要给本地子资源请求补认证头，避免 avatar/img 等 403。
          ensureLocalAuthHeaderHook();
          reused = true;
        }
      } catch { /* health check 网络抖动，继续 kill 旧 server */ }

      if (reused) return; // 跳过启动

      // PID 存活但 health 失败（无响应或异常）：主动 kill，避免双 server 并存
      console.log(`[desktop] 旧 server (PID ${existingInfo.pid}) 无响应，正在终止...`);
      killPid(existingInfo.pid);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { process.kill(existingInfo.pid, 0); } catch { break; }
        await new Promise(r => setTimeout(r, 100));
      }
      killPid(existingInfo.pid, true);
    }

    // PID 已死或已 kill，删除脏文件
    try { fs.unlinkSync(serverInfoPath); } catch {}
  }

  // ── 2. 启动新 server ──
  _serverLogs = [];

  const serverEnv = { ...process.env, LYNN_HOME: lynnHome };
  const brainRuntime = readBrainRuntimeConfig();
  if (brainRuntime.apiRoot) serverEnv.BRAIN_API_ROOT_URL = brainRuntime.apiRoot;
  if (brainRuntime.host) serverEnv.BRAIN_API_HOST = brainRuntime.host;
  if (brainRuntime.legacyApiRoot) serverEnv.BRAIN_LEGACY_API_ROOT_URL = brainRuntime.legacyApiRoot;
  if (brainRuntime.legacyHost) serverEnv.BRAIN_LEGACY_HOST = brainRuntime.legacyHost;

  // Windows: 注入 MinGit 路径
  if (process.platform === "win32") {
    // MinGit-busybox 结构：cmd/git.exe, mingw64/bin/git.exe+sh.exe
    const gitRoot = path.join(process.resourcesPath || "", "git");
    const gitPaths = [
      path.join(gitRoot, "mingw64", "bin"),
      path.join(gitRoot, "cmd"),
    ].filter(p => fs.existsSync(p));
    if (gitPaths.length) {
      // Windows 的 PATH 环境变量 key 可能是 "Path"（title case）或 "PATH"，
      // { ...process.env } 展开后变成普通对象（区分大小写）。
      // 必须找到原始 key 并删除，否则会同时存在 Path 和 PATH 两个 key，
      // 导致 spawn 子进程的 PATH 不可预测。
      const pathKey = Object.keys(serverEnv).find(k => k.toLowerCase() === "path") || "PATH";
      const existingPath = serverEnv[pathKey] || "";
      if (pathKey !== "PATH") delete serverEnv[pathKey];
      serverEnv.PATH = gitPaths.join(";") + ";" + existingPath;
    }
  }

  // 选择 server 启动方式
  let serverBin, serverArgs;
  const bundledServerDir = path.join(process.resourcesPath || "", "server");
  const bundledWrapper = path.join(bundledServerDir, "lynn-server");
  const bundledExe = path.join(bundledServerDir, "lynn-server.exe");
  const bundledNode = path.join(bundledServerDir, process.platform === "win32" ? "lynn-server.exe" : "node");
  const bundledEntry = path.join(bundledServerDir, "bundle", "index.js");
  const hasBundledWrapper = fs.existsSync(bundledWrapper) || fs.existsSync(bundledExe);
  const hasBundledNodeRuntime = fs.existsSync(bundledNode) && fs.existsSync(bundledEntry);

  if (hasBundledWrapper || hasBundledNodeRuntime) {
    // 打包模式：优先使用 extraResources 里的独立 server
    // 兼容两种产物：
    // 1. 旧结构：macOS/Linux 使用 lynn-server shell wrapper；Windows 使用 lynn-server.exe
    // 2. 新结构：直接带 node/lynn-server.exe + bundle/index.js
    if (process.platform === "win32") {
      serverBin = fs.existsSync(bundledExe) ? bundledExe : bundledNode;
      serverArgs = [bundledEntry];
    } else if (fs.existsSync(bundledWrapper)) {
      serverBin = bundledWrapper;
      serverArgs = [];
    } else {
      serverBin = bundledNode;
      serverArgs = [bundledEntry];
    }
    serverEnv.HANA_ROOT = bundledServerDir;
  } else {
    // 开发模式：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）跑源码
    // native addon（better-sqlite3 等）通过 electron-rebuild 编译到对应 ABI，
    // 必须用 Electron 的 Node 才能加载，用系统 node 会 ABI 不匹配
    serverBin = process.execPath;
    serverArgs = [path.join(__dirname, "..", "server", "index.js")];
    serverEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  // 删除旧 server-info.json
  try { fs.unlinkSync(serverInfoPath); } catch {}

  serverProcess = spawn(serverBin, serverArgs, {
    detached: true,
    windowsHide: true,
    env: serverEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // 捕获 stdout/stderr 到 buffer（打包后 console 不可见，崩溃时需要这些信息）
  serverProcess.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    try { process.stdout.write(text); } catch {}
    _serverLogs.push(text);
    if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    try { process.stderr.write(text); } catch {}
    _serverLogs.push("[stderr] " + text);
    if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
  });

  // 等待 server ready（通过轮询 server-info.json）
  const info = await pollServerInfo(serverInfoPath, {
    timeout: 60000,
    process: serverProcess,
  });
  serverPort = info.port;
  serverToken = info.token;
  ensureLocalAuthHeaderHook();
  serverProcess.unref(); // 脱离 Electron 事件循环，允许 Electron 独立退出
}

/**
 * 持久监控 server 进程：崩溃后自动重启一次，再失败则写 crash log 并通知用户
 */
let _serverRestartAttempts = 0;
function monitorServer() {
  if (!serverProcess) return;
  serverProcess.on("exit", async (code, signal) => {
    if (isQuitting) return; // 正常退出流程
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`[desktop] Server 意外退出 (${reason})`);

    if (_serverRestartAttempts < 1) {
      _serverRestartAttempts++;
      console.log("[desktop] 尝试自动重启 Server...");
      try {
        await startServer();
        console.log("[desktop] Server 重启成功");
        monitorServer(); // 重新挂监控
        // 通知前端重连
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
        }
        // 设置窗口也需要知道新端口（否则旧端口的 API 全部失败）
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
        }
      } catch (err) {
        console.error("[desktop] Server 重启失败:", err.message);
        writeCrashLog(`Server 重启失败: ${err.message}`);
        dialog.showErrorBox("Lynn Server", mt("dialog.serverRestartFailed", { error: err.message }));
      }
    } else {
      writeCrashLog(`Server 多次崩溃 (${reason})，放弃重启`);
      dialog.showErrorBox("Lynn Server", mt("dialog.serverMultipleCrash", { reason }));
    }
  });
}

/**
 * 显示当前最相关窗口
 */
function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = settingsWindow || onboardingWindow || browserViewerWindow || mainWindow;
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
  const logs = _serverLogs.join("");
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
  initAutoUpdater(mainWindow);

  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  loadWindowURL(mainWindow, "index");

  // 前端初始化超时保护：30 秒内没收到 app-ready 就强制显示（防止用户卡在空白）
  const initTimeout = setTimeout(() => {
    console.warn("[desktop] ⚠ 主窗口初始化超时（30s），强制显示");
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 30000);
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
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // renderer 已崩溃：销毁旧窗口，走下方重建流程
    if (settingsWindow.webContents.isCrashed()) {
      console.warn("[desktop] settings renderer 已崩溃，重建窗口");
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

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 700,
    minWidth: 720,
    maxWidth: 720,
    minHeight: 500,
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
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
  });

  loadWindowURL(settingsWindow, "settings");

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
    settingsWindowInitialNavigationTarget = null;
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
const SNAPSHOT_SCRIPT = `(function() {
  var ref = 0;
  var MAX_TREE = 30000;
  document.querySelectorAll('[data-hana-ref]').forEach(function(el) {
    el.removeAttribute('data-hana-ref');
  });

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isInteractive(el) {
    var t = el.tagName;
    if (['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY'].indexOf(t) !== -1) return true;
    var r = el.getAttribute('role');
    if (r && ['button','link','menuitem','tab','checkbox','radio','textbox','combobox','listbox','option','switch','slider','treeitem'].indexOf(r) !== -1) return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    if (el.contentEditable === 'true') return true;
    if (el.tabIndex > 0) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer' && !el.closest('a,button')) return true; } catch(e) {}
    return false;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  // 结构签名：只看直接子元素的 tag 序列，用于检测同构兄弟
  function sig(el) {
    if (el.nodeType !== 1 || !isVisible(el)) return null;
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return null;
    var s = tag;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.nodeType === 1 && isVisible(c) && ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(c.tagName) === -1) {
        s += ',' + c.tagName;
      }
    }
    return s;
  }

  // 单行紧凑格式：链接 | 按钮 | 文本1 · 文本2
  function compact(el, depth) {
    var links = [], ctrls = [], texts = [];
    function collect(node) {
      if (node.nodeType !== 1 || !isVisible(node)) return;
      var tag = node.tagName;
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return;
      if (isInteractive(node)) {
        ref++;
        node.setAttribute('data-hana-ref', String(ref));
        var name = node.getAttribute('aria-label') || node.title || node.placeholder
          || (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || node.value || '';
        if (tag === 'A' || node.getAttribute('role') === 'link') {
          links.push('[' + ref + '] "' + name + '"');
        } else {
          ctrls.push('[' + ref + '] ' + name);
        }
        return; // 交互元素的子树已被 textContent 捕获，不再递归
      }
      var txt = directText(node);
      if (txt && txt.length > 2) texts.push(txt);
      for (var i = 0; i < node.children.length; i++) collect(node.children[i]);
    }
    collect(el);
    if (!links.length && !ctrls.length && !texts.length) return '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';
    var parts = links.concat(ctrls);
    var line = parts.join(' | ');
    if (texts.length) line += (line ? ' | ' : '') + texts.join(' \\u00b7 ');
    return pad + line + '\\n';
  }

  // 分组遍历：连续 ≥3 个同构兄弟用 compact，其余正常 walk
  function walkChildren(el, depth) {
    var out = '';
    var children = [], sigs = [];
    for (var i = 0; i < el.children.length; i++) {
      children.push(el.children[i]);
      sigs.push(sig(el.children[i]));
    }
    var g = 0;
    while (g < children.length) {
      if (!sigs[g]) { out += walk(children[g], depth); g++; continue; }
      var end = g + 1;
      while (end < children.length && sigs[end] === sigs[g]) end++;
      if (end - g >= 3) {
        for (var k = g; k < end; k++) out += compact(children[k], depth);
      } else {
        for (var k = g; k < end; k++) out += walk(children[k], depth);
      }
      g = end;
    }
    return out;
  }

  function walk(el, depth) {
    if (el.nodeType !== 1) return '';
    if (!isVisible(el)) return '';
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return '';

    var out = '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';

    var interactive = isInteractive(el);
    if (interactive) {
      ref++;
      el.setAttribute('data-hana-ref', String(ref));
      var role = el.getAttribute('role') || tag.toLowerCase();
      var name = el.getAttribute('aria-label') || el.title || el.placeholder || directText(el) || el.value || '';
      var label = name.slice(0, 60);

      var flags = [];
      if (el.type && el.type !== 'submit' && tag === 'INPUT') flags.push(el.type);
      if (tag === 'INPUT' && el.value) flags.push('value="' + el.value.slice(0,30) + '"');
      if (el.checked) flags.push('checked');
      if (el.disabled) flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
      if (tag === 'A' && el.href) flags.push('href="' + el.href.slice(0,80) + '"');

      var extra = flags.length ? ' (' + flags.join(', ') + ')' : '';
      out += pad + '[' + ref + '] ' + role + ' "' + label + '"' + extra + '\\n';
    } else if (/^H[1-6]/.test(tag)) {
      var hText = directText(el);
      if (hText) out += pad + tag.toLowerCase() + ': ' + hText + '\\n';
    } else if (tag === 'IMG') {
      out += pad + 'img "' + (el.alt || '').slice(0,40) + '"\\n';
    } else if (['P','SPAN','DIV','LI','TD','TH','LABEL'].indexOf(tag) !== -1) {
      var txt = directText(el);
      if (txt && txt.length > 2 && !el.querySelector('a,button,input,textarea,select,[role]')) {
        out += pad + 'text: ' + txt + '\\n';
      }
    }

    out += walkChildren(el, interactive ? depth + 1 : depth);
    return out;
  }

  var tree = walk(document.body, 0);

  // 硬上限：超过 MAX_TREE 时保留头部 80% + 尾部 20%，在行边界截断
  if (tree.length > MAX_TREE) {
    var h = tree.lastIndexOf('\\n', Math.floor(MAX_TREE * 0.8));
    if (h < MAX_TREE * 0.4) h = Math.floor(MAX_TREE * 0.8);
    var tl = tree.indexOf('\\n', tree.length - Math.floor(MAX_TREE * 0.2));
    if (tl < 0) tl = tree.length - Math.floor(MAX_TREE * 0.2);
    tree = tree.slice(0, h) + '\\n\\n[... ' + (tl - h) + ' chars omitted ...]\\n\\n' + tree.slice(tl);
  }

  return {
    title: document.title,
    currentUrl: location.href,
    text: 'Page: ' + document.title + '\\nURL: ' + location.href + '\\n\\n' + tree
  };
})()`;

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
    case "evaluate": {
      if (!params.expression || params.expression.length > 10000) {
        throw new Error("Expression too long (max 10000 chars)");
      }
      console.log(`[browser:evaluate] ${params.expression.slice(0, 200)}${params.expression.length > 200 ? "..." : ""}`);
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

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

// ── 更新检查（统一走 auto-updater.cjs）──
async function checkForUpdates() {
  await checkForUpdatesAuto();
}

// ── IPC ──
wrapIpcHandler("get-server-port", () => serverPort);
wrapIpcHandler("get-server-token", () => serverToken);
wrapIpcHandler("get-app-version", () => app.getVersion());
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

// 读取 config.yaml 基本信息（splash 用，不依赖 server）
wrapIpcHandler("get-splash-info", () => {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "hanako" };
    const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
    const text = fs.readFileSync(configPath, "utf-8");
    // 简易提取：agent:\n  name: xxx / yuan: xxx 和顶层 locale: xxx
    const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
    const localeMatch = text.match(/^locale:\s*(.+)/m);
    const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
    return {
      agentName: agentMatch?.[1]?.trim() || null,
      locale: localeMatch?.[1]?.trim() || null,
      yuan: yuanMatch?.[1]?.trim() || "hanako",
    };
  } catch {
    return { agentName: null, locale: "zh-CN", yuan: "hanako" };
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

    const handleResponse = (_respEvent, payload = {}) => {
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
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch {}
    prefs.setupComplete = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("[desktop] Failed to write setupComplete:", err);
  }
  // 创建主窗口（隐藏），前端 init 完成后通过 app-ready 显示
  createMainWindow();
  const ready = await waitForMainWindowReady();
  if (!ready && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.show(); } catch {}
    return false;
  }
  return true;
});

// ── 窗口控制 IPC（Windows/Linux 自绘标题栏用）──
wrapIpcHandler("get-platform", () => process.platform);
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

// 前端初始化完成后调用，关闭 splash / onboarding，显示主窗口
wrapIpcHandler("app-ready", () => {
  if (mainWindow) {
    mainWindow.show();
  }
  resolveMainWindowReady(true);

  // 稍微延迟关闭 splash / onboarding，让主窗口先稳定显示
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
  }, 200);
});

// ── App 生命周期 ──
app.whenReady().then(async () => {
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
    // 1. 立刻显示启动窗口
    createSplashWindow();
    const splashShownAt = Date.now();

    // 2. 后台启动 server
    console.log("[desktop] 启动 Lynn Server...");
    await startServer();
    console.log(`[desktop] Server 就绪，端口: ${serverPort}`);
    monitorServer();
    setupBrowserCommands();
    createTray();

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

    // 5. 注册全局快捷键 ⌥Space 唤醒 Lynn
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
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
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
function registerGlobalSummon() {
  const SHORTCUT = process.platform === "darwin" ? "Alt+Space" : "Alt+Space";
  const registered = globalShortcut.register(SHORTCUT, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
        // 通知前端聚焦输入框
        mainWindow.webContents.send("global-summon");
      }
    } else {
      showPrimaryWindow();
    }
  });
  if (registered) {
    console.log(`[desktop] 全局快捷键 ${SHORTCUT} 已注册`);
  } else {
    console.warn(`[desktop] 全局快捷键 ${SHORTCUT} 注册失败（可能已被其他应用占用）`);
  }
}

// ── 优雅关闭 ──
app.on("will-quit", () => {
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
  if (serverProcess && !serverProcess.killed) {
    event.preventDefault();
    console.log("[desktop] 正在关闭 Server...");

    if (process.platform === "win32") {
      // Windows：用 HTTP 关闭（信号不可靠）
      try {
        await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serverToken}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    } else {
      // macOS/Linux：SIGTERM
      try { serverProcess.kill("SIGTERM"); } catch {}
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill();
        }
        resolve();
      }, 5000);

      serverProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    serverProcess = null;
    app.quit();
  } else if (reusedServerPid) {
    // 复用路径：通过 HTTP 接口优雅关闭（跨平台可靠，不依赖信号）
    event.preventDefault();
    console.log("[desktop] 正在关闭复用的 Server...");
    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // HTTP 失败则回退到 kill
      killPid(reusedServerPid);
    }

    // 轮询等待进程退出（最多 5 秒）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(reusedServerPid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 200));
    }
    killPid(reusedServerPid, true); // 超时则强制
    reusedServerPid = null;
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
