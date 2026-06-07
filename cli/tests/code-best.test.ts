import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { bestEnabled, withBestCodeFlags } from "../src/code-best.js";
import { maxSteps } from "../src/commands/code.js";
import { ultraEnabled } from "../src/code-ultra-command.js";

describe("code best preset", () => {
  it("recognizes best and exhaustive aliases", () => {
    expect(bestEnabled(parseArgs(["code", "task", "--best"]))).toBe(true);
    expect(bestEnabled(parseArgs(["code", "task", "--exhaustive"]))).toBe(true);
    expect(bestEnabled(parseArgs(["code", "task"]))).toBe(false);
  });

  it("sets exhaustive defaults without overriding explicit knobs", () => {
    expect(withBestCodeFlags({})).toMatchObject({
      best: true,
      long: true,
      "save-session": true,
      "max-steps": "300",
      ultra: true,
      "ultra-verify": true,
      "ultra-max-subtasks": "8",
      "ultra-concurrency": "3",
      reasoning: "high",
    });
    expect(withBestCodeFlags({
      "max-steps": "120",
      "ultra-max-subtasks": "4",
      "ultra-concurrency": "2",
      reasoning: "medium",
    })).toMatchObject({
      "max-steps": "120",
      "ultra-max-subtasks": "4",
      "ultra-concurrency": "2",
      reasoning: "medium",
    });
  });

  it("raises the implicit step budget and enters ultra mode", () => {
    const args = parseArgs(["code", "task", "--best"]);
    expect(maxSteps(args)).toBe(300);
    expect(ultraEnabled(args)).toBe(true);
  });
});
