import { describe, expect, it } from "vitest";
import { MarkdownStream, formatInline, formatMarkdownLine, renderMarkdown } from "../src/markdown.js";

describe("formatInline", () => {
  it("colors inline code and bold when color is on", () => {
    expect(formatInline("see `x` and **y**", true)).toBe("see \x1b[36mx\x1b[0m and \x1b[1my\x1b[0m");
  });
  it("is identity when color is off", () => {
    expect(formatInline("see `x` and **y**", false)).toBe("see `x` and **y**");
  });
});

describe("formatMarkdownLine (color off — structure only)", () => {
  it("strips heading markers", () => {
    expect(formatMarkdownLine("## Title", false)).toBe("Title");
  });
  it("turns list markers into bullets", () => {
    expect(formatMarkdownLine("- item", false)).toBe("• item");
    expect(formatMarkdownLine("  * nested", false)).toBe("  • nested");
  });
  it("keeps numbered lists and quotes", () => {
    expect(formatMarkdownLine("3. third", false)).toBe("3. third");
    expect(formatMarkdownLine("> quoted", false)).toBe("▏ quoted");
  });
});

describe("MarkdownStream", () => {
  it("emits complete lines and holds the trailing partial until end()", () => {
    const out: string[] = [];
    const md = new MarkdownStream((s) => out.push(s), false);
    md.push("# Title\nsome ");
    expect(out.join("")).toBe("Title\n"); // partial "some " is held
    md.push("text");
    md.end();
    expect(out.join("")).toBe("Title\nsome text");
  });

  it("renders fenced code blocks with markers and raw code lines", () => {
    const out: string[] = [];
    const md = new MarkdownStream((s) => out.push(s), false);
    md.push("```js\nconst x = 1;\n```\n");
    md.end();
    expect(out.join("")).toBe("┌─ js\nconst x = 1;\n└─\n");
  });
});

describe("renderMarkdown", () => {
  it("renders a complete block, preserving trailing newline state", () => {
    expect(renderMarkdown("- a\n- b", false)).toBe("• a\n• b");
    expect(renderMarkdown("line\n", false)).toBe("line\n");
  });
});
