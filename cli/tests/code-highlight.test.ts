import { describe, expect, it } from "vitest";
import { highlightCodeLine } from "../src/code-highlight.js";

const colorOf = (segs: { text: string; color?: string }[], text: string) =>
  segs.find((s) => s.text === text)?.color;
const rejoin = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("highlightCodeLine", () => {
  it("colors keywords, strings, and numbers and stays lossless", () => {
    const line = 'const x = "hi" + 42;';
    const segs = highlightCodeLine(line, "ts");
    expect(colorOf(segs, "const")).toBe("magenta");
    expect(colorOf(segs, '"hi"')).toBe("green");
    expect(colorOf(segs, "42")).toBe("yellow");
    expect(rejoin(segs)).toBe(line);
  });

  it("uses // for C-like langs and # for Python; # is not a comment in JS", () => {
    expect(highlightCodeLine("x = 1 // note", "js").find((s) => s.text.includes("note"))?.color).toBe("gray");
    expect(highlightCodeLine("x = 1 # note", "python").find((s) => s.text.includes("note"))?.color).toBe("gray");
    expect(highlightCodeLine("a # b", "js").find((s) => s.text.includes("# b"))?.color).toBeUndefined();
  });

  it("does not treat // inside a string as a comment", () => {
    const segs = highlightCodeLine('u = "http://x"', "js");
    expect(colorOf(segs, '"http://x"')).toBe("green");
    expect(segs.some((s) => s.color === "gray")).toBe(false);
  });

  it("colors booleans / null as literals", () => {
    expect(colorOf(highlightCodeLine("ok = true", "py"), "true")).toBe("yellow");
    expect(colorOf(highlightCodeLine("v := nil", "go"), "nil")).toBe("yellow");
  });

  it("is lossless on a full Python line with a trailing comment", () => {
    const line = "def foo(a, b): return a + b  # sum";
    const segs = highlightCodeLine(line, "python");
    expect(rejoin(segs)).toBe(line);
    expect(colorOf(segs, "def")).toBe("magenta");
  });
});
