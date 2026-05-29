import { cyan, supportsColor } from "./terminal-style.js";
import { t } from "./i18n.js";

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
    const width = Math.min(48, Math.max(24, this.clearWidth() - this.label.length - 5));
    const pos = this.frame % (width + 8);
    const color = supportsColor(this.stream);
    const bar = Array.from({ length: width }, (_, i) => {
      const distance = Math.abs(i - pos);
      if (distance <= 1) return "━";
      if (distance <= 3) return "─";
      return " ";
    }).join("");
    this.stream.write(`\r${this.label} ${cyan(bar, color)}`);
    this.frame += 1;
  }

  private clearWidth(): number {
    return Math.max(80, typeof this.stream.columns === "number" ? this.stream.columns : 0);
  }
}
