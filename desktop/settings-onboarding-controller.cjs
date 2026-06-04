const path = require("path");

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

function createSettingsOnboardingController({
  BrowserWindow,
  fs,
  lynnHome,
  loadWindowErrorPage,
  loadWindowURL,
  getWindowEntryStamp,
  titleBarOpts,
  themeBg,
  shell,
  getBrowserTheme,
  getForceQuitApp,
  getMainWindow,
  getSplashWindow,
  closeSplashWindow,
  createMainWindow,
  waitForMainWindowReady,
  markPreferredPrimaryWindow,
  getPreferredPrimaryWindowKind,
  setPreferredPrimaryWindowKind,
}) {
  let settingsWindow = null;
  let settingsWindowInitialNavigationTarget = null;
  let settingsWindowContentStamp = null;
  let onboardingWindow = null;

  function getSettingsWindow() {
    return settingsWindow;
  }

  function getOnboardingWindow() {
    return onboardingWindow;
  }

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
      backgroundColor: themeBg[theme || getBrowserTheme() || "warm-paper"] || themeBg["warm-paper"],
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

    settingsWindow.webContents.on("will-navigate", (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch {}
    });

    settingsWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[desktop] settings renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.destroy();
      }
      settingsWindow = null;
    });

    settingsWindow.on("closed", () => {
      if (getPreferredPrimaryWindowKind() === "settings") {
        setPreferredPrimaryWindowKind("main");
      }
      settingsWindowInitialNavigationTarget = null;
      settingsWindowContentStamp = null;
      settingsWindow = null;
    });
  }

  async function completeOnboardingAndOpenMain({ markSetupComplete = true } = {}) {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    if (markSetupComplete) {
      try {
        let prefs = {};
        try {
          prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        } catch {}
        prefs.setupComplete = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
      } catch (err) {
        console.error("[desktop] Failed to write setupComplete:", err);
      }
    }

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    }

    const ready = await waitForMainWindowReady();
    const nextMainWindow = getMainWindow();
    if (!ready && nextMainWindow && !nextMainWindow.isDestroyed()) {
      try {
        nextMainWindow.show();
      } catch {}
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
      closeSplashWindow();
      onboardingWindow.show();
    });

    onboardingWindow.on("focus", () => {
      markPreferredPrimaryWindow("onboarding");
    });

    onboardingWindow.on("closed", () => {
      if (getPreferredPrimaryWindowKind() === "onboarding") {
        setPreferredPrimaryWindowKind("main");
      }
      const mainWindow = getMainWindow();
      const shouldSkipIntoApp = query.preview !== "1" && !getForceQuitApp() && (!mainWindow || mainWindow.isDestroyed());
      onboardingWindow = null;
      if (shouldSkipIntoApp) {
        void completeOnboardingAndOpenMain({ markSetupComplete: true });
      }
    });
  }

  function destroySettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    settingsWindow = null;
  }

  function hideSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
  }

  function getInitialSettingsNavigationTarget(event) {
    if (!settingsWindow || settingsWindow.isDestroyed()) return null;
    if (event.sender !== settingsWindow.webContents) return null;
    const target = settingsWindowInitialNavigationTarget;
    settingsWindowInitialNavigationTarget = null;
    return target;
  }

  return {
    completeOnboardingAndOpenMain,
    createOnboardingWindow,
    createSettingsWindow,
    destroySettingsWindow,
    getInitialSettingsNavigationTarget,
    getOnboardingWindow,
    getSettingsWindow,
    hideSettingsWindow,
  };
}

module.exports = {
  createSettingsOnboardingController,
  normalizeSettingsNavigationTarget,
};
