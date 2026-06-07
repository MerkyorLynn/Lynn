import { afterEach, describe, expect, it } from "vitest";
import {
  workingCheckpointEnabled,
  applyWorkingCheckpoint,
  formatWorkingCheckpointFrame,
  workingCheckpointObservation,
  MAX_WORKING_CHECKPOINT_CHARS,
} from "../src/code-working-checkpoint.js";
import { codeToolDefinitions } from "../src/code-tool-protocol.js";

describe("workingCheckpointEnabled (opt-in)", () => {
  it("defaults off and turns on only with LYNN_CLI_WORKING_CHECKPOINT=1", () => {
    expect(workingCheckpointEnabled({})).toBe(false);
    expect(workingCheckpointEnabled({ LYNN_CLI_WORKING_CHECKPOINT: "0" })).toBe(false);
    expect(workingCheckpointEnabled({ LYNN_CLI_WORKING_CHECKPOINT: "1" })).toBe(true);
  });
});

describe("applyWorkingCheckpoint", () => {
  it("trims and stores normal content", () => {
    expect(applyWorkingCheckpoint("  remember: use python3  ")).toBe("remember: use python3");
  });

  it("clears on blank / whitespace / non-string", () => {
    expect(applyWorkingCheckpoint("")).toBe("");
    expect(applyWorkingCheckpoint("   ")).toBe("");
    expect(applyWorkingCheckpoint(undefined)).toBe("");
    expect(applyWorkingCheckpoint(42)).toBe("");
  });

  it("caps oversized content so the notepad can never become a token hog", () => {
    const huge = "x".repeat(MAX_WORKING_CHECKPOINT_CHARS + 500);
    const capped = applyWorkingCheckpoint(huge);
    expect(capped.length).toBe(MAX_WORKING_CHECKPOINT_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("leaves content at exactly the cap untouched", () => {
    const exact = "y".repeat(MAX_WORKING_CHECKPOINT_CHARS);
    expect(applyWorkingCheckpoint(exact)).toBe(exact);
  });
});

describe("formatWorkingCheckpointFrame", () => {
  it("wraps the content in a labeled, self-describing frame", () => {
    const frame = formatWorkingCheckpointFrame("step 2 of 3 done; next: write tests");
    expect(frame).toContain("Working checkpoint");
    expect(frame).toContain("survives compaction");
    expect(frame).toContain("update_working_checkpoint");
    expect(frame).toContain("step 2 of 3 done; next: write tests");
  });
});

describe("workingCheckpointObservation", () => {
  it("confirms a save with the char count", () => {
    const msg = workingCheckpointObservation("abc");
    expect(msg).toContain("saved (3 chars)");
    expect(msg).toContain("re-injected every step");
  });
  it("reports a clear when empty", () => {
    expect(workingCheckpointObservation("")).toBe("Working checkpoint cleared.");
  });
});

describe("codeToolDefinitions opt-in gating", () => {
  const prev = process.env.LYNN_CLI_WORKING_CHECKPOINT;
  afterEach(() => {
    if (prev === undefined) delete process.env.LYNN_CLI_WORKING_CHECKPOINT;
    else process.env.LYNN_CLI_WORKING_CHECKPOINT = prev;
  });
  const names = (): string[] => codeToolDefinitions().map((t) => t.function.name);

  it("omits update_working_checkpoint by default", () => {
    delete process.env.LYNN_CLI_WORKING_CHECKPOINT;
    expect(names()).not.toContain("update_working_checkpoint");
  });
  it("includes update_working_checkpoint when enabled", () => {
    process.env.LYNN_CLI_WORKING_CHECKPOINT = "1";
    expect(names()).toContain("update_working_checkpoint");
  });
});
