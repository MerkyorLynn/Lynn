/**
 * Spike Electron Loader
 *
 * 独立 Electron 进程,加载 spike URL 到一个 BrowserWindow,
 * 自动允许 mic permission(macOS 系统级首次会弹,授权一次后通)。
 *
 * 用法:
 *   node_modules/.bin/electron spike/electron-loader/main.cjs http://localhost:8001/
 *   node_modules/.bin/electron spike/electron-loader/main.cjs http://localhost:8002/
 */
const { app, BrowserWindow } = require("electron");

// 关键:autoplay 不需要用户 gesture
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// 可选:开启 remote debugging port(给 puppeteer 接管自动测试用)
const debugPortArg = process.argv.find((a) => a.startsWith("--remote-debugging-port="));
if (debugPortArg) {
  const port = debugPortArg.split("=")[1];
  app.commandLine.appendSwitch("remote-debugging-port", port);
  console.log(`[loader] remote-debugging-port=${port}`);
}

app.whenReady().then(() => {
  const url = process.argv.find((a) => a.startsWith("http")) || "http://localhost:8001/";
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Lynn Spike Loader — ${url}`,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // ★ 关键:自动批准 media 权限请求(mic / camera)
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "audioCapture") {
      console.log(`[loader] auto-grant: ${permission}`);
      callback(true);
      return;
    }
    console.log(`[loader] deny: ${permission}`);
    callback(false);
  });

  // ★ 关键:也批准 macOS 系统级 device 选择
  win.webContents.session.setDevicePermissionHandler(({ deviceType }) => {
    console.log(`[loader] device-perm: ${deviceType}`);
    return true; // 全允许
  });

  win.loadURL(url);
  win.webContents.on("did-finish-load", () => {
    console.log(`[loader] loaded: ${url}`);
  });
  win.webContents.on("console-message", (_event, level, message) => {
    console.log(`[page console:${level}] ${message}`);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
