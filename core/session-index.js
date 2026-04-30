import fsp from "fs/promises";
import path from "path";

export const SESSION_INDEX_FILENAME = "session-index.json";

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeSessionIndexEntry(session, opts = {}) {
  const agent = opts.agent || {};
  return {
    path: String(session?.path || ""),
    title: session?.title || null,
    firstMessage: session?.firstMessage || "",
    modified: toIso(session?.modified),
    messageCount: Number(session?.messageCount || 0),
    cwd: session?.cwd || "",
    agentId: session?.agentId || agent.id || null,
    agentName: session?.agentName || agent.name || null,
    modelId: session?.modelId || null,
    modelProvider: session?.modelProvider || null,
    pinned: !!session?.pinned,
    labels: Array.isArray(session?.labels) ? session.labels.filter(Boolean) : [],
  };
}

export function sessionIndexPath(sessionDir) {
  return path.join(sessionDir, SESSION_INDEX_FILENAME);
}

export async function readSessionIndex(sessionDir) {
  try {
    const raw = await fsp.readFile(sessionIndexPath(sessionDir), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

export async function writeSessionIndex(sessionDir, sessions, opts = {}) {
  const entries = (Array.isArray(sessions) ? sessions : [])
    .map((session) => normalizeSessionIndexEntry(session, opts))
    .filter((entry) => entry.path);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: entries,
  };
  await fsp.mkdir(sessionDir, { recursive: true });
  const target = sessionIndexPath(sessionDir);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, target);
  return payload;
}

export async function refreshSessionIndex(sessionDir, sessions, opts = {}) {
  return writeSessionIndex(sessionDir, sessions, opts);
}
