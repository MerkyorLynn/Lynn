import { describe, expect, it } from "vitest";
import { commonPrefix, completeSlash, completeAtMention, extractMentionPrefix, normalizeSlashInput } from "../src/completion.js";

const CMDS = ["/exit", "/help", "/think", "/tools", "/mode", "/model"];

describe("completeSlash", () => {
  it("completes a unique prefix to the full command", () => {
    expect(completeSlash("/ex", CMDS)).toEqual({ completed: "/exit", matches: ["/exit"] });
  });

  it("extends to the common prefix and lists candidates when ambiguous", () => {
    const r = completeSlash("/t", CMDS);
    expect(r.matches).toEqual(["/think", "/tools"]);
    expect(r.completed).toBe("/t"); // common prefix of think/tools is just "/t"
  });

  it("extends to a longer common prefix", () => {
    const r = completeSlash("/mod", CMDS);
    expect(r.matches).toEqual(["/mode", "/model"]);
    expect(r.completed).toBe("/mode"); // common prefix grows "/mod" -> "/mode"
  });

  it("returns no matches for unknown or non-slash input", () => {
    expect(completeSlash("/zzz", CMDS)).toEqual({ completed: "/zzz", matches: [] });
    expect(completeSlash("hello", CMDS)).toEqual({ completed: "hello", matches: [] });
  });
});

describe("commonPrefix", () => {
  it("finds the shared leading string", () => {
    expect(commonPrefix(["/mode", "/model"])).toBe("/mode");
    expect(commonPrefix(["/think", "/tools"])).toBe("/t");
    expect(commonPrefix([])).toBe("");
  });
});

describe("normalizeSlashInput", () => {
  it("keeps ASCII slash commands and normalizes full-width slash commands", () => {
    expect(normalizeSlashInput("/model")).toBe("/model");
    expect(normalizeSlashInput("／model")).toBe("/model");
  });
});

describe("extractMentionPrefix", () => {
  it("detects a mention at start or after whitespace", () => {
    expect(extractMentionPrefix("@src")).toEqual({ token: "src", start: 0 });
    expect(extractMentionPrefix("fix @src/co")).toEqual({ token: "src/co", start: 4 });
    expect(extractMentionPrefix("read @")).toEqual({ token: "", start: 5 });
  });

  it("ignores emails and completed mentions", () => {
    expect(extractMentionPrefix("mail me@host.com")).toBeNull(); // '@' not preceded by whitespace
    expect(extractMentionPrefix("look at @file.ts now")).toBeNull(); // not at the cursor/end
    expect(extractMentionPrefix("plain text")).toBeNull();
  });
});

describe("completeAtMention", () => {
  const FILES = ["src/code-highlight.ts", "src/completion.ts", "src/mentions.ts", "tests/"];

  it("completes a unique file mention and appends a space", () => {
    const r = completeAtMention("open @src/comp", ["src/completion.ts"]);
    expect(r).toEqual({ completed: "open @src/completion.ts ", matches: ["src/completion.ts"] });
  });

  it("keeps a directory's trailing slash so the next Tab descends", () => {
    const r = completeAtMention("@tes", ["tests/"]);
    expect(r.completed).toBe("@tests/");
  });

  it("extends to the common prefix and lists candidates when ambiguous", () => {
    const r = completeAtMention("@src/co", FILES);
    expect(r.matches).toEqual(["src/code-highlight.ts", "src/completion.ts"]);
    expect(r.completed).toBe("@src/co"); // common prefix of code-highlight/completion is "co"
  });

  it("preserves text before the mention and is a no-op without a mention", () => {
    expect(completeAtMention("just text", FILES)).toEqual({ completed: "just text", matches: [] });
    expect(completeAtMention("@zzz", FILES)).toEqual({ completed: "@zzz", matches: [] });
  });
});
