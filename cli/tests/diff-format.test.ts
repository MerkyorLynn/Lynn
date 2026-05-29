import { describe, expect, it } from "vitest";
import { classifyPatchLine, colorizePatch } from "../src/diff-format.js";

describe("classifyPatchLine", () => {
  it("classifies add / del / hunk / meta / context", () => {
    expect(classifyPatchLine("+new line")).toBe("add");
    expect(classifyPatchLine("-old line")).toBe("del");
    expect(classifyPatchLine("@@ -1,2 +1,3 @@")).toBe("hunk");
    expect(classifyPatchLine("*** Update File: a.ts")).toBe("meta");
    expect(classifyPatchLine("--- a/a.ts")).toBe("meta");
    expect(classifyPatchLine("+++ b/a.ts")).toBe("meta");
    expect(classifyPatchLine(" unchanged")).toBe("context");
  });
});

describe("colorizePatch", () => {
  it("wraps add/del/hunk lines in ANSI when color is on", () => {
    const out = colorizePatch("@@ -1 +1 @@\n+added\n-removed", true);
    expect(out).toContain("\x1b[32m+added\x1b[0m"); // green add
    expect(out).toContain("\x1b[31m-removed\x1b[0m"); // red del
    expect(out).toContain("\x1b[36m@@ -1 +1 @@\x1b[0m"); // cyan hunk
  });

  it("returns plain text when color is off", () => {
    expect(colorizePatch("+added\n-removed", false)).toBe("+added\n-removed");
  });

  it("caps at maxLines with a +N more marker", () => {
    const patch = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join("\n");
    const out = colorizePatch(patch, false, 3);
    expect(out.split("\n").length).toBe(4); // 3 shown + 1 marker
    expect(out).toContain("(+7 more lines)");
  });
});
