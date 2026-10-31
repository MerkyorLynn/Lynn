/**
 * media-utils.ts — Bridge 媒体工具层
 *
 * 对标 OpenClaw 的 loadWebMedia + splitMediaFromOutput。
 * 集中处理入站媒体下载和出站回复媒体提取。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isPrivateHost } from "../../shared/network-address.cjs";

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export async function validateRemoteMediaSource(source: string): Promise<void> {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) throw new Error("Media requires a public HTTPS URL");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateHost(address))) throw new Error("Private media address is not allowed");
}

async function downloadRemoteMedia(source: string): Promise<Buffer> {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) throw new Error("Media requires a public HTTPS URL");
  const signal = AbortSignal.timeout(10_000);
  const addresses = await Promise.race([
    lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
  if (!addresses.length || addresses.some(({ address }) => isPrivateHost(address))) throw new Error("Private media address is not allowed");
  const destination = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal,
      family: destination.family,
      // Pin the checked DNS result, preserving the original host for TLS.
      lookup: (_host, _options, cb) => cb(null, destination.address, destination.family),
    }, (response) => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"] || 0) > MAX_MEDIA_BYTES) {
        response.destroy(); reject(new Error("Media response rejected (redirect, status or size)")); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_MEDIA_BYTES) { response.destroy(new Error("Media exceeds 50 MB")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ── 本地路径安全白名单（对标 OpenClaw mediaLocalRoots）────

let _allowedRoots: string[] = [];

/**
 * 设置允许读取的本地目录白名单。
 * 由 BridgeManager 初始化时调用，传入 LYNN_HOME 和 workspace。
 */
export function setMediaLocalRoots(roots: string[]): void {
  _allowedRoots = roots.map(r => path.resolve(r));
}

function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return _allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
}

// ── 入站：下载媒体 ──────────────────────────────────────

/**
 * 下载媒体资源，返回 Buffer。
 * 支持 http:// / https:// / data: / 本地路径（需在白名单内）。
 */
export async function downloadMedia(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("invalid data URI");
    if (url.length > Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 1024) throw new Error("Media exceeds 50 MB");
    const buffer = Buffer.from(url.slice(comma + 1), "base64");
    if (buffer.length > MAX_MEDIA_BYTES) throw new Error("Media exceeds 50 MB");
    return buffer;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return downloadRemoteMedia(url);
  }
  // 本地路径（file:// URI 或绝对路径）
  const localPath = url.startsWith("file://") ? fileUrlToPath(url) : url;
  if (path.isAbsolute(localPath)) {
    // 解析 symlink 再校验白名单，防止 symlink 绕过
    let realPath: string;
    try { realPath = fs.realpathSync(localPath); }
    catch { throw new Error(`file not found: ${localPath}`); }
    if (!isPathAllowed(realPath)) {
      throw new Error(`path outside allowed roots`);
    }
    // 大小保护（50MB）
    const stat = fs.statSync(realPath);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) {
      throw new Error(`file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }
    return fs.readFileSync(realPath);
  }
  throw new Error(`unsupported media source: ${url.slice(0, 30)}`);
}

/** file:// URI → 本地路径 */
function fileUrlToPath(fileUrl: string): string {
  return fileURLToPath(fileUrl);
}

/**
 * Buffer → base64 字符串（不含 data: 前缀）
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

// ── MIME 检测（magic bytes）─────────────────────────────

type MagicEntry = {
  bytes: number[];
  mime: string;
  offset?: number;
  extra?: number[];
  minLen?: number;
  check?: (buffer: Buffer) => boolean;
};

const MAGIC_TABLE: MagicEntry[] = [
  { bytes: [0xFF, 0xD8, 0xFF],                         mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4E, 0x47],                   mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38],                   mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46],                   mime: "image/webp", offset: 8, extra: [0x57, 0x45, 0x42, 0x50] },
  { bytes: [0x25, 0x50, 0x44, 0x46],                   mime: "application/pdf" },
  { bytes: [0x49, 0x44, 0x33],                         mime: "audio/mpeg" },
  { bytes: [0x4F, 0x67, 0x67, 0x53],                   mime: "audio/ogg" },
  { bytes: [0x00, 0x00, 0x00],                         mime: "video/mp4", minLen: 8, check: (b) => b.length >= 8 && (b.toString("ascii", 4, 8) === "ftyp") },
];

/**
 * 检测 Buffer 的真实 MIME（magic bytes 优先）。
 * 检测不出时返回 fallback 或 "application/octet-stream"。
 */
export function detectMime(buffer: Buffer, fallback?: string): string {
  for (const entry of MAGIC_TABLE) {
    if (buffer.length < entry.bytes.length) continue;
    const match = entry.bytes.every((b, i) => buffer[i] === b);
    if (!match) continue;
    if (entry.extra) {
      const off = entry.offset || 0;
      if (buffer.length < off + entry.extra.length) continue;
      if (!entry.extra.every((b, i) => buffer[off + i] === b)) continue;
    }
    if (entry.check && !entry.check(buffer)) continue;
    return entry.mime;
  }
  return fallback || "application/octet-stream";
}

// ── 出站：从 LLM 回复中提取媒体 ────────────────────────

const MEDIA_LINE_RE = /^MEDIA:\s*<?(.+?)>?\s*$/;
const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/;

/**
 * 对标 OpenClaw splitMediaFromOutput()
 *
 * 提取规则（按优先级）：
 * 1. MEDIA:<url> 指令行（主协议，不区分媒体类型）
 * 2. ![alt](url) markdown 图片（弱 fallback）
 *
 * 安全规则：
 * - 不从 fenced code block 内提取
 * - 无效 URL 静默丢弃
 *
 * @param {string} text
 * @returns {{ text: string, mediaUrls: string[] }}
 */
export function splitMediaFromOutput(text: string): { text: string; mediaUrls: string[] } {
  const mediaUrls: string[] = [];
  const outputLines: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    // 追踪 code fence 状态
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      outputLines.push(line);
      continue;
    }

    if (inFence) {
      outputLines.push(line);
      continue;
    }

    // 1. MEDIA:<url> 指令行
    const mediaMatch = MEDIA_LINE_RE.exec(line.trim());
    if (mediaMatch) {
      const url = mediaMatch[1];
      if (isValidMediaSource(url)) {
        mediaUrls.push(url);
      }
      // 无论是否有效都从输出中移除（不泄漏）
      continue;
    }

    // 2. ![alt](url) markdown 图片（弱 fallback，只从独立行提取）
    const imgMatch = IMG_MD_RE.exec(line);
    if (imgMatch && line.trim() === imgMatch[0]) {
      // 整行就是一个图片标记
      if (isValidMediaSource(imgMatch[1])) {
        mediaUrls.push(imgMatch[1]);
      }
      continue;
    }

    outputLines.push(line);
  }

  return {
    text: outputLines.join("\n").trim(),
    mediaUrls,
  };
}

function isValidMediaSource(url: string): boolean {
  // HTTP(S) URL
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    // Extraction is not authorization. Delivery checks the per-session registry.
    if (u.protocol === "file:") return path.isAbsolute(fileUrlToPath(url));
  } catch { /* 不是合法 URL，检查是否为绝对路径 */ }
  // 绝对本地路径
  if (path.isAbsolute(url)) return true;
  return false;
}

// ── 工具函数 ────────────────────────────────────────────

/**
 * Readable stream → Buffer
 */
export async function streamToBuffer(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Array<Buffer | Uint8Array> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
