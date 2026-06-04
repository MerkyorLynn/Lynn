"use strict";

// SSRF guard for the model-driven browser agent. A logged-in, autonomous browser
// must not be navigable to internal services (the local brain server, GPU
// endpoints, LAN hosts, cloud metadata). Opt out with LYNN_BROWSER_ALLOW_PRIVATE=1
// for deliberate local-dev browsing.

function isBlockedBrowserHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:127") || h.startsWith("::ffff:10")) return true;
  return false;
}

function isAllowedBrowserUrl(url, env) {
  const e = env || process.env;
  try {
    const p = new URL(url);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    if (e.LYNN_BROWSER_ALLOW_PRIVATE !== "1" && isBlockedBrowserHost(p.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { isBlockedBrowserHost, isAllowedBrowserUrl };
