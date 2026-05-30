import path from "node:path";
import { currentLang, t, type Lang } from "./i18n.js";

const MEDIA_EXT = "png|jpe?g|webp|gif|mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|wmv|webm|mkv";
const IMAGE_PATH_RE = new RegExp(`(?:file://)?(?:"([^"]+\\.(?:${MEDIA_EXT}))"|'([^']+\\.(?:${MEDIA_EXT}))'|(\\S+\\.(?:${MEDIA_EXT})))`, "gi");

export interface PastedImageRef {
  raw: string;
  path: string;
}

export interface PastedContextInfo {
  text: string;
  imageRefs: PastedImageRef[];
  lineCount: number;
  segmentCount: number;
  charCount: number;
  hasMultilineText: boolean;
  hasContext: boolean;
}

export interface ImagePromptCommand {
  command: "/image" | "/images" | "/attach";
  prompt: string;
  imageRefs: PastedImageRef[];
}

export function normalizePastedText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function appendPastedText(current: string, pasted: string): string {
  const next = normalizePastedText(pasted);
  if (!current) return next;
  if (current.endsWith("\n") || next.startsWith("\n")) return `${current}${next}`;
  return `${current}\n${next}`;
}

export function analyzePastedContext(value: string, cwd = process.cwd()): PastedContextInfo {
  const normalized = normalizePastedText(value);
  const imageRefs: PastedImageRef[] = [];
  let text = normalized.replace(IMAGE_PATH_RE, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const raw = doubleQuoted || singleQuoted || bare || match;
    const cleaned = cleanImagePath(raw);
    imageRefs.push({ raw, path: path.resolve(cwd, cleaned) });
    return " ";
  });
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const nonEmptyLines = text ? text.split(/\n/).filter((line) => line.trim()).length : 0;
  const segmentCount = text ? text.split(/\n{2,}/).filter((segment) => segment.trim()).length : 0;
  return {
    text,
    imageRefs,
    lineCount: nonEmptyLines,
    segmentCount,
    charCount: Array.from(text).length,
    hasMultilineText: nonEmptyLines > 1 || segmentCount > 1,
    hasContext: imageRefs.length > 0 || nonEmptyLines > 1 || segmentCount > 1,
  };
}

export function summarizePastedContext(info: PastedContextInfo): string {
  return summarizeContextParts({
    imageCount: info.imageRefs.length,
    imageNames: info.imageRefs.map((ref) => path.basename(ref.path)),
    hasMultilineText: info.hasMultilineText,
    lineCount: info.lineCount,
    segmentCount: info.segmentCount,
    charCount: info.charCount,
    lang: currentLang(),
  });
}

export function summarizeImageRefs(imageRefs: readonly PastedImageRef[], lang: Lang = currentLang()): string {
  return summarizeContextParts({
    imageCount: imageRefs.length,
    imageNames: imageRefs.map((ref) => path.basename(ref.path)),
    hasMultilineText: false,
    lineCount: 0,
    segmentCount: 0,
    charCount: 0,
    lang,
  });
}

export function parseImagePromptCommand(value: string, cwd = process.cwd()): ImagePromptCommand | null {
  const normalized = normalizePastedText(value).trim();
  const match = normalized.match(/^\/(image|images|attach)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = `/${match[1].toLowerCase()}` as ImagePromptCommand["command"];
  const info = analyzePastedContext(match[2] || "", cwd);
  return {
    command,
    prompt: info.text || t("chat.image.defaultPrompt"),
    imageRefs: info.imageRefs,
  };
}

function summarizeContextParts(options: {
  imageCount: number;
  imageNames: readonly string[];
  hasMultilineText: boolean;
  lineCount: number;
  segmentCount: number;
  charCount: number;
  lang: Lang;
}): string {
  const parts: string[] = [];
  if (options.imageCount) {
    const label = options.lang === "zh"
      ? `${options.imageCount} 个附件`
      : `${options.imageCount} attachment${options.imageCount === 1 ? "" : "s"}`;
    const names = options.imageNames.slice(0, 3).join(", ");
    const extra = options.imageNames.length > 3
      ? (options.lang === "zh" ? ` 等 ${options.imageNames.length} 个文件` : ` +${options.imageNames.length - 3}`)
      : "";
    parts.push(names ? `${label}: ${names}${extra}` : label);
  }
  if (options.hasMultilineText) {
    parts.push(options.lang === "zh" ? `${options.lineCount} 行` : `${options.lineCount} lines`);
    if (options.segmentCount > 1) {
      parts.push(options.lang === "zh" ? `${options.segmentCount} 段` : `${options.segmentCount} segments`);
    }
  }
  if (!parts.length && options.charCount > 0) {
    parts.push(options.lang === "zh" ? `${options.charCount} 字符` : `${options.charCount} chars`);
  }
  return parts.join(" · ");
}

function cleanImagePath(value: string): string {
  const withoutFileScheme = value.startsWith("file://") ? value.slice("file://".length) : value;
  try {
    return decodeURIComponent(withoutFileScheme).replace(/\\ /g, " ");
  } catch {
    return withoutFileScheme.replace(/\\ /g, " ");
  }
}
