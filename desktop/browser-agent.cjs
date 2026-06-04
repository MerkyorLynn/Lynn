const fs = require("fs");
const os = require("os");
const path = require("path");
const { SNAPSHOT_SCRIPT } = require("./browser-snapshot.cjs");
const { runBrowserAction } = require("./browser-actions.cjs");
const { isAllowedBrowserUrl } = require("./browser-url-guard.cjs");

function createBrowserAgentController(deps) {
  const {
    BrowserWindow,
    WebContentsView,
    session,
    loadWindowURL,
    preloadPath,
    themeBg,
    titlebarHeight = 44,
    getIsQuitting,
    markPreferredPrimaryWindow,
    getPreferredPrimaryWindowKind,
    setPreferredPrimaryWindowKind,
    getServerPort,
    getServerToken,
  } = deps;

  let browserViewerWindow = null;
  let browserWebView = null;
  const browserViews = new Map();
  let currentBrowserSession = null;
  let browserViewerTheme = "warm-paper";
  let commandSocket = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getWindow() {
    return browserViewerWindow;
  }

  function getWebView() {
    return browserWebView;
  }

  function setTheme(theme) {
    if (theme) browserViewerTheme = theme;
  }

  function getTheme() {
    return browserViewerTheme;
  }

  function sendToViewer(channel, payload) {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send(channel, payload);
    }
  }

  function updateBrowserViewBounds() {
    if (!browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
    const [width, height] = browserViewerWindow.getContentSize();
    const mx = 8;
    const mt = 4;
    const mb = 8;
    const bounds = {
      x: mx,
      y: titlebarHeight + mt,
      width: Math.max(0, width - mx * 2),
      height: Math.max(0, height - titlebarHeight - mt - mb),
    };
    if (bounds.width === 0 || bounds.height === 0) {
      console.warn("[browser] bounds 计算为零:", {
        contentSize: [width, height],
        bounds,
        visible: browserViewerWindow.isVisible(),
      });
    }
    browserWebView.setBounds(bounds);
  }

  function notifyViewerUrl(url) {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed() && browserWebView) {
      browserViewerWindow.webContents.send("browser-update", {
        url,
        title: browserWebView.webContents.getTitle(),
        canGoBack: browserWebView.webContents.canGoBack(),
        canGoForward: browserWebView.webContents.canGoForward(),
      });
    }
  }

  function createWindow(opts = {}) {
    const shouldShow = opts.show !== false;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      if (shouldShow) {
        browserViewerWindow.show();
        browserViewerWindow.focus();
        updateBrowserViewBounds();
        if (browserWebView) {
          setTimeout(() => {
            if (browserWebView) browserWebView.webContents.focus();
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
      backgroundColor: themeBg[browserViewerTheme] || themeBg["warm-paper"],
      hasShadow: true,
      show: shouldShow,
      acceptFirstMouse: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    loadWindowURL(browserViewerWindow, "browser-viewer");

    browserViewerWindow.webContents.on("did-finish-load", () => {
      if (browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(browserWebView); } catch {}
        browserViewerWindow.contentView.addChildView(browserWebView);
        updateBrowserViewBounds();
        const url = browserWebView.webContents.getURL();
        if (url) notifyViewerUrl(url);
        console.log("[browser-viewer] did-finish-load: view 已挂载, bounds:", browserWebView.getBounds());
        setTimeout(() => {
          if (browserWebView) {
            browserWebView.webContents.focus();
            console.log("[browser-viewer] delayed focus applied, isFocused:", browserWebView.webContents.isFocused());
          }
        }, 200);
      }
    });

    browserViewerWindow.on("resize", () => updateBrowserViewBounds());
    browserViewerWindow.on("show", () => updateBrowserViewBounds());
    browserViewerWindow.on("focus", () => {
      markPreferredPrimaryWindow("browser");
      if (browserWebView) {
        browserWebView.webContents.focus();
        console.log("[browser-viewer] window focus → view.focus(), isFocused:", browserWebView.webContents.isFocused());
      }
    });
    browserViewerWindow.on("close", (event) => {
      if (!getIsQuitting() && browserWebView) {
        event.preventDefault();
        browserViewerWindow.hide();
      }
    });
    browserViewerWindow.on("closed", () => {
      if (getPreferredPrimaryWindowKind() === "browser") {
        setPreferredPrimaryWindowKind("main");
      }
      browserViewerWindow = null;
    });
  }

  function show(theme) {
    if (theme) setTheme(theme);
    createWindow();
  }

  function hideWindow() {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
  }

  function destroyWindow() {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.destroy();
    }
    browserViewerWindow = null;
  }

  function closeViewer() {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.close();
  }

  function goBack() {
    if (browserWebView) browserWebView.webContents.goBack();
  }

  function goForward() {
    if (browserWebView) browserWebView.webContents.goForward();
  }

  function reload() {
    if (browserWebView) browserWebView.webContents.reload();
  }

  function emergencyStop() {
    if (browserWebView) {
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(browserWebView); } catch {}
      }
      browserWebView.webContents.close();
      if (currentBrowserSession) browserViews.delete(currentBrowserSession);
      browserWebView = null;
      currentBrowserSession = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send("browser-update", { running: false });
    }
  }

  async function handleCommand(cmd, params = {}) {
    switch (cmd) {
      case "launch": {
        if (browserWebView) return {};
        const ses = session.fromPartition("persist:hana-browser");
        const view = new WebContentsView({
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });

        view.webContents.on("did-navigate", (_event, url) => notifyViewerUrl(url));
        view.webContents.on("did-navigate-in-page", (_event, url) => notifyViewerUrl(url));
        view.webContents.setWindowOpenHandler(({ url }) => {
          if (isAllowedBrowserUrl(url)) view.webContents.loadURL(url);
          return { action: "deny" };
        });
        view.webContents.on("page-title-updated", () => {
          notifyViewerUrl(view.webContents.getURL());
        });
        view.setBorderRadius(10);

        browserWebView = view;
        currentBrowserSession = params.sessionPath || null;
        if (currentBrowserSession) browserViews.set(currentBrowserSession, view);

        createWindow({ show: false });
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(browserWebView); } catch {}
          browserViewerWindow.contentView.addChildView(browserWebView);
          updateBrowserViewBounds();
          console.log("[browser] launch: view 已挂载 (silent), bounds:", browserWebView.getBounds());
          setTimeout(() => {
            if (browserWebView) browserWebView.webContents.focus();
          }, 300);
        }
        return {};
      }
      case "close": {
        if (browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try { browserViewerWindow.contentView.removeChildView(browserWebView); } catch {}
          }
          browserWebView.webContents.close();
          if (currentBrowserSession) browserViews.delete(currentBrowserSession);
          browserWebView = null;
          currentBrowserSession = null;
        }
        sendToViewer("browser-update", { running: false });
        return {};
      }
      case "suspend": {
        if (browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try { browserViewerWindow.contentView.removeChildView(browserWebView); } catch {}
          }
          browserWebView = null;
          currentBrowserSession = null;
        }
        sendToViewer("browser-update", { running: false });
        return {};
      }
      case "resume": {
        const sessionPath = params.sessionPath;
        if (!sessionPath || !browserViews.has(sessionPath)) return { found: false };
        const view = browserViews.get(sessionPath);
        browserWebView = view;
        currentBrowserSession = sessionPath;
        createWindow({ show: false });
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.contentView.addChildView(view);
          updateBrowserViewBounds();
          view.webContents.focus();
        }
        const url = view.webContents.getURL();
        if (url) notifyViewerUrl(url);
        return { found: true, url };
      }
      case "show": {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.show();
          browserViewerWindow.focus();
          if (browserWebView) {
            browserWebView.webContents.focus();
            setTimeout(() => {
              if (browserWebView) browserWebView.webContents.focus();
            }, 100);
          }
        } else if (browserWebView) {
          createWindow();
        }
        return {};
      }
      case "destroyView": {
        const sessionPath = params.sessionPath;
        if (sessionPath && browserViews.has(sessionPath)) {
          const view = browserViews.get(sessionPath);
          if (view === browserWebView) {
            if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
              try { browserViewerWindow.contentView.removeChildView(view); } catch {}
            }
            browserWebView = null;
            currentBrowserSession = null;
            if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
              browserViewerWindow.webContents.send("browser-update", { running: false });
              browserViewerWindow.hide();
            }
          }
          view.webContents.close();
          browserViews.delete(sessionPath);
        }
        return {};
      }
      default:
        return runBrowserAction(cmd, params, {
          getWebContents: () => (browserWebView ? browserWebView.webContents : null),
          snapshotScript: SNAPSHOT_SCRIPT,
          isAllowedBrowserUrl,
          delay,
          env: process.env,
        });
    }
  }

  function setupCommands() {
    const serverPort = getServerPort();
    const serverToken = getServerToken();
    if (!serverPort || !serverToken) return;

    const WebSocket = require("ws");
    const url = `ws://127.0.0.1:${serverPort}/internal/browser`;
    const protocols = serverToken ? ["hana-browser", `token.${serverToken}`] : ["hana-browser"];

    function connect() {
      commandSocket = new WebSocket(url, protocols);
      commandSocket.on("open", () => {
        console.log("[desktop] Browser control WS connected");
      });
      commandSocket.on("message", async (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg?.type !== "browser-cmd") return;
        const { id, cmd, params } = msg;
        const logCommand = (line) => {
          try {
            fs.appendFileSync(path.join(os.homedir(), ".lynn", "browser-cmd.log"), `${new Date().toISOString()} ${line}\n`);
          } catch {}
        };
        logCommand(`→ received cmd=${cmd} id=${id}`);
        try {
          const result = await handleCommand(cmd, params || {});
          logCommand(`✓ cmd=${cmd} result=${JSON.stringify(result).slice(0, 200)} wsReady=${commandSocket.readyState}`);
          if (commandSocket.readyState === 1) {
            commandSocket.send(JSON.stringify({ type: "browser-result", id, result }));
            logCommand("✓ sent result");
          } else {
            logCommand(`✗ ws not ready (${commandSocket.readyState}), result dropped`);
          }
        } catch (err) {
          logCommand(`✗ cmd=${cmd} error=${err.message}`);
          if (commandSocket.readyState === 1) {
            commandSocket.send(JSON.stringify({ type: "browser-result", id, error: err.message }));
          }
        }
      });
      commandSocket.on("close", () => {
        if (!getIsQuitting()) setTimeout(connect, 2000);
      });
      commandSocket.on("error", () => {});
    }

    connect();
  }

  function shutdown() {
    for (const [, view] of browserViews) {
      try { view.webContents.close(); } catch {}
    }
    browserViews.clear();
    browserWebView = null;
    currentBrowserSession = null;
    try { commandSocket?.close?.(); } catch {}
    commandSocket = null;
  }

  return {
    getWindow,
    getWebView,
    getTheme,
    setTheme,
    sendToViewer,
    show,
    hideWindow,
    destroyWindow,
    closeViewer,
    goBack,
    goForward,
    reload,
    emergencyStop,
    handleCommand,
    setupCommands,
    shutdown,
  };
}

module.exports = { createBrowserAgentController };
