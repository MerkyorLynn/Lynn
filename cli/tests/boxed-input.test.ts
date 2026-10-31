import { describe, expect, it } from "vitest";
import { renderInputBox, summarizeInputForBox } from "../src/boxed-input.js";
import { visibleLength } from "../src/startup.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function box(opts: Partial<Parameters<typeof renderInputBox>[0]> = {}) {
  return renderInputBox({
    status: "Lynn · Step 5 · ask / workspace-write",
    buffer: "",
    cursor: 0,
    width: 72,
    color: false,
    ...opts,
  });
}

describe("renderInputBox", () => {
  it("draws a complete 4-sided box with the input INSIDE it", () => {
    const r = box({ buffer: "hello world", cursor: 11 });
    const top = stripAnsi(r.top);
    const line = stripAnsi(r.inputLine);
    const bottom = stripAnsi(r.bottom);
    expect(top.startsWith("╭")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
    expect(line.startsWith("│")).toBe(true);
    expect(line.endsWith("│")).toBe(true);
    expect(line).toContain("› hello world");
    expect(bottom.startsWith("╰")).toBe(true);
    expect(bottom.endsWith("╯")).toBe(true);
  });

  it("keeps all three rows the same display width (右边框对齐)", () => {
    const r = box({ buffer: "用一句话说明无交互模式", cursor: 5 });
    expect(visibleLength(stripAnsi(r.inputLine))).toBe(visibleLength(stripAnsi(r.top)));
    expect(visibleLength(stripAnsi(r.bottom))).toBe(visibleLength(stripAnsi(r.top)));
  });

  it("computes cursorCol after the '│ › ' prefix (4) for ASCII", () => {
    expect(box({ buffer: "", cursor: 0 }).cursorCol).toBe(4);
    expect(box({ buffer: "abcdef", cursor: 6 }).cursorCol).toBe(10); // 4 + 6
    expect(box({ buffer: "abcdef", cursor: 2 }).cursorCol).toBe(6); // 4 + 2
  });

  it("accounts for CJK double-width when placing the cursor", () => {
    expect(box({ buffer: "你好", cursor: 2 }).cursorCol).toBe(8); // 4 + 2*2
    expect(box({ buffer: "你好世界", cursor: 1 }).cursorCol).toBe(6); // 4 + 1*2
  });

  it("shows a dim placeholder only when empty, cursor at start", () => {
    const r = box({ buffer: "", cursor: 0, color: true, placeholder: "问我任何事" });
    expect(stripAnsi(r.inputLine)).toContain("问我任何事");
    expect(r.inputLine).toContain("\x1b[2m");
    expect(r.cursorCol).toBe(4);
    expect(stripAnsi(box({ buffer: "x", cursor: 1, placeholder: "问我任何事" }).inputLine)).not.toContain("问我任何事");
  });

  it("horizontally scrolls long input without overflowing the right border", () => {
    const r = box({ buffer: "x".repeat(200), cursor: 200, width: 40 });
    expect(visibleLength(stripAnsi(r.inputLine))).toBe(visibleLength(stripAnsi(r.top))); // 不溢出
    expect(r.cursorCol).toBeLessThan(40); // 光标贴右但在框内
    expect(r.cursorCol).toBeGreaterThan(4);
  });

  it("degrades to plain box-drawing chars without color", () => {
    const r = box({ buffer: "hi", cursor: 2, color: false });
    expect(r.top + r.inputLine + r.bottom).not.toContain("\x1b[");
  });

  it("colors the chevron bright-cyan and borders dim when enabled", () => {
    const r = box({ buffer: "hi", cursor: 2, color: true });
    expect(r.inputLine).toContain("\x1b[1;36m");
    expect(r.top).toContain("\x1b[2m");
  });

  it("uses amber borders and chevron in YOLO mode", () => {
    const r = box({ buffer: "hi", cursor: 2, color: true, danger: true });

    expect(r.top).toContain("\x1b[38;5;208m");
    expect(r.inputLine).toContain("\x1b[38;5;208m");
    expect(r.bottom).toContain("\x1b[38;5;208m");
  });

  it("collapses pasted long and multiline text into a stable paste block", () => {
    const pasted = "第一段很长很长\n第二段继续补充\n第三段结论";
    const summary = summarizeInputForBox(pasted);
    expect(summary).toContain("粘贴块");
    expect(summary).toContain("3 行");
    const r = box({ buffer: pasted, cursor: Array.from(pasted).length, width: 72 });
    const line = stripAnsi(r.inputLine);
    expect(line).toContain("↪ 粘贴块");
    expect(line).not.toContain("第二段继续补充");
    expect(visibleLength(line)).toBe(visibleLength(stripAnsi(r.top)));
  });

  it("shows slash command recommendations inside the frame", () => {
    const r = box({ buffer: "/", cursor: 1, completions: ["/yolo", "/ask", "/model", "/mode", "/think", "/fast", "/exit", "/quit", "/tool", "/tools"], width: 82 });

    expect(r.rowsBelowInput).toBeGreaterThan(2);
    const palette = stripAnsi(r.paletteLines.join("\n"));
    expect(palette).toContain("› /yolo");
    expect(palette).toContain("/ask");
    expect(palette).toContain("/model");
    expect(palette).toContain("静默工厂");
    expect(palette).toContain("↑↓ 选择 · Tab/Enter 确认");
    expect(palette).not.toContain("/quit");
    expect(palette).not.toContain("/tool  ");
    for (const line of r.paletteLines) expect(visibleLength(stripAnsi(line))).toBe(visibleLength(stripAnsi(r.top)));
  });

  it("shows an unknown slash guard without disturbing normal input height", () => {
    const r = box({ buffer: "/nope", cursor: 5, completions: ["/help", "/model"], width: 72 });
    const normal = box({ buffer: "hello", cursor: 5, completions: ["/help", "/model"], width: 72 });

    expect(r.rowsBelowInput).toBe(2);
    expect(stripAnsi(r.paletteLines[0] || "")).toContain("未知命令");
    expect(normal.paletteLines).toEqual([]);
    expect(normal.rowsBelowInput).toBe(1);
  });

  it("scrolls the palette to keep the selected command visible without color", () => {
    const completions = ["/ask", "/model", "/mode", "/think", "/fast", "/help", "/tools", "/exit"];
    const r = box({ buffer: "/", cursor: 1, completions, selected: 7 });
    const palette = stripAnsi(r.paletteLines.join("\n"));
    expect(palette).toContain("› /exit");
    expect(palette).toContain("3. /mode");
    expect(palette).not.toContain("/ask");
    expect(palette).not.toContain("/model");
    for (const line of r.paletteLines) expect(visibleLength(line)).toBe(visibleLength(r.top));
  });

  it("keeps navigation instructions within a narrow terminal", () => {
    const r = box({ buffer: "/", cursor: 1, completions: ["/help"], width: 28 });
    for (const line of r.paletteLines) expect(visibleLength(line)).toBe(visibleLength(r.top));
  });

  it("shows an explicit Tab completion hint for unique slash prefixes", () => {
    const r = box({ buffer: "/he", cursor: 3, completions: ["/help", "/model"], width: 72 });
    const line = stripAnsi(r.inputLine);

    expect(line).toContain("/help");
    expect(line).toContain("Tab 补全");
  });
});
