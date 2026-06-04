function installMediaPermissionHandlers({ session, isTrustedAppWebContents }) {
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission === "media") {
        const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
        const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes("audio");
        callback(Boolean(wantsAudio && isTrustedAppWebContents(webContents)));
        return;
      }
      callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
      if (permission !== "media") return false;
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes("audio");
      return Boolean(wantsAudio && isTrustedAppWebContents(webContents));
    });
  } catch (err) {
    console.warn("[desktop] install media permission handler failed:", err?.message || err);
  }
}

module.exports = { installMediaPermissionHandlers };
