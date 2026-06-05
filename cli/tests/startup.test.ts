import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { box, displayWidth, renderStartupBanner, visibleLength } from "../src/startup.js";
import { setLang } from "../src/i18n.js";

describe("startup banner", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => setLang(null));

  it("renders model, brain route, and working directory", () => {
    const output = renderStartupBanner({
      cwd: process.env.HOME || "/tmp",
      brainUrl: "http://127.0.0.1:8790",
      brainStatus: "offline",
      modelLabel: "Brain router (auto)",
    });

    expect(output).toContain("Lynn CLI");
    expect(output).toContain("model:");
    expect(output).toContain("Brain router");
    expect(output).toContain("mode:");
    expect(output).toContain("Shift+Tab to toggle");
    expect(output).toContain("BYOK:");
    expect(output).toContain("Lynn providers");
    expect(output).toContain("brain:");
    expect(output).toContain("offline");
    expect(output).toContain("http://127.0.0.1:8790");
    expect(output).toContain("directory:");
    expect(output).toContain("~");
    expect(output).toContain("Lynn help");
  });

  it("keeps the default banner compact for narrow terminals", () => {
    setLang("zh");
    const output = renderStartupBanner({
      brainStatus: "offline",
      modelLabel: "StepFun",
      showTips: false,
    });

    expect(output).toContain("模型:");
    expect(output).toContain("StepFun");
    expect(output).toContain("BYOK:");
    expect(output).toContain("客户端 Providers");
    expect(output).toContain("Lynn providers");
    expect(output).not.toContain("StepFun via local Brain router");
    expect(Math.max(...output.split("\n").map(visibleLength))).toBeLessThanOrEqual(76);
  });

  it("drops optional row hints before wrapping provider labels in narrow TTYs", () => {
    setLang("zh");
    const previousColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 48, configurable: true });
    try {
      const output = renderStartupBanner({
        brainStatus: "offline",
        modelLabel: "CLI BYOK: step-3.7-flash",
        showTips: false,
      });
      expect(output).toContain("CLI BYOK: step-3.7-flash");
      expect(output).not.toContain("│ 切换");
      expect(Math.max(...output.split("\n").map(visibleLength))).toBeLessThanOrEqual(50);
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: previousColumns, configurable: true });
    }
  });

  it("can render a compact banner without tips", () => {
    const output = renderStartupBanner({
      brainStatus: "offline",
      showTips: false,
    });

    expect(output).toContain("Lynn CLI");
    expect(output).toContain("brain:");
    expect(output).not.toContain("Tip:");
  });

  it("caps box width and wraps a long line instead of blowing out the frame", () => {
    const longByok =
      "Install/open Lynn client GUI > Settings > Providers for default route, or run Lynn providers set for CLI-only BYOK";
    const rendered = box(["Lynn CLI", "", `BYOK: ${longByok}`]);
    const widest = Math.max(
      ...rendered.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length),
    );
    expect(widest).toBeLessThanOrEqual(76);
  });

  it("measures CJK characters as double-width for aligned boxes", () => {
    expect(visibleLength("模型")).toBe(4);
    expect(visibleLength("\u001b[31m模型\u001b[0m")).toBe(4);
    expect(displayWidth("模型:abc")).toBe(8);
    const rendered = box(["模型: StepFun", "目录: ~/项目"]);
    const body = rendered.split("\n").slice(1, -1);
    expect(body.every((line) => visibleLength(line) === visibleLength(body[0]))).toBe(true);
  });
});
