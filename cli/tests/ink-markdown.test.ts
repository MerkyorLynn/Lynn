import { describe, expect, it } from "vitest";
import { classifyDiffLine, parseInkInline, parseInkMarkdown } from "../src/ink-markdown.js";

describe("parseInkMarkdown", () => {
  it("parses markdown blocks used by the Ink chat and code shells", () => {
    expect(parseInkMarkdown([
      "# Title",
      "- use `read_file`",
      "1. run **tests**",
      "> note",
      "```diff",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "```",
    ].join("\n"))).toEqual([
      { kind: "heading", text: "Title" },
      { kind: "bullet", indent: "", text: "use `read_file`" },
      { kind: "numbered", indent: "", number: "1", text: "run **tests**" },
      { kind: "quote", text: "note" },
      { kind: "fence", open: true, lang: "diff" },
      { kind: "code", text: "@@ -1 +1 @@", lang: "diff" },
      { kind: "code", text: "-old", lang: "diff" },
      { kind: "code", text: "+new", lang: "diff" },
      { kind: "fence", open: false, lang: undefined },
    ]);
  });
});

describe("parseInkInline", () => {
  it("extracts inline code and strong spans without losing plain text", () => {
    expect(parseInkInline("read `a.ts` then **test**")).toEqual([
      { kind: "text", text: "read " },
      { kind: "code", text: "a.ts" },
      { kind: "text", text: " then " },
      { kind: "bold", text: "test" },
    ]);
  });

  it("extracts italic, strikethrough, and links", () => {
    expect(parseInkInline("see *here*, ~~old~~, [docs](https://x.io)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "italic", text: "here" },
      { kind: "text", text: ", " },
      { kind: "strike", text: "old" },
      { kind: "text", text: ", " },
      { kind: "link", text: "docs", url: "https://x.io" },
    ]);
  });

  it("tags fenced code lines with their language for highlighting", () => {
    const parsed = parseInkMarkdown("```ts\nconst x = 1;\n```");
    expect(parsed[1]).toEqual({ kind: "code", text: "const x = 1;", lang: "ts" });
  });

  it("groups a pipe table into a single table block", () => {
    expect(parseInkMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      { kind: "table", rows: [["A", "B"], ["---", "---"], ["1", "2"]] },
    ]);
  });
});

describe("classifyDiffLine", () => {
  it("keeps unified diff coloring stable for Ink tool previews", () => {
    expect(classifyDiffLine("+new")).toBe("add");
    expect(classifyDiffLine("-old")).toBe("remove");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine("*** Begin Patch")).toBe("meta");
    expect(classifyDiffLine(" context")).toBe("context");
  });
});
