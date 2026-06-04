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
const { getCliEnvStatus, getWorkerSpawnServerEnv } = require("./cli-env-manager.cjs");
const { createBrowserAgentController } = require("./browser-agent.cjs");
const { createFileIpcController } = require("./file-ipc.cjs");
const { createLocalModelController } = require("./local-model-controller.cjs");
const { createWindowLoader } = require("./window-loader.cjs");
const { createWakeLockController } = require("./wake-lock-controller.cjs");
const { createDesktopAccessPolicy } = require("./desktop-access-policy.cjs");
const { createEditorWindowController } = require("./editor-window-controller.cjs");
const { createNotificationController } = require("./notification-controller.cjs");
const { createVoiceTunnelController } = require("./voice-tunnel-controller.cjs");
const { createGlobalSummonController } = require("./global-summon-controller.cjs");
const { createSettingsOnboardingController } = require("./settings-onboarding-controller.cjs");
const { createTrayController } = require("./tray-controller.cjs");
const { createCrashLogWriter } = require("./crash-log-writer.cjs");
const { createWindowStateController } = require("./window-state-controller.cjs");
const { createSplashWindow: createSplashWindowView } = require("./splash-window-controller.cjs");
const { installAppMenu } = require("./app-menu.cjs");
const { installMediaPermissionHandlers } = require("./media-permission-controller.cjs");
const pathPolicy = require("./path-policy.cjs");
const brainUrlPolicy = require("./brain-url-policy.cjs");

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
let _mainWindowReadyWaiters = [];

let preferredPrimaryWindowKind = "main";

let browserAgent = null;
let editorController = null;
let settingsOnboarding = null;

setIpcSenderValidator((channel, event) => isTrustedAppWebContents(event?.sender, channel));

const wakeLock = createWakeLockController({ powerSaveBlocker });

const {
  loadWindowErrorPage,
  loadWindowURL,
  getWindowEntryStamp,
} = createWindowLoader({
  dirname: __dirname,
  fs,
  isDev: process.argv.includes("--dev"),
  viteDevUrl: process.env.VITE_DEV_URL || "",
});

/** 校验浏览器 URL：仅允许 http/https */
// SSRF-guarded URL check for the model-driven browser agent (see browser-url-guard.cjs).
const { isAllowedBrowserUrl } = require("./browser-url-guard.cjs");
const TITLEBAR_HEIGHT = 44;        // 浏览器窗口标题栏高度（px）
let isQuitting = false;  // 区分关窗口（hide）和真正退出（quit）
let isExitingServer = false; // 只有托盘"退出"时才 kill server，其余路径仅关前端
let forceQuitApp = false;   // 启动失败等场景需要真正退出，绕过"隐藏保持运行"拦截
let _localAuthHeaderHookInstalled = false;

const accessPolicy = createDesktopAccessPolicy({
  fs,
  os,
  yaml,
  lynnHome,
  pathPolicy,
  brainUrlPolicy,
});
const {
  readUserPreferences,
  writeUserPreferences,
  readBrainRuntimeConfig,
  getCurrentAgentId,
  readCurrentAgentConfig,
  grantWebContentsAccess,
  canReadPath,
  canWritePath,
  resolveCanonicalPath,
  isPathInsideRoot,
  isSetupComplete,
  hasExistingConfig,
} = accessPolicy;

// ── 主进程 i18n ──
// 从 agent config.yaml 读取 locale，加载对应语言包的 "main" 部分
// 主进程 i18n 已抽到 main-i18n.cjs（注入 lynnHome + localesDir）。
const { createMainI18n } = require("./main-i18n.cjs");
const { mt, resetMainI18n } = createMainI18n({ lynnHome, localesDir: path.join(__dirname, "src", "locales") });

const notificationController = createNotificationController({
  app,
  Notification,
  systemPreferences,
  wrapIpcHandler,
  mt,
  getMainWindow: () => mainWindow,
});

const voiceTunnelController = createVoiceTunnelController({
  BrowserWindow,
  VoiceTunnelManager,
  wrapIpcHandler,
});
voiceTunnelController.register();

const trayController = createTrayController({
  Menu,
  Tray,
  fs,
  dirname: __dirname,
  lynnHome,
  mt,
  nativeImage,
  onQuit: () => {
    isExitingServer = true;
    isQuitting = true;
    app.quit();
  },
  onSettings: () => createSettingsWindow(),
  onShow: () => showPrimaryWindow(),
});

const globalSummonController = createGlobalSummonController({
  globalShortcut,
  normalizeConfiguredShortcut,
  platform: process.platform,
  readUserPreferences,
  registerFirstAvailableGlobalShortcut,
  showPrimaryWindow,
  writeUserPreferences,
  wrapIpcHandler,
  getMainWindow: () => mainWindow,
});
globalSummonController.registerIpc();

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
    const onboardingWindow = settingsOnboarding?.getOnboardingWindow();
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

const { createServerProcessController } = require("./server-process.cjs");
let serverController = null;

const writeCrashLog = createCrashLogWriter({
  fs,
  path,
  lynnHome,
  dirname: __dirname,
  resourcesPath: process.resourcesPath,
  getLogs: () => serverController?.getLogs?.() || [],
});

serverController = createServerProcessController({
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
    for (const win of [mainWindow, settingsOnboarding?.getSettingsWindow()]) {
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
    settings: settingsOnboarding?.getSettingsWindow(),
    onboarding: settingsOnboarding?.getOnboardingWindow(),
    browser: browserAgent?.getWindow(),
    editor: editorController?.getWindow(),
    main: mainWindow,
  };
  const preferred = windowByKind[preferredPrimaryWindowKind];
  if (preferred && !preferred.isDestroyed()) return preferred;
  return settingsOnboarding?.getSettingsWindow()
    || settingsOnboarding?.getOnboardingWindow()
    || browserAgent?.getWindow()
    || editorController?.getWindow()
    || mainWindow
    || null;
}

function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = getPreferredPrimaryWindow();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function createSplashWindow() {
  splashWindow = createSplashWindowView({
    BrowserWindow,
    path,
    dirname: __dirname,
    loadWindowURL,
    onClosed: () => {
      splashWindow = null;
    },
  });
}

const windowState = createWindowStateController({
  fs,
  path,
  lynnHome,
  titlebarHeight: TITLEBAR_HEIGHT,
  getWindow: () => mainWindow,
});

function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  return { frame: false };
}

// ── 创建主窗口 ──
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const saved = windowState.load();

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
  mainWindow.on("resize", windowState.saveSoon);
  mainWindow.on("move", windowState.saveSoon);

  // 窗口获焦时清除 Dock badge
  mainWindow.on("focus", () => {
    markPreferredPrimaryWindow("main");
    notificationController.clearDockBadge();
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
      settingsOnboarding?.hideSettingsWindow();
      browserAgent?.hideWindow();
      editorController?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    settingsOnboarding?.destroySettingsWindow();
    browserAgent?.destroyWindow();
    editorController?.destroy();
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

browserAgent = createBrowserAgentController({
  BrowserWindow,
  WebContentsView,
  session,
  loadWindowURL,
  preloadPath: path.join(__dirname, "preload.cjs"),
  themeBg: THEME_BG,
  titlebarHeight: TITLEBAR_HEIGHT,
  getIsQuitting: () => isQuitting,
  markPreferredPrimaryWindow,
  getPreferredPrimaryWindowKind: () => preferredPrimaryWindowKind,
  setPreferredPrimaryWindowKind: (kind) => { preferredPrimaryWindowKind = kind; },
  getServerPort: () => serverController.getPort(),
  getServerToken: () => serverController.getToken(),
});

settingsOnboarding = createSettingsOnboardingController({
  BrowserWindow,
  fs,
  lynnHome,
  loadWindowErrorPage,
  loadWindowURL,
  getWindowEntryStamp,
  titleBarOpts,
  themeBg: THEME_BG,
  shell,
  getBrowserTheme: () => browserAgent?.getTheme(),
  getForceQuitApp: () => forceQuitApp,
  getMainWindow: () => mainWindow,
  getSplashWindow: () => splashWindow,
  closeSplashWindow: () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  },
  createMainWindow,
  waitForMainWindowReady,
  markPreferredPrimaryWindow,
  getPreferredPrimaryWindowKind: () => preferredPrimaryWindowKind,
  setPreferredPrimaryWindowKind: (kind) => { preferredPrimaryWindowKind = kind; },
});

function createSettingsWindow(target, theme) {
  return settingsOnboarding?.createSettingsWindow(target, theme);
}

function createOnboardingWindow(query = {}) {
  return settingsOnboarding?.createOnboardingWindow(query);
}

function completeOnboardingAndOpenMain(options) {
  return settingsOnboarding?.completeOnboardingAndOpenMain(options);
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
  wakeLock.set(payload.reason, !!payload.active)
));
wrapIpcHandler("wake-lock-state", () => wakeLock.state());
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
  return settingsOnboarding?.getInitialSettingsNavigationTarget(event) ?? null;
});

wrapIpcHandler("open-browser-viewer", (_event, theme) => browserAgent?.show(theme));
wrapIpcHandler("browser-go-back", () => browserAgent?.goBack());
wrapIpcHandler("browser-go-forward", () => browserAgent?.goForward());
wrapIpcHandler("browser-reload", () => browserAgent?.reload());
wrapIpcHandler("close-browser-viewer", () => browserAgent?.closeViewer());
wrapIpcHandler("browser-emergency-stop", () => browserAgent?.emergencyStop());

// 设置窗口 → 主窗口的消息转发
wrapIpcOn("settings-changed", (_event, type, data) => {
  const settingsWindow = settingsOnboarding?.getSettingsWindow();
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
    const browserTheme = name === "auto"
      ? (nativeTheme.shouldUseDarkColors ? "midnight" : "warm-paper")
      : name;
    browserAgent?.setTheme(browserTheme);
    browserAgent?.sendToViewer("settings-changed", type, data);
  }
  if (type === "locale-changed") {
    resetMainI18n();
    trayController.refreshMenu();
  }
});

const fileIpc = createFileIpcController({
  app,
  BrowserWindow,
  dialog,
  shell,
  nativeImage,
  wrapIpcHandler,
  wrapIpcOn,
  ipcMain,
  mt,
  lynnHome,
  getMainWindow: () => mainWindow,
  getCurrentAgentId,
  canReadPath,
  canWritePath,
  grantWebContentsAccess,
  resolveCanonicalPath,
});

editorController = createEditorWindowController({
  BrowserWindow,
  nativeTheme,
  wrapIpcHandler,
  dirname: __dirname,
  loadWindowURL,
  titleBarOpts,
  themeBg: THEME_BG,
  canWritePath,
  grantWebContentsAccess,
  getMainWindow: () => mainWindow,
  markPreferredPrimaryWindow,
  isQuitting: () => isQuitting,
  closeFileWatchers: () => fileIpc?.closeFileWatchers(),
});
editorController.register();
notificationController.register();

// Debug: 打开 Onboarding 窗口（DevTools 用）
wrapIpcHandler("debug-open-onboarding", () => {
  const onboardingWindow = settingsOnboarding?.getOnboardingWindow();
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow();
});

// Debug: 预览模式打开 Onboarding（不调 API 不写配置）
wrapIpcHandler("debug-open-onboarding-preview", () => {
  const onboardingWindow = settingsOnboarding?.getOnboardingWindow();
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
    owner === settingsOnboarding?.getSettingsWindow() ||
    owner === settingsOnboarding?.getOnboardingWindow() ||
    owner === browserAgent?.getWindow() ||
    owner === editorController?.getWindow()
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

// 前端初始化完成后调用，关闭 splash / onboarding，显示主窗口
wrapIpcHandler("app-ready", () => {
  revealMainWindowAndCloseStartupShell("app-ready");
});

const localModelController = createLocalModelController({
  BrowserWindow,
  shell,
  wrapIpcHandler,
  lynnHome,
  canReadPath,
  grantWebContentsAccess,
  resolveCanonicalPath,
  isPathInsideRoot,
});

// ── App 生命周期 ──
app.whenReady().then(async () => {
  installMediaPermissionHandlers({ session, isTrustedAppWebContents });
  installAppMenu({ Menu, app });

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
    browserAgent?.setupCommands();
    trayController.create();

    // 2b. 2026-05-01 — 启动 voice tunnel manager(跨平台 ssh 隧道守护)
    //     macOS 已有 launchd watchdog 时自动 standby + 仅监控;Win/Linux 接管 spawn。
    voiceTunnelController.start();

    // 2c. Local GGUF is opt-in. Qwen3.5-9B occupies several GB of VRAM/UMA,
    // so app startup must never spawn llama.cpp unless the user explicitly
    // enabled it or an operator sets LYNN_LOCAL_MODEL_AUTO_START=1.
    if (process.env.LYNN_LOCAL_MODEL_AUTO_START === "1") {
      localModelController.start();
    } else {
      localModelController.markExplicitStartRequired();
    }

    localModelController.emitResumeHint();

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
    globalSummonController.register();

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
  if (!trayController.exists()) {
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

// ── 优雅关闭 ──
app.on("will-quit", () => {
  serverController.stopHeartbeat();
  wakeLock.clear();
  globalSummonController.unregister();
  globalShortcut.unregisterAll();
  trayController.destroy();
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  isExitingServer = true; // Cmd+Q 走完全退出路径，连 server 一起关

  // 2026-05-01 — 停 voice tunnel manager(kill 子 ssh)
  voiceTunnelController.stop();

  // 2026-05-20 — 停 llama.cpp local 推理(SIGTERM → 5s SIGKILL)
  localModelController.stop();
  localModelController.stopManagedQwen35LlamaServer();

  // 立刻隐藏所有窗口，让用户感觉已退出，server 清理在后台进行
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide();
  }

  // 完全退出：清理浏览器实例（仅在真正退出时执行，避免隐藏路径打断后台浏览器能力）
  browserAgent?.shutdown();

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
