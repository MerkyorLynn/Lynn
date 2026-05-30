import fs from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "video_url"; video_url: { url: string } };

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".wmv", ".webm", ".mkv"]);

export type MediaKind = "image" | "audio" | "video";

export function mediaKindFor(filePath: string): MediaKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

export function parseImageList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function buildImagesContentParts(mediaPaths: readonly string[], text: string): Promise<ChatContentPart[]> {
  if (!mediaPaths.length) return [{ type: "text", text }];
  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const mediaPath of mediaPaths) {
    parts.push(await buildSingleMediaPart(mediaPath));
  }
  return parts;
}

async function buildSingleMediaPart(filePath: string): Promise<ChatContentPart> {
  const kind = mediaKindFor(filePath);
  if (kind === "audio") return buildAudioPart(filePath);
  if (kind === "video") return buildVideoPart(filePath);
  return buildSingleImagePart(filePath);
}

async function buildAudioPart(filePath: string): Promise<ChatContentPart> {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`audio is not a file: ${filePath}`);
  if (stat.size > MAX_AUDIO_BYTES) throw new Error(`audio is too large (${Math.ceil(stat.size / 1024 / 1024)}MB > 25MB)`);
  const bytes = await fs.readFile(resolved);
  return { type: "input_audio", input_audio: { data: bytes.toString("base64"), format: audioFormat(resolved) } };
}

async function buildVideoPart(filePath: string): Promise<ChatContentPart> {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`video is not a file: ${filePath}`);
  if (stat.size > MAX_VIDEO_BYTES) throw new Error(`video is too large (${Math.ceil(stat.size / 1024 / 1024)}MB > 100MB)`);
  const bytes = await fs.readFile(resolved);
  return { type: "video_url", video_url: { url: `data:${videoMime(resolved)};base64,${bytes.toString("base64")}` } };
}

function audioFormat(filePath: string): string {
  return path.extname(filePath).toLowerCase().slice(1) || "mp3";
}

function videoMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".avi") return "video/x-msvideo";
  if (ext === ".wmv") return "video/x-ms-wmv";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  return "video/mp4";
}

export async function buildImageContentParts(imagePath: string, text: string): Promise<ChatContentPart[]> {
  return buildImagesContentParts([imagePath], text);
}

async function buildSingleImagePart(imagePath: string): Promise<ChatContentPart> {
  const resolved = path.resolve(imagePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`image is not a file: ${imagePath}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image is too large (${Math.ceil(stat.size / 1024 / 1024)}MB > 20MB)`);
  const mime = inferImageMime(resolved);
  const bytes = await fs.readFile(resolved);
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } };
}

export function inferImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".png") return "image/png";
  throw new Error(`unsupported image type: ${ext || "(none)"}. Use png, jpg, webp, or gif.`);
}
