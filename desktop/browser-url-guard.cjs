"use strict";

const { lookup } = require("dns").promises;
const { isIP } = require("net");
const { isPrivateHost } = require("../shared/network-address.cjs");

// SSRF guard for the model-driven browser agent. A logged-in, autonomous browser
// must not be navigable to internal services (the local brain server, GPU
// endpoints, LAN hosts, cloud metadata). Opt out with LYNN_BROWSER_ALLOW_PRIVATE=1
// for deliberate local-dev browsing.

function isBlockedBrowserHost(hostname) {
  return isPrivateHost(hostname);
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

async function isAllowedBrowserUrlResolved(url, env, lookupFn = lookup) {
  const e = env || process.env;
  if (!isAllowedBrowserUrl(url, e)) return false;
  if (e.LYNN_BROWSER_ALLOW_PRIVATE === "1") return true;
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) return !isBlockedBrowserHost(hostname);
    const results = await lookupFn(hostname, { all: true });
    return Array.isArray(results)
      && results.length > 0
      && results.every((entry) => !isBlockedBrowserHost(entry?.address));
  } catch {
    return false;
  }
}

module.exports = { isBlockedBrowserHost, isAllowedBrowserUrl, isAllowedBrowserUrlResolved };
