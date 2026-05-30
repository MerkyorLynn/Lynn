/**
 * terminal-image.ts — inline image thumbnails via the iTerm2 / kitty graphics
 * protocols. Pure escape-sequence generation + capability detection (testable);
 * the actual file read is best-effort. Only fires on terminals that support a
 * protocol — everywhere else the caller keeps the filename chip fallback.
 *
 * Inline images do not fit Ink's redrawing text layout, so the escape must be
 * emitted from an Ink <Static> region (written once, never re-measured).
 */
import fs from "node:fs/promises";

export type ImageProtocol = "iterm2" | "kitty";

export function detectImageProtocol(env: NodeJS.ProcessEnv = process.env): ImageProtocol | null {
  if (env.LYNN_CLI_NO_INLINE_IMAGES === "1") return null;
  if (env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm2";
  if (env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "ghostty") return "kitty";
  return null;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ST = `${ESC}\\`;

/** iTerm2 inline image (single OSC 1337 sequence), bounded to `widthCells` columns. */
export function iterm2ImageEscape(base64: string, opts: { widthCells?: number; heightCells?: number; name?: string } = {}): string {
  const byteSize = Math.ceil((base64.length * 3) / 4);
  const args = [
    "inline=1",
    "preserveAspectRatio=1",
    `width=${opts.widthCells && opts.widthCells > 0 ? opts.widthCells : "auto"}`,
    opts.heightCells && opts.heightCells > 0 ? `height=${opts.heightCells}` : null,
    `size=${byteSize}`,
    opts.name ? `name=${Buffer.from(opts.name).toString("base64")}` : null,
  ].filter(Boolean).join(";");
  return `${ESC}]1337;File=${args}:${base64}${BEL}`;
}

/** kitty graphics protocol (transmit + display PNG/auto), chunked at 4096 base64 chars. */
export function kittyImageEscape(base64: string, opts: { widthCells?: number; heightCells?: number } = {}): string {
  const chunkSize = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += chunkSize) chunks.push(base64.slice(i, i + chunkSize));
  if (!chunks.length) chunks.push("");
  const cols = opts.widthCells && opts.widthCells > 0 ? `,c=${opts.widthCells}` : "";
  const rows = opts.heightCells && opts.heightCells > 0 ? `,r=${opts.heightCells}` : "";
  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const control = index === 0 ? `a=T,f=100${cols}${rows},m=${more}` : `m=${more}`;
      return `${ESC}_G${control};${chunk}${ST}`;
    })
    .join("");
}

/** Read an image file and return the inline escape for `protocol`, or null on failure. */
export async function renderImageThumbnail(
  imagePath: string,
  protocol: ImageProtocol,
  opts: { widthCells?: number; heightCells?: number; maxBytes?: number } = {},
): Promise<string | null> {
  try {
    const bytes = await fs.readFile(imagePath);
    if (opts.maxBytes && bytes.length > opts.maxBytes) return null;
    const base64 = bytes.toString("base64");
    const widthCells = opts.widthCells ?? 28;
    const heightCells = opts.heightCells ?? 8;
    return protocol === "iterm2"
      ? iterm2ImageEscape(base64, { widthCells, heightCells, name: imagePath })
      : kittyImageEscape(base64, { widthCells, heightCells });
  } catch {
    return null;
  }
}
