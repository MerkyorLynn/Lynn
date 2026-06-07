import { afterEach, describe, expect, it, vi } from "vitest";
import {
  webScanEnabled,
  isBlockedHost,
  validateWebUrl,
  simplifyHtml,
  webScanTool,
} from "../src/tools/web-scan.js";
import { codeToolDefinitions } from "../src/code-tool-protocol.js";
import type { ToolRunContext } from "../src/tools/types.js";

const CTX: ToolRunContext = { cwd: "/tmp", approval: "yolo" };

describe("webScanEnabled (opt-in)", () => {
  it("defaults off, on with LYNN_CLI_WEB_SCAN=1", () => {
    expect(webScanEnabled({})).toBe(false);
    expect(webScanEnabled({ LYNN_CLI_WEB_SCAN: "1" })).toBe(true);
  });
});

describe("isBlockedHost (SSRF guard)", () => {
  it("blocks loopback / private / link-local / metadata", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "::1", "metadata.google.internal"]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["example.com", "platform.stepfun.com", "8.8.8.8", "172.32.0.1", "github.com"]) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});

describe("validateWebUrl", () => {
  it("accepts http/https", () => {
    expect(validateWebUrl("https://example.com/a").hostname).toBe("example.com");
    expect(validateWebUrl("http://example.com").protocol).toBe("http:");
  });
  it("rejects non-http(s) schemes", () => {
    expect(() => validateWebUrl("file:///etc/passwd")).toThrow(/http\/https/);
    expect(() => validateWebUrl("ftp://x")).toThrow(/http\/https/);
  });
  it("rejects blocked hosts", () => {
    expect(() => validateWebUrl("http://127.0.0.1:8080")).toThrow(/blocked host/);
    expect(() => validateWebUrl("http://169.254.169.254/latest/meta-data")).toThrow(/blocked host/);
  });
  it("rejects garbage", () => {
    expect(() => validateWebUrl("not a url")).toThrow(/invalid URL/);
  });
});

describe("simplifyHtml", () => {
  it("extracts title and strips script/style", () => {
    const html = "<html><head><title>Hi There</title><style>.a{x}</style></head><body><script>evil()</script><p>Hello</p><p>World</p></body></html>";
    const out = simplifyHtml(html);
    expect(out.title).toBe("Hi There");
    expect(out.text).toContain("Hello");
    expect(out.text).toContain("World");
    expect(out.text).not.toContain("evil");
    expect(out.text).not.toContain(".a{x}");
  });
  it("turns block tags into newlines and decodes entities", () => {
    const out = simplifyHtml("<ul><li>a&amp;b</li><li>c&lt;d</li></ul>");
    expect(out.text).toContain("a&b");
    expect(out.text).toContain("c<d");
    expect(out.text.split("\n").length).toBeGreaterThanOrEqual(2);
  });
  it("caps oversized content and flags truncation", () => {
    const big = `<p>${"x".repeat(20000)}</p>`;
    const out = simplifyHtml(big, 5000);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("truncated");
    expect(out.text.length).toBeLessThan(6000);
  });
});

describe("webScanTool (mocked fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches, simplifies, and returns structured output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<title>Doc</title><body><p>Ref content</p></body>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const res = await webScanTool(CTX, "https://example.com/doc");
    expect(res.ok).toBe(true);
    expect(res.tool).toBe("web_scan");
    const out = res.output as { status: number; title: string; text: string };
    expect(out.status).toBe(200);
    expect(out.title).toBe("Doc");
    expect(out.text).toContain("Ref content");
  });

  it("never performs a fetch for a blocked host", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await webScanTool(CTX, "http://127.0.0.1/secret");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked host/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("codeToolDefinitions opt-in gating (web_scan)", () => {
  const prev = process.env.LYNN_CLI_WEB_SCAN;
  afterEach(() => {
    if (prev === undefined) delete process.env.LYNN_CLI_WEB_SCAN;
    else process.env.LYNN_CLI_WEB_SCAN = prev;
  });
  const names = (): string[] => codeToolDefinitions().map((t) => t.function.name);

  it("omits web_scan by default", () => {
    delete process.env.LYNN_CLI_WEB_SCAN;
    expect(names()).not.toContain("web_scan");
  });
  it("includes web_scan when enabled", () => {
    process.env.LYNN_CLI_WEB_SCAN = "1";
    expect(names()).toContain("web_scan");
  });
});
