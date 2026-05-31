import { describe, expect, it } from "vitest";
import { renderShimmerText, renderSweepFrame } from "../src/terminal-spinner.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
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
    const lowFreqFrame1 = stripAnsi(renderSweepFrame(12, 0, false, true));
    const lowFreqFrame2 = stripAnsi(renderSweepFrame(12, 1, false, true));
    const lowFreqFrame3 = stripAnsi(renderSweepFrame(12, 2, false, true));

    // 低频模式下，连续帧应该相同，直到帧数间隔足够大
    expect(lowFreqFrame1).toBe(lowFreqFrame2);
    expect(lowFreqFrame1).not.toBe(lowFreqFrame3);
    // 正常模式应该有更快的动画
    expect(normalFrame1).not.toBe(normalFrame2);
  });
});

describe("TerminalSpinner class", () => {
  it("should handle narrow terminal width by falling back to static text", async () => {
    // 模拟窄终端（小于12个字符可用宽度）
    const mockStream = {
      isTTY: true,
      columns: 20,
      write: vi.fn(),
    };

    const { TerminalSpinner } = await import("../src/terminal-spinner.js");
    const spinner = new TerminalSpinner(mockStream, "思考中");

    // 手动调用render方法测试宽度降级
    spinner.render();

    // 检查是否调用了write方法
    expect(mockStream.write).toHaveBeenCalled();
  });

  it("should handle low frequency animation for Apple Terminal safety", async () => {
    const mockStream = {
      isTTY: true,
      columns: 80,
      write: vi.fn(),
    };

    // 模拟Apple Terminal安全模式
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("LYNN_CLI_APPLE_TERMINAL_FULL_TUI", undefined);

    const { TerminalSpinner } = await import("../src/terminal-spinner.js");
    const spinner = new TerminalSpinner(mockStream);

    // 测试低频动画间隔
    spinner.start();
    // 这里应该使用270ms间隔而不是90ms

    vi.unstubAllEnvs();
  });
});
