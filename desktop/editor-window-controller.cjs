const path = require("path");

function createEditorWindowController({
  BrowserWindow,
  nativeTheme,
  wrapIpcHandler,
  dirname,
  loadWindowURL,
  titleBarOpts,
  themeBg,
  canWritePath,
  grantWebContentsAccess,
  getMainWindow,
  markPreferredPrimaryWindow,
  isQuitting,
  closeFileWatchers,
}) {
  let editorWindow = null;
  let editorFileData = null;

  function getWindow() {
    return editorWindow;
  }

  function hide() {
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.hide();
  }

  function destroy() {
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.destroy();
    editorWindow = null;
    editorFileData = null;
  }

  function notifyDocked(data = editorFileData) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("editor-detached", false);
    if (data) mainWindow.webContents.send("editor-dock-file", data);
  }

  function register() {
    wrapIpcHandler("open-editor-window", (event, data) => {
      if (!data?.filePath || !canWritePath(event.sender, data.filePath).allowed) return;
      editorFileData = data;
      if (editorWindow && !editorWindow.isDestroyed()) {
        grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
        editorWindow.show();
        editorWindow.focus();
        editorWindow.webContents.send("editor-load", data);
        return;
      }

      const theme = nativeTheme.shouldUseDarkColors ? "midnight" : "warm-paper";
      editorWindow = new BrowserWindow({
        width: 720,
        height: 800,
        minWidth: 400,
        minHeight: 300,
        title: data.title || "Editor",
        frame: false,
        backgroundColor: themeBg[theme] || themeBg["warm-paper"],
        hasShadow: true,
        show: true,
        acceptFirstMouse: true,
        webPreferences: {
          preload: path.join(dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
      loadWindowURL(editorWindow, "editor-window");

      editorWindow.webContents.on("did-finish-load", () => {
        if (editorFileData && editorWindow && !editorWindow.isDestroyed()) {
          editorWindow.webContents.send("editor-load", editorFileData);
        }
      });

      editorWindow.on("focus", () => {
        markPreferredPrimaryWindow("editor");
      });

      editorWindow.on("close", (event) => {
        if (!isQuitting()) {
          event.preventDefault();
          editorWindow.hide();
          notifyDocked(null);
        }
      });

      editorWindow.on("closed", () => {
        markPreferredPrimaryWindow("main");
        editorWindow = null;
        editorFileData = null;
        closeFileWatchers?.();
      });
    });

    wrapIpcHandler("editor-dock", () => {
      notifyDocked();
      hide();
    });

    wrapIpcHandler("editor-close", () => {
      notifyDocked(null);
      hide();
    });
  }

  return { register, getWindow, hide, destroy };
}

module.exports = { createEditorWindowController };
