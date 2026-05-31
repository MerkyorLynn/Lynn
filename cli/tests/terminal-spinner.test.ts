import { describe, expect, it, vi } from "vitest";
import {
  renderShimmerText,
  renderSweepFrame,
  renderSoftShimmer,
  renderQuietShimmer,
  brailleGlyph,
  renderCard,
  renderPlanCard,
  TerminalSpinner,
} from "../src/terminal-spinner.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function mockStream(columns: number, isTTY = true) {
  return { isTTY, columns, write: vi.fn() } as unknown as NodeJS.WriteStream;
}

function calls(stream: NodeJS.WriteStream): unknown[][] {
  return (stream.write as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe("terminal spinner sweep", () => {
  it("renders a fixed-width left-to-right sweep frame", () => {
    const first = stripAnsi(renderSweepFrame(12, 0, false));
    const later = stripAnsi(renderSweepFrame(12, 6, false));
    expect(first).toHaveLength(12);
    expect(later).toHaveLength(12);
    expect(first).not.toBe(later);
    expect(later).toContain("━");
  });

  it("can render colored bright head/trail for TTY output", () => {
    const frame = renderSweepFrame(12, 6, true);
    expect(frame).toContain("\x1b[1;36m━\x1b[0m");
    expect(frame).toContain("\x1b[36m━\x1b[0m");
    expect(frame).toContain("\x1b[2m─\x1b[0m");
  });

  it("renders a shimmer over the thinking label without changing plain text", () => {
    expect(renderShimmerText("Lynn 思考中", 2, false)).toBe("Lynn 思考中");
    const colored = renderShimmerText("Lynn", 1, true);
    expect(stripAnsi(colored)).toBe("Lynn");
    expect(colored).toContain("\x1b[1;36m");
    expect(colored).toContain("\x1b[36m");
  });

  it("supports low frequency mode for Apple Terminal safety", () => {
    const normalFrame1 = stripAnsi(renderSweepFrame(12, 0, false));
    const normalFrame2 = stripAnsi(renderSweepFrame(12, 1, false));
    // 低频 frame/3:frame 0/1/2 是同一低频帧,frame 3 才前进
    const lowFreq0 = stripAnsi(renderSweepFrame(12, 0, false, true));
    const lowFreq2 = stripAnsi(renderSweepFrame(12, 2, false, true));
    const lowFreq3 = stripAnsi(renderSweepFrame(12, 3, false, true));
    expect(lowFreq0).toBe(lowFreq2);
    expect(lowFreq0).not.toBe(lowFreq3);
    expect(normalFrame1).not.toBe(normalFrame2);
  });
});

describe("low-noise shimmer (流光扫描低噪音版)", () => {
  it("renderSoftShimmer keeps plain text intact and uses a dim base + single highlight", () => {
    expect(renderSoftShimmer("思考中", 1, false)).toBe("思考中"); // 无色 → 原样
    const colored = renderSoftShimmer("Lynn", 0, true);
    expect(stripAnsi(colored)).toBe("Lynn");
    expect(colored).toContain("\x1b[2m"); // dim 基底(低噪音)
    expect(colored).toContain("\x1b[1;36m"); // 仅一个移动高光
  });

  it("brailleGlyph cycles a single low-noise spinner glyph", () => {
    const frames = Array.from({ length: 10 }, (_, f) => brailleGlyph(f));
    expect(new Set(frames).size).toBeGreaterThan(1); // 会动
    expect(brailleGlyph(0)).toBe(brailleGlyph(10)); // 循环
    expect(Array.from(brailleGlyph(3)).length).toBe(1); // 单字符
  });

  it("renderQuietShimmer = glyph + soft label, with no full-width sweep bar", () => {
    const out = stripAnsi(renderQuietShimmer("Thinking", 2, true));
    expect(out).toContain("Thinking");
    expect(out).not.toContain("━"); // 低噪音:无满宽扫描条
    expect(out).not.toContain("─");
  });
});

describe("colored cards (统一彩色卡片)", () => {
  it("draws a colored left gutter, glyph, bold title and dim body", () => {
    const card = renderCard({ kind: "tool", title: "web_search · done", body: ["3 results"] }, true);
    const plain = stripAnsi(card);
    expect(plain).toContain("│ 🔧 web_search · done");
    expect(plain).toContain("│   3 results");
    expect(card).toContain("\x1b[36m│\x1b[0m"); // tool → cyan gutter
    // 只有左 gutter:每行至多一个 │(无右边框 → 无滚动残骸)
    for (const lineText of plain.split("\n")) {
      expect((lineText.match(/│/g) || []).length).toBeLessThanOrEqual(1);
    }
  });

  it("colors gutters by kind (ok=green, error=red, plan=yellow)", () => {
    expect(renderCard({ kind: "ok", title: "x" }, true)).toContain("\x1b[32m│\x1b[0m");
    expect(renderCard({ kind: "error", title: "x" }, true)).toContain("\x1b[31m│\x1b[0m");
    expect(renderPlanCard([{ status: "completed", text: "a" }], true)).toContain("\x1b[33m│\x1b[0m");
  });

  it("renderPlanCard renders ✓ / ● / ○ for completed / in_progress / pending", () => {
    const plan = stripAnsi(renderPlanCard([
      { status: "completed", text: "done step" },
      { status: "in_progress", text: "current step" },
      { status: "pending", text: "todo step" },
    ], true));
    expect(plan).toContain("✓ done step");
    expect(plan).toContain("● current step");
    expect(plan).toContain("○ todo step");
  });

  it("degrades to plain text when color is off", () => {
    expect(renderCard({ kind: "error", title: "boom" }, false)).toBe("│ ✗ boom");
  });
});

describe("TerminalSpinner class", () => {
  it("writes an animated frame on render() for a normal-width TTY", () => {
    const stream = mockStream(80);
    new TerminalSpinner(stream, "思考中").render();
    expect(calls(stream)).toHaveLength(1);
    expect(calls(stream)[0][0]).toContain("\r");
  });

  it("falls back to a static label when the available width is too small", () => {
    const stream = mockStream(80);
    const longLabel = "思".repeat(64); // visibleLength 远超可用宽 → 静态降级
    new TerminalSpinner(stream, longLabel).render();
    expect(calls(stream)[0][0]).toBe(`\r${longLabel}`);
  });

  it("quiet mode renders the low-noise line (no sweep bar)", () => {
    const stream = mockStream(80);
    new TerminalSpinner(stream, "Thinking", { quiet: true }).render();
    const written = stripAnsi(calls(stream)[0][0] as string);
    expect(written).toContain("Thinking");
    expect(written).not.toContain("━");
  });

  it("start() animates and stop() clears the line without residue", () => {
    const stream = mockStream(80);
    const spinner = new TerminalSpinner(stream, "x", { quiet: true });
    spinner.start();
    expect(calls(stream).length).toBeGreaterThan(0);
    spinner.stop();
    const last = calls(stream).at(-1)?.[0] as string;
    expect(last.startsWith("\r")).toBe(true);
    expect(last.trim()).toBe(""); // 清场:仅 \r + 空格
  });

  it("no-ops on a non-TTY stream", () => {
    const stream = mockStream(80, false);
    const spinner = new TerminalSpinner(stream);
    spinner.start();
    expect(calls(stream)).toHaveLength(0);
    spinner.stop(); // 安全
  });
});
