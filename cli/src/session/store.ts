import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import callbackFs from "node:fs";
import lockfile from "proper-lockfile";
import os from "node:os";
import path from "node:path";
import {
  normalizeSessionDigest,
  normalizeSessionInsights,
  type SessionDigest,
  type SessionInsight,
} from "../../../shared/session-digest.js";
import {
  normalizeSessionTopology,
  type SessionTopologyMeta,
} from "../../../shared/session-topology.js";

export const CLI_AGENT_ID = "cli";
export const SESSION_INDEX_FILENAME = "session-index.json";

export interface CliSessionLine {
  type: "user" | "assistant" | "tool" | "metadata";
  content?: string;
  ts: string;
  data?: Record<string, unknown>;
  /** Stable message id; new lines always get one. */
  uuid?: string;
  /** Previous line in this conversation; null starts a new chain (e.g. after /clear). */
  parentUuid?: string | null;
  /** Kept across a compaction boundary so forks/rewinds can find the pre-compaction leaf. */
  logicalParentUuid?: string;
  /** True for subagent/sidechain transcripts. */
  isSidechain?: boolean;
}

const lastUuidByPath = new Map<string, string | null>();

async function readLastUuid(sessionPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]!) as { uuid?: unknown };
        if (typeof parsed.uuid === "string" && parsed.uuid) return parsed.uuid;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveChain(
  target: string,
  line: Omit<CliSessionLine, "ts"> & { ts?: string },
): Promise<{ uuid: string; parentUuid: string | null }> {
  const explicitParent = Object.prototype.hasOwnProperty.call(line, "parentUuid");
  const uuid = typeof line.uuid === "string" && line.uuid ? line.uuid : randomUUID();
  let parentUuid: string | null;
  if (explicitParent) {
    parentUuid = line.parentUuid ?? null;
  } else if (lastUuidByPath.has(target)) {
    parentUuid = lastUuidByPath.get(target) ?? null;
  } else {
    parentUuid = await readLastUuid(target);
  }
  lastUuidByPath.set(target, uuid);
  return { uuid, parentUuid };
}

export interface CliSessionMetadataInput {
  dataDir: string;
  sessionPath: string;
  data: Record<string, unknown>;
}

export interface CliSessionIndexEntry {
  path: string;
  title: string | null;
  firstMessage: string;
  modified: string | null;
  messageCount: number;
  cwd: string;
  agentId: string | null;
  agentName: string | null;
  modelId: string | null;
  modelProvider: string | null;
  pinned: boolean;
  labels: unknown[];
  topology: SessionTopologyMeta | null;
  digest: SessionDigest | null;
  insights: SessionInsight[];
}

export interface CliSessionIndexPayload {
  version: 1;
  updatedAt: string;
  sessions: CliSessionIndexEntry[];
}

export function resolveDataDir(explicit?: string | null): string {
  if (explicit?.trim()) return path.resolve(explicit);
  if (process.env.LYNN_DATA_DIR?.trim()) return path.resolve(process.env.LYNN_DATA_DIR);
  if (process.env.LYNN_HOME?.trim()) return path.resolve(process.env.LYNN_HOME.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), ".lynn");
}

export function cliSessionDir(dataDir: string): string {
  return path.join(dataDir, "agents", CLI_AGENT_ID, "sessions");
}

export function sessionIndexPath(dataDir: string): string {
  return path.join(cliSessionDir(dataDir), SESSION_INDEX_FILENAME);
}

export function newSessionPath(dataDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(cliSessionDir(dataDir), `${stamp}-${suffix}.jsonl`);
}

async function readIndex(dataDir: string): Promise<CliSessionIndexEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionIndexPath(dataDir), "utf8")) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? parsed.sessions as CliSessionIndexEntry[] : [];
  } catch {
    return [];
  }
}

async function writeIndex(dataDir: string, entries: CliSessionIndexEntry[]): Promise<void> {
  const dir = cliSessionDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const payload: CliSessionIndexPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: entries,
  };
  const target = sessionIndexPath(dataDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

const indexLockQueues = new Map<string, Promise<void>>();

async function withIndexLock<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(cliSessionDir(dataDir), { recursive: true });
  const key = await fs.realpath(cliSessionDir(dataDir));
  const previous = indexLockQueues.get(key) || Promise.resolve();
  const operation = previous.then(() => withIndexFileLock(dataDir, run));
  const settled = operation.then(() => {}, () => {});
  indexLockQueues.set(key, settled);
  try { return await operation; }
  finally { if (indexLockQueues.get(key) === settled) indexLockQueues.delete(key); }
}

async function withIndexFileLock<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
  const dir = cliSessionDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const release = await lockfile.lock(sessionIndexPath(dataDir), {
    realpath: false,
    stale: 10_000,
    update: 2_000,
    retries: { retries: 100, minTimeout: 250, maxTimeout: 250, factor: 1 },
    fs: {
      ...callbackFs,
      rmdir(lockPath, callback) {
        callbackFs.rmdir(lockPath, (error) => {
          if (error?.code !== "ENOTDIR" && error?.code !== "ENOENT") return callback(error);
          callbackFs.lstat(lockPath, (statError, stat) => {
            if (statError) return callback(statError);
            if (!stat.isFile() || stat.size !== 0 || stat.mtimeMs >= Date.now() - 10_000) {
              return callback(error);
            }
            callbackFs.unlink(lockPath, callback);
          });
        });
      },
    },
  });
  try {
    return await run();
  } finally {
    await release();
  }
}

export interface SessionReadResult {
  lines: CliSessionLine[];
  /** Count of non-empty lines that failed to parse (e.g. a line torn by a crash mid-append). */
  skipped: number;
}

/**
 * Read a session JSONL file, tolerating malformed lines instead of failing the
 * whole read. The most likely corruption is a half-written trailing line from a
 * crash — which is exactly the case resume exists to recover — so one bad line
 * must never make an entire session unreadable. Returns the parsed lines plus a
 * count of how many were skipped, for transparency on resume.
 */
export async function readSessionLinesResult(sessionPath: string): Promise<SessionReadResult> {
  const raw = await fs.readFile(sessionPath, "utf8");
  const lines: CliSessionLine[] = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line) as CliSessionLine);
    } catch {
      skipped += 1;
    }
  }
  return { lines, skipped };
}

export async function readSessionLines(sessionPath: string): Promise<CliSessionLine[]> {
  return (await readSessionLinesResult(sessionPath)).lines;
}

export async function appendSessionTurn(input: {
  dataDir: string;
  sessionPath?: string | null;
  cwd: string;
  title?: string | null;
  prompt: string;
  assistant: string;
  modelId?: string | null;
  modelProvider?: string | null;
  topology?: unknown;
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ts = new Date().toISOString();
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();
  const parent = await readLastUuid(target);
  const lines: CliSessionLine[] = [
    { type: "user", content: input.prompt, ts, uuid: userUuid, parentUuid: parent },
    { type: "assistant", content: input.assistant, ts: new Date().toISOString(), uuid: assistantUuid, parentUuid: userUuid },
  ];
  lastUuidByPath.set(target, assistantUuid);
  await fs.appendFile(target, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  await withIndexLock(input.dataDir, async () => {
    const existing = await readIndex(input.dataDir);
    const old = existing.find((entry) => path.resolve(entry.path) === path.resolve(target));
    const messageCount = (old?.messageCount || 0) + 2;
    const entry: CliSessionIndexEntry = {
      path: target,
      title: input.title || old?.title || input.prompt.slice(0, 80) || null,
      firstMessage: old?.firstMessage || input.prompt,
      modified: new Date().toISOString(),
      messageCount,
      cwd: input.cwd,
      agentId: CLI_AGENT_ID,
      agentName: "Lynn CLI",
      modelId: input.modelId || old?.modelId || null,
      modelProvider: input.modelProvider || old?.modelProvider || null,
      pinned: old?.pinned || false,
      labels: Array.isArray(old?.labels) ? old.labels : [],
      topology: normalizeSessionTopology(input.topology ?? old?.topology),
      digest: normalizeSessionDigest(old?.digest),
      insights: normalizeSessionInsights(old?.insights),
    };
    const next = [entry, ...existing.filter((candidate) => path.resolve(candidate.path) !== path.resolve(target))];
    await writeIndex(input.dataDir, next);
  });
  return target;
}

export async function appendSessionLine(input: {
  dataDir: string;
  sessionPath?: string | null;
  cwd: string;
  title?: string | null;
  line: Omit<CliSessionLine, "ts"> & { ts?: string };
  modelId?: string | null;
  modelProvider?: string | null;
  topology?: unknown;
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const chain = await resolveChain(target, input.line);
  const line: CliSessionLine = {
    ...input.line,
    uuid: chain.uuid,
    parentUuid: chain.parentUuid,
    ts: input.line.ts || new Date().toISOString(),
  };
  await fs.appendFile(target, `${JSON.stringify(line)}\n`, "utf8");

  await withIndexLock(input.dataDir, async () => {
    const existing = await readIndex(input.dataDir);
    const old = existing.find((entry) => path.resolve(entry.path) === path.resolve(target));
    const isMessage = line.type === "user" || line.type === "assistant";
    const messageCount = (old?.messageCount || 0) + (isMessage ? 1 : 0);
    const firstMessage = old?.firstMessage || (line.type === "user" && line.content ? line.content : input.title || "");
    const entry: CliSessionIndexEntry = {
      path: target,
      title: input.title || old?.title || (line.content || "").slice(0, 80) || null,
      firstMessage,
      modified: new Date().toISOString(),
      messageCount,
      cwd: input.cwd,
      agentId: CLI_AGENT_ID,
      agentName: "Lynn CLI",
      modelId: input.modelId || old?.modelId || null,
      modelProvider: input.modelProvider || old?.modelProvider || null,
      pinned: old?.pinned || false,
      labels: Array.isArray(old?.labels) ? old.labels : [],
      topology: normalizeSessionTopology(input.topology ?? old?.topology),
      digest: normalizeSessionDigest(old?.digest),
      insights: normalizeSessionInsights(old?.insights),
    };
    const next = [entry, ...existing.filter((candidate) => path.resolve(candidate.path) !== path.resolve(target))];
    await writeIndex(input.dataDir, next);
  });
  return target;
}

export async function appendSessionMetadata(input: CliSessionMetadataInput): Promise<void> {
  const target = path.resolve(input.sessionPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify({ type: "metadata", ts: new Date().toISOString(), data: input.data } satisfies CliSessionLine)}\n`, "utf8");
}

export async function listSessions(dataDir: string): Promise<CliSessionIndexEntry[]> {
  const entries = await readIndex(dataDir);
  return entries.sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")));
}

export async function latestSessionPath(dataDir: string): Promise<string | null> {
  const latest = (await listSessions(dataDir))[0];
  return latest?.path || null;
}

export interface ForkSessionResult {
  path: string;
  lines: number;
  forkedFrom: string;
}

/**
 * Copy a session into a new file with a fresh uuid chain. Used by
 * `Lynn sessions fork` and by future branching UI: the original transcript is
 * never modified, so an experiment can always be traced back.
 */
export async function forkSession(input: {
  dataDir: string;
  sourcePath: string;
  title?: string | null;
}): Promise<ForkSessionResult> {
  const source = path.resolve(input.sourcePath);
  const { lines } = await readSessionLinesResult(source);
  const idMap = new Map<string, string>();
  for (const line of lines) {
    if (typeof line.uuid === "string" && line.uuid) idMap.set(line.uuid, randomUUID());
  }
  const target = newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const forked: CliSessionLine[] = lines.map((line) => {
    const oldUuid = typeof line.uuid === "string" ? line.uuid : "";
    const uuid = idMap.get(oldUuid) || randomUUID();
    const oldParent = typeof line.parentUuid === "string" ? line.parentUuid : null;
    return {
      ...line,
      uuid,
      parentUuid: oldParent ? idMap.get(oldParent) ?? null : null,
      ...(typeof line.logicalParentUuid === "string" && line.logicalParentUuid
        ? { logicalParentUuid: idMap.get(line.logicalParentUuid) ?? undefined }
        : {}),
    };
  });
  await fs.writeFile(target, forked.map((line) => JSON.stringify(line)).join("\n") + (forked.length ? "\n" : ""), "utf8");
  lastUuidByPath.set(target, forked.at(-1)?.uuid || null);
  // Register the fork in the index and record its origin.
  await appendSessionLine({
    dataDir: input.dataDir,
    sessionPath: target,
    cwd: typeof lines.find((line) => line.data?.cwd)?.data?.cwd === "string"
      ? String(lines.find((line) => line.data?.cwd)?.data?.cwd)
      : process.cwd(),
    title: input.title || `fork of ${path.basename(source)}`,
    line: { type: "metadata", data: { kind: "session_fork", forkedFrom: source, forkedAt: new Date().toISOString() } },
  });
  return { path: target, lines: forked.length, forkedFrom: source };
}
