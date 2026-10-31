"use strict";
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const PAGES = new Set(["index.html", "settings.html", "onboarding.html", "splash.html", "browser-viewer.html", "editor-window.html"]);

function isAppEntryUrl(value, { dirname, distRenderer, isDev = false, viteDevUrl = "" }) {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      const file = path.resolve(fileURLToPath(url));
      if (!PAGES.has(path.basename(file))) return false;
      return file === path.join(distRenderer, path.basename(file))
        || (isDev && file === path.join(dirname, "src", path.basename(file)));
    }
    if (isDev && viteDevUrl) {
      const dev = new URL(viteDevUrl);
      return url.origin === dev.origin && PAGES.has(url.pathname.slice(1));
    }
    return false;
  } catch { return false; }
}
module.exports = { isAppEntryUrl };
