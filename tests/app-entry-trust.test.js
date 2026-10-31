import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isAppEntryUrl } = require("../desktop/app-entry-trust.cjs");
const options = { dirname: "/app/desktop", distRenderer: "/app/desktop/dist-renderer", isDev: false };
describe("Electron entry URL boundary", () => {
  it("accepts only exact bundled entry files", () => {
    expect(isAppEntryUrl("file:///app/desktop/dist-renderer/index.html?agent=x", options)).toBe(true);
    expect(isAppEntryUrl("file:///app/desktop/dist-renderer/settings.html", options)).toBe(true);
    for (const url of ["file:///tmp/index.html", "file:///app/desktop/dist-renderer/assets/index.html", "data:text/html,hi", "https://example.com/index.html", "about:blank"]) expect(isAppEntryUrl(url, options)).toBe(false);
  });
  it("accepts only exact development entries at the configured origin", () => {
    const dev = { ...options, isDev: true, viteDevUrl: "http://localhost:5173" };
    expect(isAppEntryUrl("http://localhost:5173/settings.html", dev)).toBe(true);
    expect(isAppEntryUrl("http://evil.test:5173/settings.html", dev)).toBe(false);
    expect(isAppEntryUrl("file:///app/desktop/src/index.html", dev)).toBe(true);
    expect(isAppEntryUrl("file:///app/desktop/src/index.html", options)).toBe(false);
  });
});
