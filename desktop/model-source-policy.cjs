"use strict";

// Pure model-download safety + path helpers extracted from model-downloader.cjs.
// SSRF / private-IP guard, DNS-rebinding defense, URL + path validation, and
// source normalization — all pure (no downloader state), so they're unit-testable
// in isolation. Stays .cjs because model-downloader.cjs is required raw by the
// Electron main process.

const fs = require("fs");
const path = require("path");

const INSECURE_MODEL_SOURCE_ENV = "LYNN_ALLOW_INSECURE_MODEL_SOURCE";

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function allowInsecureModelSources() {
  return truthyEnv(process.env[INSECURE_MODEL_SOURCE_ENV]);
}

function stripIpv6Brackets(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseIpv4Literal(hostname) {
  const parts = String(hostname || "").trim().split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isLocalOrPrivateHost(hostname) {
  const host = stripIpv6Brackets(hostname).replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "ip6-localhost" || host === "ip6-loopback") {
    return true;
  }
  if (host.endsWith(".local")) return true;
  const ipv4 = parseIpv4Literal(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) {
    const octets = parseIpv4Literal(mappedIpv4[1]);
    return isPrivateIpv4(octets);
  }
  return false;
}

// 2026-05-25 P0-2 (security): DNS rebinding defense for http(s).get.
// validateModelSourceUrl checks the hostname string, but the actual TCP connect
// resolves DNS inside https.get. Attacker-controlled short-TTL DNS could return
// 127.0.0.1 on the second resolution and hijack the download to a local admin
// endpoint. Inject this lookup wrapper into http(s).get's lookup option; any
// private/loopback resolved IP is rejected immediately.
function dnsLookupBlockingPrivate(hostname, optionsOrCallback, maybeCallback) {
  const dns = require("node:dns");
  let opts, callback;
  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    opts = {};
  } else {
    opts = optionsOrCallback || {};
    callback = maybeCallback;
  }
  // Opt-out for dev/testing against localhost — same env as validateModelSourceUrl
  if (allowInsecureModelSources()) {
    return dns.lookup(hostname, opts, callback);
  }
  dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addresses) => {
    if (err) return callback(err);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return callback(new Error(`model-source: DNS empty for ${hostname}`));
    }
    for (const addr of addresses) {
      if (isLocalOrPrivateHost(addr.address)) {
        const e = new Error(`model-source: DNS rebinding blocked — ${hostname} → ${addr.address} (private/loopback)`);
        e.code = "DNS_REBINDING_BLOCKED";
        return callback(e);
      }
    }
    if (opts.all) {
      return callback(null, addresses);
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
}

function validateModelSourceUrl(urlStr, opts = {}) {
  const context = opts.context || "model-source";
  const enforceGgufPath = opts.enforceGgufPath !== false;
  let url;
  try {
    url = new URL(String(urlStr || ""));
  } catch {
    throw new Error(`${context}: invalid-url`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${context}: unsupported-url-scheme`);
  }
  if (url.username || url.password) {
    throw new Error(`${context}: credentials-not-allowed`);
  }
  if (!allowInsecureModelSources() && isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`${context}: local-or-private-host-not-allowed`);
  }
  if (enforceGgufPath) {
    let decodedPath = "";
    try {
      decodedPath = decodeURIComponent(url.pathname || "");
    } catch {
      throw new Error(`${context}: invalid-url-path`);
    }
    if (!decodedPath.toLowerCase().endsWith(".gguf")) {
      throw new Error(`${context}: source-must-end-with-gguf`);
    }
  }
  return url.toString();
}

function normalizeSourceId(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function normalizeDownloadSources(sources, opts = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("model-source: at-least-one-source-required");
  }
  const seen = new Map();
  return sources.map((entry, index) => {
    const raw = typeof entry === "string" ? { url: entry } : (entry || {});
    const url = validateModelSourceUrl(raw.url, {
      context: `model-source[${index}]`,
      enforceGgufPath: opts.enforceGgufPath !== false,
    });
    const parsed = new URL(url);
    const fallbackId = `source-${index + 1}`;
    const baseId = normalizeSourceId(raw.id || parsed.hostname, fallbackId);
    const duplicateCount = seen.get(baseId) || 0;
    seen.set(baseId, duplicateCount + 1);
    const id = duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId;
    const label = String(raw.label || id).trim().slice(0, 120) || id;
    return { id, label, url };
  });
}

function normalizeModelFileName(fileName) {
  const value = String(fileName || "").trim();
  if (!value || value.includes("\0")) throw new Error("model-file-name: invalid");
  if (path.basename(value) !== value) throw new Error("model-file-name: path-separators-not-allowed");
  if (path.extname(value).toLowerCase() !== ".gguf") throw new Error("model-file-name: must-end-with-gguf");
  return value;
}

function validateModelTargetPath(targetPath) {
  const raw = String(targetPath || "");
  if (!raw || raw.includes("\0")) throw new Error("model-target: invalid-path");
  const resolved = path.resolve(raw);
  if (path.extname(resolved).toLowerCase() !== ".gguf") {
    throw new Error("model-target: must-end-with-gguf");
  }
  return resolved;
}

function defaultLynnRoot(homeDir) {
  return path.join(homeDir, ".lynn");
}

function defaultModelPath(homeDir, fileName) {
  return path.join(defaultLynnRoot(homeDir), "models", fileName);
}

function ensureDirSync(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
}

function safeStatSize(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

module.exports = {
  INSECURE_MODEL_SOURCE_ENV,
  truthyEnv,
  allowInsecureModelSources,
  stripIpv6Brackets,
  parseIpv4Literal,
  isPrivateIpv4,
  isLocalOrPrivateHost,
  dnsLookupBlockingPrivate,
  validateModelSourceUrl,
  normalizeSourceId,
  normalizeDownloadSources,
  normalizeModelFileName,
  validateModelTargetPath,
  defaultLynnRoot,
  defaultModelPath,
  ensureDirSync,
  safeStatSize,
};
