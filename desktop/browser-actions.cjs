"use strict";

// Browser view-action handlers extracted from main.cjs handleBrowserCommand
// (browser-agent migration §2, action-space cut). These 11 commands operate
// PURELY on a given webContents (executeJavaScript / capturePage / insertText /
// sendInputEvent / loadURL) with no window / view-map / session coupling, so they
// are unit-testable against a fake webContents. The 6 lifecycle commands
// (launch / close / suspend / resume / show / destroyView) stay in main — they
// touch the viewer window + per-session view map — and migrate into the
// browser-agent controller next.
//
// Stays .cjs because Electron runs main.cjs raw in dev (no .ts loader).

const BROWSER_ACTION_COMMANDS = new Set([
  "navigate", "snapshot", "screenshot", "thumbnail", "click", "type",
  "scroll", "select", "pressKey", "wait", "evaluate",
]);

function isBrowserActionCommand(cmd) {
  return BROWSER_ACTION_COMMANDS.has(cmd);
}

// deps: getWebContents() -> wc|null, snapshotScript, isAllowedBrowserUrl(url),
//       delay(ms)->Promise, env (defaults to process.env)
async function runBrowserAction(cmd, params, deps) {
  const {
    getWebContents,
    snapshotScript,
    isAllowedBrowserUrl,
    delay,
    env = process.env,
  } = deps;

  // _ensureBrowser() equivalent — same error string as main.
  function wcOrThrow() {
    const wc = getWebContents();
    if (!wc) throw new Error("Browser not launched. Call start first.");
    return wc;
  }

  switch (cmd) {
    case "navigate": {
      if (!isAllowedBrowserUrl(params.url)) {
        throw new Error("Only http/https URLs are allowed");
      }
      const wc = wcOrThrow();
      await wc.loadURL(params.url);
      await delay(500);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { url: snap.currentUrl, title: snap.title, snapshot: snap.text };
    }

    case "snapshot": {
      const wc = wcOrThrow();
      const snap = await wc.executeJavaScript(snapshotScript);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    case "screenshot": {
      const wc = wcOrThrow();
      const img = await wc.capturePage();
      const jpeg = img.toJPEG(75);
      return { base64: jpeg.toString("base64") };
    }

    case "thumbnail": {
      const wc = wcOrThrow();
      const img = await wc.capturePage();
      const resized = img.resize({ width: 400 });
      const jpeg = resized.toJPEG(60);
      return { base64: jpeg.toString("base64") };
    }

    case "click": {
      const wc = wcOrThrow();
      const clickRef = Number(params.ref);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + clickRef + "\"]');" +
        " if (!el) throw new Error('Element [" + clickRef + "] not found');" +
        " el.scrollIntoView({block:'center'}); el.click(); })()"
      );
      await delay(800);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    case "type": {
      const wc = wcOrThrow();
      if (params.ref != null) {
        const typeRef = Number(params.ref);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-hana-ref=\"" + typeRef + "\"]');" +
          " if (!el) throw new Error('Element [" + typeRef + "] not found');" +
          " el.scrollIntoView({block:'center'}); el.focus();" +
          " if (el.select) el.select(); })()"
        );
        await delay(100);
      }
      await wc.insertText(params.text);
      if (params.pressEnter) {
        await delay(100);
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await delay(800);
      }
      await delay(300);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { currentUrl: snap.currentUrl, text: snap.text };
    }

    case "scroll": {
      const wc = wcOrThrow();
      const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
      await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
      await delay(500);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { text: snap.text };
    }

    case "select": {
      const wc = wcOrThrow();
      const selRef = Number(params.ref);
      const safeValue = JSON.stringify(params.value);
      await wc.executeJavaScript(
        "(function(){ var el = document.querySelector('[data-hana-ref=\"" + selRef + "\"]');" +
        " if (!el) throw new Error('Element [" + selRef + "] not found');" +
        " el.value = " + safeValue + ";" +
        " el.dispatchEvent(new Event('change',{bubbles:true})); })()"
      );
      await delay(300);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { text: snap.text };
    }

    case "pressKey": {
      const wc = wcOrThrow();
      const parts = params.key.split("+");
      const keyCode = parts[parts.length - 1];
      const modifiers = parts.slice(0, -1).map(function(m) { return m.toLowerCase(); });
      const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
      const mappedKey = keyMap[keyCode] || keyCode;
      wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
      await delay(300);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { text: snap.text };
    }

    case "wait": {
      const wc = wcOrThrow();
      const timeout = Math.min(params.timeout || 5000, 10000);
      await delay(timeout);
      const snap = await wc.executeJavaScript(snapshotScript);
      return { text: snap.text };
    }

    // 2026-05-25 P1-3 security: 4000-char cap + full-expression audit log +
    // optional LYNN_BROWSER_EVAL_DENY_SENSITIVE storage-exfil block.
    case "evaluate": {
      if (!params.expression || params.expression.length > 4000) {
        throw new Error("Expression too long (max 4000 chars; was 10000 — tightened 2026-05-25 P1-3 security)");
      }
      console.log(`[browser:evaluate audit][${new Date().toISOString()}][len=${params.expression.length}] ${params.expression}`);
      if (env.LYNN_BROWSER_EVAL_DENY_SENSITIVE === "1") {
        const sensitivePatterns = /\b(document\.cookie|localStorage|sessionStorage|indexedDB|document\.domain|navigator\.credentials)\b/i;
        if (sensitivePatterns.test(params.expression)) {
          throw new Error("browser:evaluate denied — expression accesses sensitive storage (LYNN_BROWSER_EVAL_DENY_SENSITIVE=1)");
        }
      }
      const wc = wcOrThrow();
      const result = await wc.executeJavaScript(params.expression);
      const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { value: serialized || "undefined" };
    }

    default:
      throw new Error("Unknown browser command: " + cmd);
  }
}

module.exports = { runBrowserAction, isBrowserActionCommand, BROWSER_ACTION_COMMANDS };
