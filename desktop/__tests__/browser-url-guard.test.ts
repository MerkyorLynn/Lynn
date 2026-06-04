import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isBlockedBrowserHost, isAllowedBrowserUrl } = require("../browser-url-guard.cjs");

describe("isBlockedBrowserHost (browser SSRF guard)", () => {
  it("blocks loopback / private / link-local / metadata", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "::1", "metadata.google.internal"]) {
      expect(isBlockedBrowserHost(h), h).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "github.com"]) {
      expect(isBlockedBrowserHost(h), h).toBe(false);
    }
  });
});

describe("isAllowedBrowserUrl", () => {
  const noEnv = {} as NodeJS.ProcessEnv;
  it("allows public http/https", () => {
    expect(isAllowedBrowserUrl("https://example.com/x", noEnv)).toBe(true);
    expect(isAllowedBrowserUrl("http://github.com", noEnv)).toBe(true);
  });
  it("rejects non-http(s) schemes", () => {
    expect(isAllowedBrowserUrl("file:///etc/passwd", noEnv)).toBe(false);
    expect(isAllowedBrowserUrl("ftp://x", noEnv)).toBe(false);
    expect(isAllowedBrowserUrl("not a url", noEnv)).toBe(false);
  });
  it("blocks internal targets (the brain server, GPU, LAN, metadata)", () => {
    expect(isAllowedBrowserUrl("http://127.0.0.1:8787", noEnv)).toBe(false); // local brain server
    expect(isAllowedBrowserUrl("http://127.0.0.1:18000", noEnv)).toBe(false); // GPU endpoint
    expect(isAllowedBrowserUrl("http://localhost:3000", noEnv)).toBe(false);
    expect(isAllowedBrowserUrl("http://192.168.1.1", noEnv)).toBe(false);
    expect(isAllowedBrowserUrl("http://169.254.169.254/latest/meta-data", noEnv)).toBe(false);
  });
  it("honors LYNN_BROWSER_ALLOW_PRIVATE=1 escape hatch", () => {
    expect(isAllowedBrowserUrl("http://127.0.0.1:3000", { LYNN_BROWSER_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
