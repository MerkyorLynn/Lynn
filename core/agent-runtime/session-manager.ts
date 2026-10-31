import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ImageContent, TextContent } from "./types.js";

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface BaseEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: ChatMessage;
}

export type SessionEntry = BaseEntry | MessageEntry;
export type SessionFileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  timestamp?: string;
}

export interface SessionContext {
  messages: ChatMessage[];
}

type SessionListProgress = (loaded: number, total: number) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function fileTimestamp(): string {
  return nowIso().replace(/[:.]/g, "-");
}

function sessionDirFor(cwd: string): string {
  const base = process.env.LYNN_HOME || path.join(process.env.HOME || process.cwd(), ".lynn");
  const encoded = Buffer.from(path.resolve(cwd)).toString("base64url");
  return path.join(base, "sessions", encoded);
}

function parseJsonl(file: string): SessionFileEntry[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const entries: SessionFileEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionFileEntry);
      } catch {
        // append-only logs should be replay-tolerant; a corrupt line should not hide the rest.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function lastModified(file: string): Date {
  try {
    return fs.statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}

function makeHeader(cwd: string, parentSession?: string): SessionHeader {
  return {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: nowIso(),
    cwd,
    parentSession,
  };
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  if (typeof message.content === "string" || Array.isArray(message.content) || typeof message.content === "undefined") {
    return { ...message };
  }
  return { ...message, content: String(message.content) };
}

export class SessionManager {
  fileEntries: SessionFileEntry[] = [];
  byId = new Map<string, SessionEntry>();
  labelsById = new Map<string, string>();
  leafId: string | null = null;

  private readonly cwd: string;
  private readonly dir: string;
  private readonly persist: boolean;
  private sessionId: string;
  private sessionFile?: string;
  private flushed = false;
  private closed = false;

  close(): void {
    this.closed = true;
  }

  private constructor(cwd: string, dir: string, file?: string, persist = true, parentSession?: string) {
    this.cwd = path.resolve(cwd || process.cwd());
    this.dir = dir;
    this.persist = persist;
    if (file && fs.existsSync(file)) {
      this.sessionFile = file;
      this.fileEntries = parseJsonl(file);
    }
    if (!this.fileEntries.length) {
      const header = makeHeader(this.cwd, parentSession);
      this.fileEntries = [header];
      this.sessionId = header.id;
      this.sessionFile = file || (persist ? path.join(dir, `${fileTimestamp()}_${header.id}.jsonl`) : undefined);
    } else {
      const header = this.getHeader();
      this.sessionId = header?.id || randomUUID();
    }
    this._buildIndex();
  }

  static create(cwd: string = process.cwd(), sessionDir?: string): SessionManager {
    const dir = sessionDir || sessionDirFor(cwd);
    return new SessionManager(cwd, dir, undefined, true);
  }

  static open(file: string, sessionDir?: string): SessionManager {
    const entries = parseJsonl(file);
    const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
    return new SessionManager(header?.cwd || process.cwd(), sessionDir || path.dirname(file), file, true);
  }

  static continueRecent(cwd: string = process.cwd(), sessionDir?: string): SessionManager {
    const dir = sessionDir || sessionDirFor(cwd);
    const files = listJsonlFiles(dir).sort((a, b) => lastModified(b).getTime() - lastModified(a).getTime());
    return files[0] ? SessionManager.open(files[0], dir) : SessionManager.create(cwd, dir);
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }

  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager {
    const sourceEntries = parseJsonl(sourcePath);
    const dir = sessionDir || sessionDirFor(targetCwd);
    const manager = new SessionManager(targetCwd, dir, undefined, true, sourcePath);
    manager.fileEntries = [manager.getHeader()!, ...sourceEntries.filter((entry) => entry.type !== "session") as SessionEntry[]];
    manager._buildIndex();
    manager._rewriteFile();
    return manager;
  }

  static async list(cwd: string = process.cwd(), sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const dir = sessionDir || sessionDirFor(cwd);
    return listSessionsFromFiles(listJsonlFiles(dir), onProgress);
  }

  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const base = path.join(process.env.LYNN_HOME || path.join(process.env.HOME || process.cwd(), ".lynn"), "sessions");
    const files: string[] = [];
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        files.push(...listJsonlFiles(path.join(base, entry.name)));
      }
    } catch {
      return [];
    }
    return listSessionsFromFiles(files, onProgress);
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.dir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  _buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry as SessionEntry);
      this.leafId = entry.id;
      if (entry.type === "label" && typeof entry.targetId === "string") {
        if (typeof entry.label === "string" && entry.label) this.labelsById.set(entry.targetId, entry.label);
        else this.labelsById.delete(entry.targetId);
      }
    }
  }

  _persist(): void {
    if (this.closed || !this.persist || !this.sessionFile) return;
    if (this.flushed) return;
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    fs.writeFileSync(this.sessionFile, this.fileEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    this.flushed = true;
  }

  _rewriteFile(): void {
    this.flushed = false;
    this._persist();
  }

  private appendEntry<T extends SessionEntry>(entry: T): string {
    if (this.closed) return entry.id;
    if (this.persist && this.sessionFile && !fs.existsSync(this.sessionFile)) this._persist();
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.flushed = false;
    if (this.persist && this.sessionFile) {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
      this.flushed = true;
    }
    return entry.id;
  }

  appendMessage(message: ChatMessage): string {
    const entry: MessageEntry = {
      type: "message",
      id: randomUUID(),
      parentId: this.leafId,
      timestamp: nowIso(),
      message: normalizeMessage(message),
    };
    return this.appendEntry(entry);
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    return this.appendCustomTyped("thinking_level_change", { thinkingLevel });
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.appendCustomTyped("model_change", { provider, modelId });
  }

  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string {
    return this.appendCustomTyped("compaction", { summary, firstKeptEntryId, tokensBefore, details, fromHook });
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.appendCustomTyped("custom", { customType, data });
  }

  appendSessionInfo(name: string): string {
    return this.appendCustomTyped("session_info", { name: name.trim() });
  }

  appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string {
    return this.appendCustomTyped("custom_message", { customType, content, display, details });
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    const id = this.appendCustomTyped("label", { targetId, label });
    if (label) this.labelsById.set(targetId, label);
    else this.labelsById.delete(targetId);
    return id;
  }

  private appendCustomTyped(type: string, payload: Record<string, unknown>): string {
    return this.appendEntry({
      type,
      id: randomUUID(),
      parentId: this.leafId,
      timestamp: nowIso(),
      ...payload,
    });
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.getEntries().filter((entry) => entry.parentId === parentId);
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getBranch(fromId?: string): SessionEntry[] {
    const pathEntries: SessionEntry[] = [];
    let cursor = fromId || this.leafId;
    while (cursor) {
      const entry = this.byId.get(cursor);
      if (!entry) break;
      pathEntries.unshift(entry);
      cursor = entry.parentId;
    }
    return pathEntries;
  }

  buildSessionContext(): SessionContext {
    const messages: ChatMessage[] = [];
    const branch = this.getBranch();
    const compaction = [...branch].reverse().find(entry => entry.type === "compaction");
    let started = !compaction;
    if (compaction && typeof compaction.summary === "string") {
      messages.push({ role: "user", content: `Earlier conversation summary (reference data; current user instructions take precedence):\n${compaction.summary}` });
    }
    for (const entry of branch) {
      if (!started && entry.id === compaction?.firstKeptEntryId) started = true;
      if (!started) continue;
      if (entry.type === "message") messages.push((entry as MessageEntry).message);
      if (entry.type === "custom_message" && "content" in entry) {
        messages.push({ role: "user", content: entry.content as ChatMessage["content"] });
      }
    }
    return { messages };
  }

  getHeader(): SessionHeader | null {
    return (this.fileEntries.find((entry): entry is SessionHeader => entry.type === "session") || null);
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  }

  getTree(): Array<{ entry: SessionEntry; children: unknown[]; label?: string }> {
    return this.getEntries().map((entry) => ({ entry, children: [], label: this.labelsById.get(entry.id) }));
  }

  getSessionName(): string | undefined {
    for (const entry of [...this.getEntries()].reverse()) {
      if (entry.type === "session_info" && typeof entry.name === "string") return entry.name;
    }
    return undefined;
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
    this.leafId = branchFromId;
    return this.appendCustomTyped("branch_summary", { fromId: branchFromId || "root", summary, details, fromHook });
  }

  createBranchedSession(leafId: string): string | undefined {
    if (!this.persist) return undefined;
    const branch = this.getBranch(leafId);
    const header = makeHeader(this.cwd, this.sessionFile);
    const file = path.join(this.dir, `${fileTimestamp()}_${header.id}.jsonl`);
    this.fileEntries = [header, ...branch];
    this.sessionFile = file;
    this.sessionId = header.id;
    this._buildIndex();
    this._rewriteFile();
    return file;
  }
}

function listJsonlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

async function listSessionsFromFiles(files: string[], onProgress?: SessionListProgress): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let loaded = 0;
  for (const file of files) {
    const entries = parseJsonl(file);
    const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
    if (header) {
      sessions.push({
        id: header.id,
        path: file,
        cwd: header.cwd,
        modified: lastModified(file),
        timestamp: header.timestamp,
        name: entries.find((entry) => entry.type === "session_info" && typeof (entry as Record<string, unknown>).name === "string")
          ? String((entries.find((entry) => entry.type === "session_info") as Record<string, unknown>).name)
          : undefined,
      });
    }
    loaded++;
    onProgress?.(loaded, files.length);
  }
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}
