import path from "node:path";

const IMAGE_PATH_RE = /(?:file:\/\/)?(?:"([^"]+\.(?:png|jpe?g|webp|gif))"|'([^']+\.(?:png|jpe?g|webp|gif))'|(\S+\.(?:png|jpe?g|webp|gif)))/gi;

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
  const parts: string[] = [];
  if (info.imageRefs.length) {
    const names = info.imageRefs.map((ref) => path.basename(ref.path)).slice(0, 3);
    const more = info.imageRefs.length > 3 ? ` +${info.imageRefs.length - 3}` : "";
    parts.push(`${info.imageRefs.length} image${info.imageRefs.length === 1 ? "" : "s"} (${names.join(", ")}${more})`);
  }
  if (info.hasMultilineText) {
    parts.push(`${info.lineCount} lines`);
    if (info.segmentCount > 1) parts.push(`${info.segmentCount} segments`);
  }
  if (!parts.length && info.charCount > 0) parts.push(`${info.charCount} chars`);
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
