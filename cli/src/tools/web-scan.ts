import dns from "node:dns/promises";
import net from "node:net";
import type { ClientToolResult, ToolRunContext } from "./types.js";

// Read-only web fetch + zero-dependency HTML simplification. Native, in-process,
// SSRF-guarded, size/time bounded. The CLI counterpart of GA's optHTML — for the
// GUI the same job runs in an Electron BrowserView against a (possibly logged-in)
// real tab; here we fetch static HTML over Node and strip it to readable text.

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function webScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default-on (was opt-in). web_scan is registered as an approval-gated network
  // tool, SSRF-hardened, and blocked under the read-only sandbox; set
  // LYNN_CLI_WEB_SCAN=0 to remove it entirely.
  return env.LYNN_CLI_WEB_SCAN !== "0";
}

/** True for a private / loopback / link-local / reserved IP literal (v4 or v6). */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) {
    const h = ip.toLowerCase();
    if (h === "::1" || h === "::") return true;
    const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedV4(mapped[1]);
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(h)) return true;                      // link-local fe80::/10
    return false;
  }
  return false; // not an IP literal — caller resolves DNS and re-checks each address
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;        // this-host / private / loopback
  if (a === 169 && b === 254) return true;                  // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;         // private
  if (a === 192 && b === 168) return true;                  // private
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true;         // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;     // benchmark 198.18/15
  if (a >= 224) return true;                                // multicast + reserved 224.0.0.0+
  return false;
}

/** Block loopback / private / link-local / cloud-metadata hosts (SSRF guard). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "metadata.google.internal") return true;
  if (net.isIP(h)) return isBlockedAddress(h);
  return false;
}

export function validateWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`web_scan: invalid URL "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_scan: only http/https allowed (got ${url.protocol})`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`web_scan: blocked host (loopback/private/metadata): ${url.hostname}`);
  }
  return url;
}

const ENTITY: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY[m] || m)
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return _; } });
}

export interface SimplifiedPage {
  title: string;
  text: string;
  truncated: boolean;
}

/** Strip a static HTML document to token-frugal readable text. */
export function simplifyHtml(html: string, maxChars = DEFAULT_MAX_CHARS): SimplifiedPage {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = s.length > maxChars;
  if (truncated) s = `${s.slice(0, maxChars)}\n…[truncated ${s.length - maxChars} more chars]`;
  return { title, text: s, truncated };
}

export interface WebScanDeps {
  /** Override DNS resolution (tests inject a fake; production uses dns.lookup). */
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/** Reject a URL whose host (after DNS resolution) points at a private/reserved IP. */
async function assertHostAllowed(url: URL, lookup: NonNullable<WebScanDeps["lookup"]>): Promise<void> {
  if (isBlockedHost(url.hostname)) {
    throw new Error(`web_scan: blocked host (loopback/private/metadata): ${url.hostname}`);
  }
  if (net.isIP(url.hostname)) return; // literal IP already vetted by isBlockedHost
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(url.hostname);
  } catch {
    throw new Error(`web_scan: cannot resolve host ${url.hostname}`);
  }
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new Error(`web_scan: ${url.hostname} resolves to a blocked address (${a.address})`);
    }
  }
}

export async function webScanTool(ctx: ToolRunContext, rawUrl: string, deps: WebScanDeps = {}): Promise<ClientToolResult> {
  const lookup = deps.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!rawUrl) throw new Error("url is required for web_scan");
    let url = validateWebUrl(rawUrl);
    const timeoutMs = ctx.timeoutMs && ctx.timeoutMs > 0 ? Math.min(ctx.timeoutMs, 60000) : DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => controller.abort(), timeoutMs);
    // Follow redirects manually so every hop is re-validated (scheme + host + DNS).
    // With redirect:"follow" a public URL could 30x-bounce into 169.254.169.254 /
    // localhost / a rebound private IP — the classic SSRF bypass.
    let res: Response | null = null;
    for (let hop = 0; ; hop += 1) {
      await assertHostAllowed(url, lookup);
      const hopRes = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": "Lynn-CLI-web_scan/1.0", accept: "text/html,text/plain,*/*" },
      });
      const location = hopRes.status >= 300 && hopRes.status < 400 ? hopRes.headers.get("location") : null;
      if (!location) { res = hopRes; break; }
      if (hop >= MAX_REDIRECTS) throw new Error("web_scan: too many redirects");
      url = validateWebUrl(new URL(location, url).toString());
    }
    if (!res) throw new Error("web_scan: no response");
    const contentType = res.headers.get("content-type") || "";
    const raw = await readCapped(res, MAX_BODY_BYTES);
    const isHtml = /html/i.test(contentType) || /^\s*</.test(raw);
    const page = isHtml
      ? simplifyHtml(raw)
      : { title: "", text: raw.slice(0, DEFAULT_MAX_CHARS), truncated: raw.length > DEFAULT_MAX_CHARS };
    return {
      ok: res.ok,
      tool: "web_scan",
      output: { url: url.toString(), status: res.status, contentType, title: page.title, truncated: page.truncated, text: page.text },
    };
  } catch (error) {
    return { ok: false, tool: "web_scan", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the body and stop at maxBytes so a huge response can't blow up memory/tokens. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}
