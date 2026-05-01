/**
 * Global shortcut policy for Lynn Jarvis summon.
 *
 * macOS keeps Cmd+Shift+L as the primary Lynn mnemonic. A previous packaged
 * client test exposed a summon-toggle bug that hid the window; the fix belongs
 * in main.cjs, not in this policy.
 */

function normalizeConfiguredShortcut(accelerator) {
  if (typeof accelerator !== "string") return null;
  const normalized = accelerator.trim().replace(/\s*\+\s*/g, "+");
  if (!normalized || normalized.length > 80) return null;
  if (/[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function uniqueShortcuts(shortcuts) {
  const out = [];
  const seen = new Set();
  for (const shortcut of shortcuts) {
    if (!shortcut || seen.has(shortcut)) continue;
    seen.add(shortcut);
    out.push(shortcut);
  }
  return out;
}

function getDefaultGlobalSummonShortcuts(platform = process.platform) {
  if (platform === "darwin") {
    return ["Command+Shift+L", "Command+Option+J"];
  }
  return ["Control+Shift+L", "Control+Alt+J"];
}

function getGlobalSummonShortcuts(platform = process.platform, configuredAccelerator = null) {
  const configured = normalizeConfiguredShortcut(configuredAccelerator);
  const defaults = getDefaultGlobalSummonShortcuts(platform);
  return uniqueShortcuts(configured ? [configured, ...defaults] : defaults);
}

function registerFirstAvailableGlobalShortcut(globalShortcut, callback, platform = process.platform, configuredAccelerator = null) {
  const configured = normalizeConfiguredShortcut(configuredAccelerator);
  const shortcuts = getGlobalSummonShortcuts(platform, configured);
  const defaultAccelerator = getDefaultGlobalSummonShortcuts(platform)[0] || null;
  const errors = {};
  for (const accelerator of shortcuts) {
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, callback);
    } catch (err) {
      errors[accelerator] = err?.message || String(err);
    }
    if (ok) {
      return {
        ok: true,
        accelerator,
        fallbackUsed: accelerator !== shortcuts[0],
        attempted: shortcuts,
        configured,
        defaultAccelerator,
        layer: configured && accelerator === configured ? "configured" : "default",
        errors,
      };
    }
  }
  return {
    ok: false,
    accelerator: null,
    fallbackUsed: false,
    attempted: shortcuts,
    configured,
    defaultAccelerator,
    layer: null,
    errors,
  };
}

module.exports = {
  getDefaultGlobalSummonShortcuts,
  getGlobalSummonShortcuts,
  normalizeConfiguredShortcut,
  registerFirstAvailableGlobalShortcut,
};
