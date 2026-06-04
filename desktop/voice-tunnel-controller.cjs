function createVoiceTunnelController({
  BrowserWindow,
  VoiceTunnelManager,
  wrapIpcHandler,
}) {
  let voiceTunnel = null;

  function start() {
    if (voiceTunnel) return;
    try {
      voiceTunnel = new VoiceTunnelManager({
        onLog: (level, msg) => {
          if (level === "error") console.error(msg);
          else if (level === "warn") console.warn(msg);
          else console.log(msg);
        },
        onState: (state) => {
          try {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send("voice-tunnel-state", state);
            }
          } catch (err) {
            console.warn("[voice-tunnel] state broadcast failed:", err?.message || err);
          }
        },
      });
      void voiceTunnel.start();
    } catch (err) {
      console.warn("[voice-tunnel] start failed:", err?.message || err);
      voiceTunnel = null;
    }
  }

  function stop() {
    if (!voiceTunnel) return;
    try {
      voiceTunnel.stop();
    } catch (err) {
      console.warn("[voice-tunnel] stop failed:", err?.message || err);
    }
    voiceTunnel = null;
  }

  function status() {
    return voiceTunnel ? voiceTunnel.getStatus() : { stopped: true };
  }

  function register() {
    wrapIpcHandler("voice-tunnel-status", () => status());
  }

  return {
    register,
    start,
    status,
    stop,
  };
}

module.exports = { createVoiceTunnelController };
