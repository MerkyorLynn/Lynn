import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { box, renderStartupBanner } from "../src/startup.js";
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
    expect(output).toContain("lynn help");
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
});
