import { afterEach, describe, expect, it, vi } from "vitest";
import {
  webScanEnabled,
  isBlockedHost,
  isBlockedAddress,
  validateWebUrl,
  simplifyHtml,
  webScanTool,
} from "../src/tools/web-scan.js";
import { codeToolDefinitions } from "../src/code-tool-protocol.js";
import { isDangerousClientTool } from "../src/code-tool-render.js";
import { runClientTool } from "../src/tools/registry.js";
import type { ToolRunContext } from "../src/tools/types.js";

const CTX: ToolRunContext = { cwd: "/tmp", approval: "yolo" };
const PUBLIC_LOOKUP = { lookup: async () => [{ address: "93.184.216.34" }] };

describe("webScanEnabled (default-on, opt-out)", () => {
  it("defaults on, off only with LYNN_CLI_WEB_SCAN=0", () => {
    expect(webScanEnabled({})).toBe(true);
    expect(webScanEnabled({ LYNN_CLI_WEB_SCAN: "1" })).toBe(true);
    expect(webScanEnabled({ LYNN_CLI_WEB_SCAN: "0" })).toBe(false);
  });
});

describe("isBlockedHost (SSRF guard)", () => {
  it("blocks loopback / private / link-local / metadata / CGNAT / multicast / mapped", () => {
    for (const h of [
      "localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.0.1",
      "172.16.0.1", "172.31.255.255", "169.254.169.254", "::1", "metadata.google.internal",
      "100.64.0.1", "224.0.0.1", "::ffff:127.0.0.1", "fc00::1", "fe80::1",
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["example.com", "platform.stepfun.com", "8.8.8.8", "172.32.0.1", "100.63.255.255", "github.com"]) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});

describe("isBlockedAddress (resolved-IP check)", () => {
  it("blocks private/reserved v4 and v6, allows public", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "::ffff:10.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
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

  it("blocks a redirect that bounces into a private host (SSRF via 30x)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await webScanTool(CTX, "https://example.com/start", PUBLIC_LOOKUP);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked host/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // first hop fetched; redirect target rejected before a second fetch
  });

  it("blocks a host that resolves to a private IP (DNS rebinding)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await webScanTool(CTX, "http://rebind.example/", { lookup: async () => [{ address: "127.0.0.1" }] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked address/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("codeToolDefinitions default-on gating (web_scan)", () => {
  const prev = process.env.LYNN_CLI_WEB_SCAN;
  afterEach(() => {
    if (prev === undefined) delete process.env.LYNN_CLI_WEB_SCAN;
    else process.env.LYNN_CLI_WEB_SCAN = prev;
  });
  const names = (): string[] => codeToolDefinitions().map((t) => t.function.name);

  it("includes web_scan by default", () => {
    delete process.env.LYNN_CLI_WEB_SCAN;
    expect(names()).toContain("web_scan");
  });
  it("omits web_scan only when LYNN_CLI_WEB_SCAN=0", () => {
    process.env.LYNN_CLI_WEB_SCAN = "0";
    expect(names()).not.toContain("web_scan");
  });
});

describe("web_scan is an approval-gated network tool", () => {
  it("is marked dangerous so ask-mode prompts and read-only blocks it", () => {
    expect(isDangerousClientTool("web_scan")).toBe(true);
  });
  it("is blocked by the read-only sandbox", async () => {
    await expect(
      runClientTool({ cwd: "/tmp", approval: "yolo", sandbox: "read-only" }, { name: "web_scan", url: "https://example.com" }),
    ).rejects.toThrow("read-only sandbox");
  });
});
