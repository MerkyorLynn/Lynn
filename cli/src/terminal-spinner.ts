import { brightCyan, cyan, dim, supportsColor } from "./terminal-style.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";
import { terminalTuiProfile } from "./terminal-safety.js";

export function renderSweepFrame(width: number, frame: number, color: boolean, lowFrequency: boolean = false): string {
  const safeWidth = Math.max(8, width);
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = (effectiveFrame % (safeWidth + 8)) - 4;
  return Array.from({ length: safeWidth }, (_, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return brightCyan("━", color);
    if (distance <= 1) return cyan("━", color);
    if (distance <= 3) return dim("─", color);
    return " ";
  }).join("");
}

export function renderShimmerText(text: string, frame: number, color: boolean, lowFrequency: boolean = false): string {
  if (!color) return text;
  const chars = Array.from(text);
  if (!chars.length) return text;
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = effectiveFrame % (chars.length + 6);
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
    const profile = terminalTuiProfile();
    // Apple Terminal安全模式下使用低频动画（270ms间隔），否则使用正常动画（90ms间隔）
    const interval = profile.appleTerminal && !profile.animation ? 270 : 90;
    this.timer = setInterval(() => this.render(), interval);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 确保完全清除：写入足够的空格覆盖整个行，然后回到行首
    if (this.stream.isTTY) {
      const clearWidth = this.clearWidth();
      this.stream.write(`\r${" ".repeat(Math.max(clearWidth, 80))}\r`);
    }
  }

  private render(): void {
    const profile = terminalTuiProfile();
    const color = supportsColor(this.stream);
    const availableWidth = this.clearWidth() - visibleLength(this.label) - 5;

    // 宽度不足时降级为静态thinking
    if (availableWidth < 12) {
      this.stream.write(`\r${this.label}`);
      return;
    }

    const width = Math.min(42, Math.max(18, availableWidth));
    const lowFrequency = profile.appleTerminal && !profile.animation;

    this.stream.write(`\r${renderShimmerText(this.label, this.frame, color, lowFrequency)} ${renderSweepFrame(width, this.frame, color, lowFrequency)}`);
    this.frame += 1;
  }

  private clearWidth(): number {
    return Math.max(80, typeof this.stream.columns === "number" ? this.stream.columns : 0);
  }
}
