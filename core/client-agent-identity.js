import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const CLIENT_AGENT_KEY_PREF_KEY = "client_agent_key";
export const CLIENT_AGENT_KEY_HEADER = "X-Agent-Key";

export function sanitizeClientAgentKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function generateClientAgentKey() {
  return `ak_${crypto.randomUUID().replace(/-/g, "")}`;
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

export function readClientAgentKeyFromPreferencesFile(opts = {}) {
  const lynnHome = opts.lynnHome || resolveLynnHome();
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    return sanitizeClientAgentKey(prefs?.[CLIENT_AGENT_KEY_PREF_KEY]);
  } catch {
    return null;
  }
}
