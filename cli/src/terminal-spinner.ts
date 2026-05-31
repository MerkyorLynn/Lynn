import { brightCyan, cyan, dim, supportsColor } from "./terminal-style.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";
import { terminalTuiProfile } from "./terminal-safety.js";

export function renderSweepFrame(width: number, frame: number, color: boolean): string {
  const safeWidth = Math.max(8, width);
  const head = (frame % (safeWidth + 8)) - 4;
  return Array.from({ length: safeWidth }, (_, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return brightCyan("━", color);
    if (distance <= 1) return cyan("━", color);
    if (distance <= 3) return dim("─", color);
    return " ";
  }).join("");
}

export function renderShimmerText(text: string, frame: number, color: boolean): string {
  if (!color) return text;
  const chars = Array.from(text);
  if (!chars.length) return text;
  const head = frame % (chars.length + 6);
  return chars.map((char, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return brightCyan(char, color);
    if (distance <= 1) return cyan(char, color);
    if (distance <= 3) return dim(char, color);
    return char;
  }).join("");
}

export class TerminalSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly label = t("spinner.thinking"),
  ) {}

  start(): void {
    if (this.active || !this.stream.isTTY) return;
    this.active = true;
    this.render();
    if (!terminalTuiProfile().animation) return;
    this.timer = setInterval(() => this.render(), 90);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream.isTTY) this.stream.write(`\r${" ".repeat(this.clearWidth())}\r`);
  }

  private render(): void {
    const width = Math.min(42, Math.max(18, this.clearWidth() - visibleLength(this.label) - 5));
    const color = supportsColor(this.stream);
    this.stream.write(`\r${renderShimmerText(this.label, this.frame, color)} ${renderSweepFrame(width, this.frame, color)}`);
    this.frame += 1;
  }

  private clearWidth(): number {
    return Math.max(80, typeof this.stream.columns === "number" ? this.stream.columns : 0);
  }
}
