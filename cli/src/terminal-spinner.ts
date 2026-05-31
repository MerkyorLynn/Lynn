import { bold, brightCyan, cyan, dim, green, red, supportsColor, yellow } from "./terminal-style.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";
import { terminalTuiProfile } from "./terminal-safety.js";

// ============================================================================
// 流光扫描 + 彩色卡片 — 无 Ink / 无 raw mode / 无全屏的"活跃区动画"参考实现。
//
// 原理(Claude Code 用 Ink 差量重绘,我们没有 Ink 的等价物):
//   · 动画只动「一行」,用 \r 回到行首重画,完成时整行清场 → append-only 不留残骸。
//   · 只在「模型等待/生成」时跑(此刻用户不打字)→ 不碰 stdin、不进 raw mode
//     → 中文输入法安全。这正是去 Ink 后还能要回"流光"的关键。
//   · 低噪音 = 柔和渐变(dim 基底 + 单点柔光) + 单行 + NO_COLOR/非 TTY 自动降级。
//
// 卡片(统一工具卡片 / 计划卡片 / 不同颜色):
//   · 每张卡用「该类型颜色的左 gutter │」贯穿所有行,只用左边框、绝不画右边框/满宽框
//     → 终端 reflow/滚动时不会留下孤立的 `]`(这正是旧 input band 的毛刺来源)。
//
// 直接看效果: 把 runShimmerDemo(process.stdout) 接到任意入口运行即可。
// ============================================================================

// ---------------------------------------------------------------------------
// 帧函数(纯函数,便于测试)
// ---------------------------------------------------------------------------

/** 满宽扫描条:亮 head + cyan 拖尾 + dim 余晖。显眼,属"高噪音"变体。 */
export function renderSweepFrame(width: number, frame: number, color: boolean, lowFrequency = false): string {
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

/** 标签流光:亮 head 扫过文字。比下面的 soft 版更亮(噪音更高)。 */
export function renderShimmerText(text: string, frame: number, color: boolean, lowFrequency = false): string {
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

/**
 * 低噪音柔光:整段 dim 作基底,只有一个 cyan 柔光点扫过(不用满屏 brightCyan)。
 * 视觉上是"暗底上一缕微光流动",安静、不抢注意力 —— 这是推荐的默认流光。
 */
export function renderSoftShimmer(text: string, frame: number, color: boolean, lowFrequency = false): string {
  if (!color) return text;
  const chars = Array.from(text);
  if (!chars.length) return text;
  const effectiveFrame = lowFrequency ? Math.floor(frame / 3) : frame;
  const head = effectiveFrame % (chars.length + 4);
  return chars.map((char, i) => {
    const distance = Math.abs(i - head);
    if (distance === 0) return brightCyan(char, color); // 仅 1 字高光
    if (distance <= 1) return cyan(char, color);
    return dim(char, color); // 其余全 dim → 低噪音
  }).join("");
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 极简旋转点(单字符,最低噪音的"忙碌"指示)。 */
export function brailleGlyph(frame: number, lowFrequency = false): string {
  const effectiveFrame = lowFrequency ? Math.floor(frame / 2) : frame;
  return BRAILLE_FRAMES[((effectiveFrame % BRAILLE_FRAMES.length) + BRAILLE_FRAMES.length) % BRAILLE_FRAMES.length];
}

/**
 * 低噪音单行:`<旋转点> <柔光标签>`,默认不带满宽扫描条。
 * 这是接入 readline 聊天流「思考中」状态的推荐渲染(配合 \r 单行重画)。
 */
export function renderQuietShimmer(label: string, frame: number, color: boolean, lowFrequency = false): string {
  const glyph = color ? cyan(brailleGlyph(frame, lowFrequency), color) : brailleGlyph(frame, lowFrequency);
  return `${glyph} ${renderSoftShimmer(label, frame, color, lowFrequency)}`;
}

// ---------------------------------------------------------------------------
// 统一彩色卡片(参考实现)
// ---------------------------------------------------------------------------

export type CardKind = "tool" | "run" | "ok" | "error" | "plan" | "info";

function cardGutter(kind: CardKind, color: boolean): string {
  const bar = "│";
  switch (kind) {
    case "tool":
    case "run":
      return cyan(bar, color);
    case "ok":
      return green(bar, color);
    case "error":
      return red(bar, color);
    case "plan":
      return yellow(bar, color);
    default:
      return dim(bar, color);
  }
}

function cardGlyph(kind: CardKind): string {
  switch (kind) {
    case "tool":
      return "🔧";
    case "run":
      return "⏳";
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "plan":
      return "◷";
    default:
      return "•";
  }
}

export interface CardInput {
  kind: CardKind;
  title: string;
  /** 可选正文行(自动缩进 + dim)。 */
  body?: string[];
}

/**
 * 渲染一张卡片:同色左 gutter 贯穿,头部 `│ <glyph> <粗体标题>`,正文 `│   <dim 行>`。
 * 只用左边框 → append-only 滚动安全,绝不画右边框/满宽框。
 */
export function renderCard(card: CardInput, color: boolean): string {
  const gutter = cardGutter(card.kind, color);
  const head = `${gutter} ${cardGlyph(card.kind)} ${bold(card.title, color)}`;
  const body = (card.body || []).map((line) => `${gutter}   ${dim(line, color)}`);
  return [head, ...body].join("\n");
}

export interface PlanStep {
  status: "pending" | "in_progress" | "completed";
  text: string;
}

function planGlyph(status: PlanStep["status"], color: boolean): string {
  if (status === "completed") return green("✓", color);
  if (status === "in_progress") return cyan("●", color);
  return dim("○", color);
}

/** 计划卡片:黄色 gutter 的 ✓●○ 清单,让"我在第几步"成为干净的一块。 */
export function renderPlanCard(steps: PlanStep[], color: boolean, title = "Plan"): string {
  const gutter = yellow("│", color);
  const head = `${gutter} ${cardGlyph("plan")} ${bold(title, color)}`;
  const lines = steps.map((step) => {
    const text = step.status === "completed" ? dim(step.text, color) : step.text;
    return `${gutter}   ${planGlyph(step.status, color)} ${text}`;
  });
  return [head, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// 单行动画器(\r 重画,IME 安全,自动降级)
// ---------------------------------------------------------------------------

export interface TerminalSpinnerOptions {
  /** 低噪音模式:旋转点 + 柔光标签,不画满宽扫描条。推荐默认。 */
  quiet?: boolean;
}

export class TerminalSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly label = t("spinner.thinking"),
    private readonly options: TerminalSpinnerOptions = {},
  ) {}

  start(): void {
    if (this.active || !this.stream.isTTY) return;
    this.active = true;
    this.render();
    const profile = terminalTuiProfile();
    // Apple Terminal 安全模式用低频(270ms),否则正常(90ms)。
    const interval = profile.appleTerminal && !profile.animation ? 270 : 90;
    this.timer = setInterval(() => this.render(), interval);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 整行清场:覆盖足够宽度的空格后回行首,绝不留残骸。
    if (this.stream.isTTY) {
      const clearWidth = this.clearWidth();
      this.stream.write(`\r${" ".repeat(Math.max(clearWidth, 80))}\r`);
    }
  }

  /** 渲染当前帧(public 以便测试与按需手动刷新)。 */
  render(): void {
    const profile = terminalTuiProfile();
    const color = supportsColor(this.stream);
    const lowFrequency = profile.appleTerminal && !profile.animation;
    const availableWidth = this.clearWidth() - visibleLength(this.label) - 5;

    // 宽度不足:降级为静态 label(无动画)。
    if (availableWidth < 12) {
      this.stream.write(`\r${this.label}`);
      this.frame += 1;
      return;
    }

    if (this.options.quiet) {
      this.stream.write(`\r${renderQuietShimmer(this.label, this.frame, color, lowFrequency)}`);
    } else {
      const width = Math.min(42, Math.max(18, availableWidth));
      this.stream.write(`\r${renderShimmerText(this.label, this.frame, color, lowFrequency)} ${renderSweepFrame(width, this.frame, color, lowFrequency)}`);
    }
    this.frame += 1;
  }

  private clearWidth(): number {
    return Math.max(80, typeof this.stream.columns === "number" ? this.stream.columns : 0);
  }
}

// ---------------------------------------------------------------------------
// DEMO(给 Codex 学习:逐帧展示流光 + 彩色卡片样张)
// ---------------------------------------------------------------------------

/**
 * 把流光扫描与彩色卡片打印到 stream(同步、无定时器,便于捕获/对比)。
 * 实际运行时流光是「单行 \r 动画」(见 TerminalSpinner),这里把帧拆成多行只为展示。
 */
export function runShimmerDemo(stream: NodeJS.WriteStream = process.stdout): void {
  const color = supportsColor(stream);
  const line = (s = "") => stream.write(`${s}\n`);
  const thinking = t("spinner.thinking");

  line();
  line(bold("  Lynn · 流光扫描 + 彩色卡片 DEMO", color));
  line(dim("  无 Ink / 无 raw mode / 无全屏 — append-only + 单行 \\r 动画,中文输入法安全", color));
  line();

  line(dim("  ① 低噪音流光(推荐默认 · 逐帧展示,实际是单行 \\r 动画):", color));
  for (let frame = 0; frame < 10; frame += 1) {
    line(`  ${renderQuietShimmer(thinking, frame, color)}`);
  }
  line();

  line(dim("  ② 满宽扫描条变体(更显眼 / 噪音更高,默认不建议):", color));
  for (let frame = 0; frame < 6; frame += 1) {
    line(`  ${renderShimmerText("Working", frame, color)} ${renderSweepFrame(28, frame, color)}`);
  }
  line();

  line(dim("  ③ 统一工具卡片(同色左 gutter 贯穿,无右边框 → 无滚动残骸):", color));
  line(renderCard({ kind: "tool", title: "web_search · running", body: ["query: StepFun 3.7 Flash TPS"] }, color));
  line(renderCard({ kind: "ok", title: "web_search · done · 1.2s", body: ["3 results · top: artificialanalysis.ai"] }, color));
  line(renderCard({ kind: "error", title: "bash · failed · exit 1", body: ["npm test: 2 failing"] }, color));
  line(renderCard({ kind: "info", title: "route: StepFun 3.7 Flash", body: ["256K ctx · think auto"] }, color));
  line();

  line(dim("  ④ 计划卡片(✓ 完成 / ● 进行中 / ○ 待办):", color));
  line(renderPlanCard([
    { status: "completed", text: "读取 v0803 渲染层" },
    { status: "completed", text: "定位中文输入法冲突根因" },
    { status: "in_progress", text: "实现低噪音流光扫描" },
    { status: "pending", text: "接入 readline 聊天流「思考中」" },
  ], color));
  line();

  line(dim("  ⑤ 静态 footer(每轮印一次,不重画):", color));
  line(`  ${dim("StepFun 3.7 Flash · ~ · ask / workspace-write · think auto · decode 211 TPS", color)}`);
  line();
}
