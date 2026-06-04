function createWindowStateController({
  fs,
  path,
  lynnHome,
  platform = process.platform,
  titlebarHeight = 44,
  getWindow,
}) {
  const windowStatePath = path.join(lynnHome, "user", "window-state.json");
  let saveTimer = null;

  function normalize(state) {
    if (!state || platform !== "darwin" || state.isMaximized) return state;
    const next = { ...state };
    if (typeof next.y === "number" && next.y >= 0 && next.y <= titlebarHeight) {
      next.y = 0;
    }
    return next;
  }

  function load() {
    try {
      return normalize(JSON.parse(fs.readFileSync(windowStatePath, "utf-8")));
    } catch {
      return null;
    }
  }

  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const win = getWindow?.();
      if (!win) return;
      const isMaximized = win.isMaximized();
      const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
      const state = { ...bounds, isMaximized };
      try {
        fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2) + "\n");
      } catch (err) {
        console.error("[desktop] 保存窗口状态失败:", err.message);
      }
    }, 500);
  }

  return { load, saveSoon };
}

module.exports = { createWindowStateController };
