import { describe, expect, it } from "vitest";
import { setLang } from "../src/i18n.js";
import { usage } from "../src/help.js";

describe("CLI help", () => {
  it("documents multi-image vision input", () => {
    setLang("en");
    try {
      expect(usage()).toContain("--images a.png,b.png");
      expect(usage()).toContain("Lynn --continue");
      expect(usage()).toContain("Lynn --resume <session.jsonl>");
      expect(usage()).toContain("Lynn code -p \"fix tests\" --json --cwd /repo --approval yolo");
      expect(usage()).toContain("Lynn worker run --brief task.md --worktree path --jsonl --approval yolo --sandbox danger-full-access");
      setLang("zh");
      expect(usage()).toContain("--images a.png,b.png");
      expect(usage()).toContain("Lynn --continue");
      expect(usage()).toContain("Lynn --resume <session.jsonl>");
      expect(usage()).toContain("Lynn code -p \"fix tests\" --json --cwd /repo --approval yolo");
      expect(usage()).toContain("Lynn worker run --brief task.md --worktree path --jsonl --approval yolo --sandbox danger-full-access");
    } finally {
      setLang(null);
    }
  });
});
