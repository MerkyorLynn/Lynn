/**
 * markdown.ts — minimal, dependency-free terminal markdown for model output.
 *
 * Renders headings, bullet / numbered lists, blockquotes, fenced code blocks, and
 * inline `code` / **bold**. It formats COMPLETE lines, so the same logic serves
 * both a finished answer (`renderMarkdown`) and a live token stream
 * (`MarkdownStream`, which buffers until a newline and holds the trailing partial
 * line). With `color === false` (NO_COLOR / non-TTY) the output is plain text but
 * markdown markers are still cleaned up (e.g. `# Title` -> `Title`, `- x` -> `• x`).
 */
import { bold, cyan, dim } from "./terminal-style.js";

const BULLET = "•";

/** Inline spans on a complete line: `code` -> cyan, **bold** -> bold. */
export function formatInline(text: string, color: boolean): string {
  if (!color) return text;
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => cyan(code, true))
    .replace(/\*\*([^*]+)\*\*/g, (_m, strong: string) => bold(strong, true));
}

/** Format one NON-fenced markdown line (block-level marker + inline spans). */
export function formatMarkdownLine(line: string, color: boolean): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return bold(heading[1].replace(/\*\*/g, ""), color);

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}${color ? cyan(BULLET, true) : BULLET} ${formatInline(bullet[2], color)}`;

  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1]}${numbered[2]}. ${formatInline(numbered[3], color)}`;

  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return dim(`▏ ${quote[1]}`, color);

  return formatInline(line, color);
}

/**
 * Streaming markdown renderer. Feed it raw deltas via `push`; it writes formatted
 * COMPLETE lines to the sink and holds the trailing partial line until the next
 * newline. Call `end()` once the stream finishes to flush the remainder.
 */
export class MarkdownStream {
  private buffer = "";
  private inFence = false;

  constructor(
    private readonly sink: (text: string) => void,
    private readonly color: boolean,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.sink(`${this.renderLine(line)}\n`);
      nl = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.buffer.length > 0) {
      this.sink(this.renderLine(this.buffer));
      this.buffer = "";
    }
  }

  private renderLine(line: string): string {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      this.inFence = !this.inFence;
      if (this.inFence) {
        const lang = fence[1].trim();
        return dim(lang ? `┌─ ${lang}` : "┌─", this.color);
      }
      return dim("└─", this.color);
    }
    if (this.inFence) return this.color ? cyan(line, true) : line;
    return formatMarkdownLine(line, this.color);
  }
}

/** Render a complete markdown string to ANSI (non-streaming). */
export function renderMarkdown(text: string, color: boolean): string {
  const parts: string[] = [];
  const stream = new MarkdownStream((chunk) => parts.push(chunk), color);
  stream.push(text);
  stream.end();
  return parts.join("");
}
