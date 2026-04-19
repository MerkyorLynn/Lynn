import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const CLIENT_AGENT_KEY_PREF_KEY = "client_agent_key";
export const CLIENT_AGENT_SECRET_PREF_KEY = "client_agent_secret";
export const CLIENT_AGENT_KEY_HEADER = "X-Agent-Key";
export const CLIENT_AGENT_TIMESTAMP_HEADER = "X-Lynn-Timestamp";
export const CLIENT_AGENT_NONCE_HEADER = "X-Lynn-Nonce";
export const CLIENT_AGENT_SIGNATURE_HEADER = "X-Lynn-Signature";
export const CLIENT_AGENT_VERSION_HEADER = "X-Lynn-Client-Version";
export const CLIENT_AGENT_PLATFORM_HEADER = "X-Lynn-Client-Platform";
export const CLIENT_AGENT_SIGNATURE_VERSION = "v1";

export function sanitizeClientAgentKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function sanitizeClientAgentSecret(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function generateClientAgentKey() {
  return `ak_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function generateClientAgentSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function resolveLynnClientPlatform() {
  const platform = process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return platform || "unknown";
}

export function buildClientAgentHeaders(agentKey) {
  const normalized = sanitizeClientAgentKey(agentKey);
  return normalized ? { [CLIENT_AGENT_KEY_HEADER]: normalized } : {};
}

export function buildClientAgentMetadata(agentKey) {
  const normalized = sanitizeClientAgentKey(agentKey);
  return normalized ? { user_id: normalized } : undefined;
}

export function resolveLynnHome() {
  const raw = process.env.LYNN_HOME || process.env.HANA_HOME || "";
  if (raw) {
    return path.resolve(raw.replace(/^~/, os.homedir()));
  }
  return path.join(os.homedir(), ".lynn");
}

function readPreferencesFile(opts = {}) {
  const lynnHome = opts.lynnHome || resolveLynnHome();
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

export function readClientAgentKeyFromPreferencesFile(opts = {}) {
  const prefs = readPreferencesFile(opts);
  return sanitizeClientAgentKey(prefs?.[CLIENT_AGENT_KEY_PREF_KEY]);
}

export function readClientAgentSecretFromPreferencesFile(opts = {}) {
  const prefs = readPreferencesFile(opts);
  return sanitizeClientAgentSecret(prefs?.[CLIENT_AGENT_SECRET_PREF_KEY]);
}

export function buildClientSignaturePayload({
  method = "POST",
  pathname = "/v1/chat/completions",
  timestamp,
  nonce,
  agentKey,
}) {
  const normalizedMethod = String(method || "POST").toUpperCase();
  const normalizedPath = String(pathname || "/v1/chat/completions").trim() || "/v1/chat/completions";
  return [
    CLIENT_AGENT_SIGNATURE_VERSION,
    normalizedMethod,
    normalizedPath,
    String(timestamp || ""),
    String(nonce || ""),
    String(agentKey || ""),
  ].join("\n");
}

export function signClientAgentRequest({
  agentKey,
  secret,
  method,
  pathname,
  timestamp = Date.now().toString(),
  nonce = crypto.randomBytes(12).toString("hex"),
  clientVersion = "unknown",
  clientPlatform = resolveLynnClientPlatform(),
}) {
  const normalizedKey = sanitizeClientAgentKey(agentKey);
  const normalizedSecret = sanitizeClientAgentSecret(secret);
  if (!normalizedKey) return {};

  // 基础头：始终包含
  const headers = {
    [CLIENT_AGENT_KEY_HEADER]: normalizedKey,
    [CLIENT_AGENT_VERSION_HEADER]: String(clientVersion || "unknown"),
    [CLIENT_AGENT_PLATFORM_HEADER]: String(clientPlatform || resolveLynnClientPlatform()),
  };

  // 签名头：仅当服务端要求时附加。当前 Brain API 仅凭 key 认证，
  // 附带签名头反而会触发不匹配的签名验证导致 401。
  // 未来服务端升级签名协议后，可以重新启用此段。
  if (normalizedSecret && process.env.LYNN_ENABLE_DEVICE_SIGNATURE === "1") {
    const payload = buildClientSignaturePayload({
      method,
      pathname,
      timestamp,
      nonce,
      agentKey: normalizedKey,
    });
    const signature = crypto
      .createHmac("sha256", normalizedSecret)
      .update(payload)
      .digest("hex");

    headers[CLIENT_AGENT_TIMESTAMP_HEADER] = String(timestamp);
    headers[CLIENT_AGENT_NONCE_HEADER] = String(nonce);
    headers[CLIENT_AGENT_SIGNATURE_HEADER] = `${CLIENT_AGENT_SIGNATURE_VERSION}:${signature}`;
  }

  return headers;
}

export function buildSignedClientAgentHeaders({
  method,
  pathname,
  agentKey,
  secret,
  clientVersion,
  clientPlatform,
}) {
  return signClientAgentRequest({
    agentKey,
    secret,
    method,
    pathname,
    clientVersion,
    clientPlatform,
  });
}

// [2026-04-18 v0.76.2] Auto-fill clientVersion from package.json so brain
// receives a real X-Lynn-Client-Version (was always "unknown" before, which
// broke brain's >= 0.76.2 version gate for tool_progress markers).
//
// Note: Vite inlines package.json as a base64 data URL when bundled, and
// fs.readFileSync() can't read data URLs. So we import the JSON statically
// (Vite turns this into a plain object literal at build time, so version
// is baked into the bundle directly).
import pkg from "../package.json" with { type: "json" };
const LYNN_VERSION = String(pkg?.version || "");
function _getLynnPackageVersion() {
  return LYNN_VERSION;
}

export function readSignedClientAgentHeaders(opts = {}) {
  const prefs = readPreferencesFile(opts);
  const agentKey = sanitizeClientAgentKey(prefs?.[CLIENT_AGENT_KEY_PREF_KEY]);
  const secret = sanitizeClientAgentSecret(prefs?.[CLIENT_AGENT_SECRET_PREF_KEY]);
  return buildSignedClientAgentHeaders({
    method: opts.method,
    pathname: opts.pathname,
    agentKey,
    secret,
    clientVersion: opts.clientVersion || _getLynnPackageVersion(),
    clientPlatform: opts.clientPlatform,
  });
}

export async function registerClientIdentityWithBrainApi({
  baseUrl,
  agentKey,
  secret,
  registrationToken = "",
  clientVersion = "unknown",
  clientPlatform = resolveLynnClientPlatform(),
  timeoutMs = 10_000,
}) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedKey = sanitizeClientAgentKey(agentKey);
  const normalizedSecret = sanitizeClientAgentSecret(secret);
  if (!normalizedBaseUrl || !normalizedKey || !normalizedSecret) {
    throw new Error("missing client identity registration params");
  }

  const res = await fetch(`${normalizedBaseUrl}/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: normalizedKey,
      secret: normalizedSecret,
      clientVersion,
      clientPlatform,
      ...(registrationToken ? { registrationToken } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `device register failed (${res.status})`);
  }
  return data;
}
