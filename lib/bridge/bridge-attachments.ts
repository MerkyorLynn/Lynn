import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { findSessionFile, resolveSessionFile } from "../session-files.js";
import { debugLog } from "../debug-log.js";
import { bufferToBase64, detectMime, downloadMedia, formatSize, validateRemoteMediaSource } from "./media-utils.js";
import type { BridgeAdapter, BridgeAttachment } from "./adapter-types.js";

interface BridgePromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ResolvedBridgeAttachments {
  images: BridgePromptImage[];
  textNotes: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function downloadBridgeAttachment(
  adapter: BridgeAdapter | null | undefined,
  att: BridgeAttachment,
): Promise<Buffer | null> {
  if (att.url) return downloadMedia(att.url) as Promise<Buffer>;
  if (att.platformRef && att._messageId && adapter?.downloadFile) {
    return adapter.downloadFile(att._messageId, att.platformRef);
  }
  return null;
}

export async function tryReadBridgeTextFile(
  adapter: BridgeAdapter | null | undefined,
  att: BridgeAttachment,
): Promise<string | null> {
  const textExtensions = new Set([
    "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml",
    "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh",
    "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
    "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp",
    "cs", "swift", "r", "lua", "pl", "html", "htm", "css", "scss",
    "less", "svg", "env", "gitignore", "dockerignore", "makefile",
    "dockerfile", "rst", "tex", "bib",
  ]);
  const maxTextFileSize = 1024 * 1024;

  const filename = (att.filename || "").toLowerCase();
  const ext = filename.split(".").pop() || "";
  if (!textExtensions.has(ext)) return null;
  if (att.size && att.size > maxTextFileSize) return null;

  try {
    const buffer = await downloadBridgeAttachment(adapter, att);
    if (!buffer) return null;
    if (buffer.length > maxTextFileSize) return null;
    if (buffer.slice(0, 8192).includes(0x00)) return null;
    return buffer.toString("utf-8");
  } catch (err: unknown) {
    debugLog()?.warn("bridge", `文件文本读取失败: ${errorMessage(err)}`);
    return null;
  }
}

export async function resolveBridgeAttachments(
  adapter: BridgeAdapter | null | undefined,
  attachments?: BridgeAttachment[],
): Promise<ResolvedBridgeAttachments> {
  const images: BridgePromptImage[] = [];
  const notes: string[] = [];
  if (!attachments?.length) return { images, textNotes: "" };

  for (const att of attachments) {
    try {
      if (att.type === "image") {
        let buffer: Buffer | null | undefined;
        if (att.url) {
          buffer = await downloadMedia(att.url) as Buffer;
        } else if (att.platformRef && adapter?.downloadImage) {
          buffer = await adapter.downloadImage(att.platformRef);
        }
        if (buffer) {
          const mime = detectMime(buffer, att.mimeType || "image/jpeg");
          images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
        }
      } else if (att.type === "audio") {
        const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
        notes.push(`[收到语音${dur}]`);
      } else if (att.type === "video") {
        notes.push(`[收到视频: ${att.filename || "video"}]`);
      } else {
        const filename = att.filename || "file";
        const size = att.size ? ` (${formatSize(att.size)})` : "";
        const textContent = await tryReadBridgeTextFile(adapter, att);
        if (textContent !== null) {
          notes.push(`[文件: ${filename}${size}]\n\`\`\`\n${textContent}\n\`\`\``);
        } else {
          notes.push(`[收到文件: ${filename}${size}]`);
        }
      }
    } catch (err: unknown) {
      debugLog()?.warn("bridge", `附件解析失败: ${errorMessage(err)}`);
      notes.push(`[附件加载失败: ${att.filename || att.type}]`);
    }
  }
  return { images, textNotes: notes.join("\n") };
}

export async function sendBridgeMediaItem(
  adapter: BridgeAdapter,
  chatId: string,
  source: string,
  sessionPath?: string,
): Promise<void> {
  const isLocal = path.isAbsolute(source) || source.startsWith("file://");
  if (isLocal) {
    const localPath = source.startsWith("file://") ? fileURLToPath(source) : source;
    const file = sessionPath ? findSessionFile(sessionPath, localPath) : undefined;
    if (!sessionPath || !file) throw new Error("Media must be registered by a tool in this session");
    const resolved = resolveSessionFile(sessionPath, file.fileId).localPath;
    if (!adapter.sendMediaBuffer) throw new Error("Platform cannot send registered local media");
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let buffer: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Invalid media file");
      buffer = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const mime = detectMime(buffer, "application/octet-stream");
    const filename = path.basename(source.startsWith("file://") ? source.replace(/^file:\/\//, "") : source);
    await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
  } else if (adapter.sendMedia) {
    await validateRemoteMediaSource(source);
    await adapter.sendMedia(chatId, source);
  } else {
    await adapter.sendReply(chatId, source);
  }
}
