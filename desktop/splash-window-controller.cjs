function createSplashWindow({
  BrowserWindow,
  path,
  dirname,
  loadWindowURL,
  onClosed,
}) {
  const splashWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: "Lynn",
    transparent: true,
    show: false,
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === "darwin" && splashWindow.setWindowButtonVisibility) {
    splashWindow.setWindowButtonVisibility(false);
  }

  loadWindowURL(splashWindow, "splash");
  splashWindow.once("ready-to-show", () => splashWindow.show());
  splashWindow.on("closed", () => onClosed?.());
  return splashWindow;
}

module.exports = { createSplashWindow };
