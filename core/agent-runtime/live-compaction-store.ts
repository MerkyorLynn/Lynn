import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LiveCompactionReplacement } from "./live-compaction-types.js";

export interface LiveRawRecord {
  toolCallId: string;
  rawRef: string;
  bytes: number;
  sha256: string;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function rawFileName(toolCallId: string): string {
  return `raw-${digest(toolCallId).slice(0, 24)}.txt`;
}

export function rawBackupRef(root: string, toolCallId: string): string {
  return path.join(root, rawFileName(toolCallId));
}

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`live compaction ${label} is not a regular file`);
}

function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeExclusive(file: string, body: Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

function verifyRecord(record: LiveRawRecord): boolean {
  try {
    assertRegularFile(record.rawRef, "raw backup");
    const body = fs.readFileSync(record.rawRef);
    return body.length === record.bytes && digest(body) === record.sha256;
  } catch {
    return false;
  }
}

function verifyMetadata(metaRef: string, record: LiveRawRecord): boolean {
  try {
    assertRegularFile(metaRef, "raw metadata");
    const metadata = JSON.parse(fs.readFileSync(metaRef, "utf8"));
    return metadata?.version === 1
      && metadata?.toolCallId === record.toolCallId
      && metadata?.rawRef === record.rawRef
      && metadata?.bytes === record.bytes
      && metadata?.sha256 === record.sha256;
  } catch {
    return false;
  }
}

async function ensureDirectoryAsync(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
}

async function assertRegularFileAsync(file: string, label: string): Promise<void> {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile()) throw new Error(`live compaction ${label} is not a regular file`);
}

async function verifyRecordAsync(record: LiveRawRecord): Promise<boolean> {
  try {
    await assertRegularFileAsync(record.rawRef, "raw backup");
    const body = await fs.promises.readFile(record.rawRef);
    return body.length === record.bytes && digest(body) === record.sha256;
  } catch {
    return false;
  }
}

async function verifyMetadataAsync(metaRef: string, record: LiveRawRecord): Promise<boolean> {
  try {
    await assertRegularFileAsync(metaRef, "raw metadata");
    const metadata = JSON.parse(await fs.promises.readFile(metaRef, "utf8"));
    return metadata?.version === 1
      && metadata?.toolCallId === record.toolCallId
      && metadata?.rawRef === record.rawRef
      && metadata?.bytes === record.bytes
      && metadata?.sha256 === record.sha256;
  } catch {
    return false;
  }
}

export function liveCompactionRoot(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, ".live-compact", sessionId);
}

export class LiveCompactionStore {
  readonly root: string;

  constructor(sessionDir: string, sessionId: string) {
    this.root = liveCompactionRoot(sessionDir, sessionId);
  }

  capture(toolCallId: string, text: string): LiveRawRecord {
    if (!toolCallId) throw new Error("live compaction raw backup requires a toolCallId");
    ensureDirectory(this.root);
    const body = Buffer.from(String(text ?? ""), "utf8");
    const rawRef = rawBackupRef(this.root, toolCallId);
    const record: LiveRawRecord = {
      toolCallId,
      rawRef,
      bytes: body.length,
      sha256: digest(body),
    };

    if (fs.existsSync(rawRef)) {
      assertRegularFile(rawRef, "raw backup");
      const existing = fs.readFileSync(rawRef);
      if (existing.length !== record.bytes || digest(existing) !== record.sha256) {
        throw new Error(`live compaction raw backup hash mismatch for ${toolCallId}`);
      }
    } else {
      try {
        writeExclusive(rawRef, body);
      } catch (error: any) {
        if (error?.code !== "EEXIST") {
          try { fs.rmSync(rawRef, { force: true }); } catch {}
          throw error;
        }
      }
    }

    if (!verifyRecord(record)) throw new Error(`live compaction raw backup verification failed for ${toolCallId}`);

    const metaRef = `${rawRef}.meta.json`;
    const metadata = Buffer.from(JSON.stringify({ ...record, version: 1 }) + "\n", "utf8");
    if (!fs.existsSync(metaRef)) {
      const temp = `${metaRef}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeExclusive(temp, metadata);
        fs.renameSync(temp, metaRef);
      } catch (error: any) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!verifyMetadata(metaRef, record)) {
      throw new Error(`live compaction raw metadata verification failed for ${toolCallId}`);
    }
    fs.chmodSync(metaRef, 0o600);
    return record;
  }

  async captureAsync(toolCallId: string, text: string): Promise<LiveRawRecord> {
    if (!toolCallId) throw new Error("live compaction raw backup requires a toolCallId");
    await ensureDirectoryAsync(this.root);
    const body = Buffer.from(String(text ?? ""), "utf8");
    const rawRef = rawBackupRef(this.root, toolCallId);
    const record: LiveRawRecord = {
      toolCallId,
      rawRef,
      bytes: body.length,
      sha256: digest(body),
    };

    try {
      await assertRegularFileAsync(rawRef, "raw backup");
      const existing = await fs.promises.readFile(rawRef);
      if (existing.length !== record.bytes || digest(existing) !== record.sha256) {
        throw new Error(`live compaction raw backup hash mismatch for ${toolCallId}`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(rawRef, "wx", 0o600);
        await handle.writeFile(body);
        await handle.sync();
      } catch (writeError: any) {
        if (writeError?.code !== "EEXIST") {
          try { await fs.promises.rm(rawRef, { force: true }); } catch {}
          throw writeError;
        }
      } finally {
        await handle?.close().catch(() => {});
      }
    }

    if (!(await verifyRecordAsync(record))) {
      throw new Error(`live compaction raw backup verification failed for ${toolCallId}`);
    }

    const metaRef = `${rawRef}.meta.json`;
    const metadata = Buffer.from(JSON.stringify({ ...record, version: 1 }) + "\n", "utf8");
    if (!fs.existsSync(metaRef)) {
      const temp = `${metaRef}.${process.pid}.${crypto.randomUUID()}.tmp`;
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(temp, "wx", 0o600);
        await handle.writeFile(metadata);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(temp, metaRef);
      } catch (error: any) {
        await handle?.close().catch(() => {});
        try { await fs.promises.rm(temp, { force: true }); } catch {}
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!(await verifyMetadataAsync(metaRef, record))) {
      throw new Error(`live compaction raw metadata verification failed for ${toolCallId}`);
    }
    await fs.promises.chmod(metaRef, 0o600);
    return record;
  }
}

export function verifyLiveCompactionReplacement(replacement: LiveCompactionReplacement): boolean {
  try {
    assertRegularFile(replacement.rawRef, "raw backup");
    const body = fs.readFileSync(replacement.rawRef);
    if (body.length !== replacement.bytes || digest(body) !== replacement.sha256) return false;
    if (replacement.originalContentSha256 !== replacement.sha256) return false;
    return verifyMetadata(`${replacement.rawRef}.meta.json`, {
      toolCallId: replacement.toolCallId,
      rawRef: replacement.rawRef,
      bytes: replacement.bytes,
      sha256: replacement.sha256,
    });
  } catch {
    return false;
  }
}

export function contentSha256(text: string): string {
  return digest(Buffer.from(String(text ?? ""), "utf8"));
}
