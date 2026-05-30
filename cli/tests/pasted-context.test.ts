import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { setLang } from "../src/i18n.js";
import {
  analyzePastedContext,
  appendPastedText,
  normalizePastedText,
  parseImagePromptCommand,
  summarizeImageRefs,
  summarizePastedContext,
} from "../src/pasted-context.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("pasted context helpers", () => {
  it("normalizes CRLF and appends pasted blocks without losing lines", () => {
    expect(normalizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(appendPastedText("prefix", "line1\nline2")).toBe("prefix\nline1\nline2");
  });

  it("extracts image paths and keeps surrounding prompt text", () => {
    const info = analyzePastedContext('请看 "./screens/a.png"\n以及 /tmp/b.webp', "/repo");

    expect(info.text).toBe("请看\n以及");
    expect(info.imageRefs.map((ref) => ref.path)).toEqual([
      "/repo/screens/a.png",
      "/tmp/b.webp",
    ]);
    expect(summarizePastedContext(info)).toContain("2 attachments");
    expect(summarizePastedContext(info)).toContain("a.png");
    expect(summarizePastedContext(info)).toContain("b.webp");
    expect(summarizePastedContext(info)).toContain("2 lines");
  });

  it("summarizes multi-line text as context", () => {
    const info = analyzePastedContext("第一段\n第二行\n\n第二段");

    expect(info.hasContext).toBe(true);
    expect(info.lineCount).toBe(3);
    expect(info.segmentCount).toBe(2);
    expect(summarizePastedContext(info)).toBe("3 lines · 2 segments");
  });

  it("parses explicit image slash commands with prompt text", () => {
    const command = parseImagePromptCommand('/image "./screen shot.png" explain this', "/repo");

    expect(command).toMatchObject({
      command: "/image",
      prompt: "explain this",
    });
    expect(command?.imageRefs.map((ref) => ref.path)).toEqual(["/repo/screen shot.png"]);
    expect(summarizeImageRefs(command?.imageRefs || [])).toBe("1 attachment: screen shot.png");
  });

  it("uses a default prompt for image commands without text", () => {
    const command = parseImagePromptCommand("/attach /tmp/a.png");

    expect(command?.prompt).toBe("Please analyze these images.");
    expect(command?.imageRefs.map((ref) => ref.path)).toEqual(["/tmp/a.png"]);
  });

  it("summarizes pasted context in Chinese when the CLI language is zh", () => {
    setLang("zh");
    const info = analyzePastedContext("第一段\n第二行\n/tmp/a.png");

    expect(summarizePastedContext(info)).toBe("1 个附件: a.png · 2 行");
  });
});
