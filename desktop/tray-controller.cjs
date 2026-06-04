const path = require("path");

function createTrayController({
  Menu,
  Tray,
  app,
  fs,
  dirname,
  lynnHome,
  mt,
  nativeImage,
  onQuit,
  onSettings,
  onShow,
}) {
  let tray = null;

  function create() {
    if (process.platform === "darwin") {
      tray = null;
      return;
    }
    const isDev = lynnHome !== path.join(require("os").homedir(), ".lynn");
    let icon;
    if (process.platform === "win32") {
      const icoName = isDev ? "tray-dev.ico" : "tray.ico";
      const icoPath = path.join(dirname, "src", "assets", icoName);
      if (fs.existsSync(icoPath)) {
        icon = nativeImage.createFromPath(icoPath);
      } else {
        const pngName = isDev ? "tray-dev-template.png" : "tray-template.png";
        icon = nativeImage.createFromPath(path.join(dirname, "src", "assets", pngName));
      }
    } else {
      const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
      const iconPath = path.join(dirname, "src", "assets", iconName);
      icon = nativeImage.createFromPath(iconPath);
      if (process.platform === "darwin") icon.setTemplateImage(true);
    }

    tray = new Tray(icon);
    tray.setToolTip(isDev ? "Lynn (dev)" : "Lynn");
    refreshMenu();
    tray.on("right-click", () => refreshMenu());
    tray.on("double-click", () => onShow());
  }

  function destroy() {
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
    }
    tray = null;
  }

  function exists() {
    return Boolean(tray && !tray.isDestroyed());
  }

  function refreshMenu() {
    if (!exists()) return;
    const buildMenu = () => Menu.buildFromTemplate([
      { label: mt("tray.show", null, "Show Lynn"), click: () => onShow() },
      { label: mt("tray.settings", null, "Settings"), click: () => onSettings() },
      { type: "separator" },
      { label: mt("tray.quit", null, "Quit"), click: () => onQuit() },
    ]);
    tray.setContextMenu(buildMenu());
  }

  return {
    create,
    destroy,
    exists,
    refreshMenu,
  };
}

module.exports = { createTrayController };
