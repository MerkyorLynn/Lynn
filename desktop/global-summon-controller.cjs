function createGlobalSummonController({
  globalShortcut,
  normalizeConfiguredShortcut,
  platform,
  readUserPreferences,
  registerFirstAvailableGlobalShortcut,
  showPrimaryWindow,
  writeUserPreferences,
  wrapIpcHandler,
  getMainWindow,
}) {
  let shortcutStatus = {
    ok: false,
    accelerator: null,
    fallbackUsed: false,
    attempted: [],
    configured: null,
    defaultAccelerator: null,
    layer: null,
    errors: {},
  };
  let registeredAccelerators = new Set();

  function readPreference() {
    const prefs = readUserPreferences();
    return normalizeConfiguredShortcut(prefs.jarvis_global_shortcut);
  }

  function writePreference(accelerator) {
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

  function unregister() {
    for (const accelerator of registeredAccelerators) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {}
    }
    registeredAccelerators.clear();
  }

  function toggleWindow() {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
      mainWindow.webContents.send("global-summon");
    } else {
      showPrimaryWindow();
    }
  }

  function register(configuredAccelerator = readPreference()) {
    unregister();
    const result = registerFirstAvailableGlobalShortcut(
      globalShortcut,
      toggleWindow,
      platform,
      configuredAccelerator
    );
    shortcutStatus = result;
    registeredAccelerators = new Set(result.attempted || []);
    if (result.ok) {
      const layer = result.layer === "configured" ? " (custom)" : result.fallbackUsed ? " (fallback)" : "";
      console.log(`[desktop] 全局快捷键 ${result.accelerator} 已注册${layer}`);
    } else {
      console.warn(`[desktop] 全局快捷键注册失败（已尝试: ${result.attempted.join(", ")}）`);
    }
    return result;
  }

  function setShortcut(accelerator) {
    return register(writePreference(accelerator));
  }

  function status() {
    return shortcutStatus;
  }

  function registerIpc() {
    wrapIpcHandler("get-global-summon-shortcut-status", () => status());
    wrapIpcHandler("set-global-summon-shortcut", (_event, accelerator) => setShortcut(accelerator));
  }

  return {
    register,
    registerIpc,
    setShortcut,
    status,
    unregister,
  };
}

module.exports = { createGlobalSummonController };
