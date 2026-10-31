let senderValidator = null;
let ipcMainRuntime = null;

function getIpcMain() {
  return ipcMainRuntime ||= require('electron').ipcMain;
}

function setIpcMainForTests(value) {
  ipcMainRuntime = value || null;
}

function setIpcSenderValidator(validator) {
  senderValidator = typeof validator === "function" ? validator : null;
}

function isSenderAllowed(channel, event) {
  if (!senderValidator) return true;
  try {
    return senderValidator(channel, event) !== false;
  } catch (err) {
    console.error(`[IPC][${channel}] sender validator failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * IPC handler wrapper. Handler failures reject ipcRenderer.invoke with a trace id
 * instead of silently returning undefined and making the renderer guess what failed.
 */
function wrapIpcHandler(channel, handler) {
  getIpcMain().handle(channel, async (event, ...args) => {
    if (!isSenderAllowed(channel, event)) {
      console.warn(`[IPC][${channel}] rejected untrusted sender`);
      throw new Error(`IPC request rejected: ${channel}`);
    }
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      throw new Error(`IPC ${channel} failed (trace ${traceId})`);
    }
  });
}

function wrapIpcOn(channel, handler) {
  getIpcMain().on(channel, (event, ...args) => {
    if (!isSenderAllowed(channel, event)) {
      console.warn(`[IPC][${channel}] rejected untrusted sender`);
      return;
    }
    try {
      const result = handler(event, ...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.error(`[IPC][${channel}] async: ${err?.message || err}`);
        });
      }
    } catch (err) {
      console.error(`[IPC][${channel}] ${err?.message || err}`);
    }
  });
}

module.exports = { setIpcMainForTests, setIpcSenderValidator, wrapIpcHandler, wrapIpcOn };
