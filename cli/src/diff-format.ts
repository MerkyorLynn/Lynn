/**
 * diff-format.ts — colorize a unified diff / apply_patch body for the terminal.
 * Pure + testable (no streams). Mirrors the GUI's diff-line classifier so the CLI
 * and the GUI render diffs the same way. Handles both unified diffs and the
 * apply_patch envelope (`*** Begin Patch` / `*** Update File:` / `@@`).
 */
import { cyan, dim, green, red } from "./terminal-style.js";

export type PatchLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function classifyPatchLine(line: string): PatchLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("*** ") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Colorize a patch body, capping at `maxLines` with a "+N more" marker. */
export function colorizePatch(patch: string, color: boolean, maxLines = 60): string {
  const all = patch.split(/\r?\n/);
  const shown = all.slice(0, maxLines).map((line) => {
    switch (classifyPatchLine(line)) {
      case "add":
        return green(line, color);
      case "del":
        return red(line, color);
      case "hunk":
        return cyan(line, color);
      case "meta":
        return dim(line, color);
      default:
        return line;
    }
  });
  if (all.length > maxLines) {
    shown.push(dim(`… (+${all.length - maxLines} more lines)`, color));
  }
  return shown.join("\n");
}
