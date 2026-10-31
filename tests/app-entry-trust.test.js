import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { isAppEntryUrl } = require("../desktop/app-entry-trust.cjs");
const desktop = path.resolve("app", "desktop");
const options = { dirname: desktop, distRenderer: path.join(desktop, "dist-renderer"), isDev: false };
const fileUrl = (...parts) => pathToFileURL(path.join(desktop, ...parts)).href;
describe("Electron entry URL boundary", () => {
  it("accepts only exact bundled entry files", () => {
    expect(isAppEntryUrl(fileUrl("dist-renderer", "index.html") + "?agent=x", options)).toBe(true);
    expect(isAppEntryUrl(fileUrl("dist-renderer", "settings.html"), options)).toBe(true);
    for (const url of [fileUrl("..", "untrusted", "index.html"), fileUrl("dist-renderer", "assets", "index.html"), "data:text/html,hi", "https://example.com/index.html", "about:blank"]) expect(isAppEntryUrl(url, options)).toBe(false);
  });
  it("accepts only exact development entries at the configured origin", () => {
    const dev = { ...options, isDev: true, viteDevUrl: "http://localhost:5173" };
    expect(isAppEntryUrl("http://localhost:5173/settings.html", dev)).toBe(true);
    expect(isAppEntryUrl("http://evil.test:5173/settings.html", dev)).toBe(false);
    expect(isAppEntryUrl(fileUrl("src", "index.html"), dev)).toBe(true);
    expect(isAppEntryUrl(fileUrl("src", "index.html"), options)).toBe(false);
  });
});
