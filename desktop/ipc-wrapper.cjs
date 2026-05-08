const { ipcMain } = require('electron');

let senderValidator = null;

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
 * Non-breaking IPC handler wrapper.
 * Adds structured error logging as a safety net. Does NOT change return format.
 * If an error escapes the handler, it is logged and undefined is returned.
 */
function wrapIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isSenderAllowed(channel, event)) {
      console.warn(`[IPC][${channel}] rejected untrusted sender`);
      return undefined;
    }
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      return undefined;
    }
  });
}

function wrapIpcOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
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

module.exports = { setIpcSenderValidator, wrapIpcHandler, wrapIpcOn };
