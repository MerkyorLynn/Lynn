import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLI_AGENT_ID = "cli";
export const SESSION_INDEX_FILENAME = "session-index.json";

export interface CliSessionLine {
  type: "user" | "assistant" | "tool" | "metadata";
  content?: string;
  ts: string;
  data?: Record<string, unknown>;
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

async function withIndexLock<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
  const dir = cliSessionDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = `${sessionIndexPath(dataDir)}.lock`;
  let handle: fs.FileHandle | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await sleep(Math.min(250, 10 + attempt * 5));
    }
  }
  if (!handle) {
    throw new Error(`timed out waiting for session index lock: ${lockPath}`);
  }
  try {
    return await run();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ts = new Date().toISOString();
  const lines: CliSessionLine[] = [
    { type: "user", content: input.prompt, ts },
    { type: "assistant", content: input.assistant, ts: new Date().toISOString() },
  ];
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
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const line: CliSessionLine = {
    ...input.line,
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
