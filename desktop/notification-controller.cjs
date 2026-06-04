function createNotificationController({
  app,
  Notification,
  systemPreferences,
  wrapIpcHandler,
  mt,
  getMainWindow,
}) {
  let pendingNotificationCount = 0;

  function getPermissionStatus() {
    if (!Notification.isSupported()) return "unsupported";
    if (process.platform !== "darwin") return "granted";

    const settings = systemPreferences.getNotificationSettings?.();
    const status = settings?.authorizationStatus;
    if (status === "authorized" || status === "provisional" || status === "ephemeral") {
      return "granted";
    }
    if (status === "denied") return "denied";
    if (status === "not-determined") return "not-determined";
    return "granted";
  }

  async function requestPermission() {
    const currentStatus = getPermissionStatus();
    if (currentStatus !== "not-determined") return currentStatus;

    try {
      const notif = new Notification({
        title: "Lynn",
        body: mt("notification.ready", null, "Notifications enabled"),
        silent: true,
      });
      notif.show();
    } catch {}

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const nextStatus = getPermissionStatus();
      if (nextStatus !== "not-determined") return nextStatus;
    }

    return getPermissionStatus();
  }

  function clearDockBadge() {
    if (process.platform !== "darwin") return;
    pendingNotificationCount = 0;
    app.dock.setBadge("");
  }

  function show(title, body) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: title || "Lynn",
      body: body || "",
      silent: false,
    });
    notif.on("click", () => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();

    const mainWindow = getMainWindow();
    if (process.platform === "darwin" && mainWindow && (!mainWindow.isVisible() || !mainWindow.isFocused())) {
      pendingNotificationCount++;
      app.dock.setBadge(String(pendingNotificationCount));
    }
  }

  function register() {
    wrapIpcHandler("get-notification-permission-status", () => getPermissionStatus());
    wrapIpcHandler("request-notification-permission", () => requestPermission());
    wrapIpcHandler("show-notification", (_event, title, body) => show(title, body));
  }

  return {
    clearDockBadge,
    getPermissionStatus,
    register,
    requestPermission,
    show,
  };
}

module.exports = { createNotificationController };
