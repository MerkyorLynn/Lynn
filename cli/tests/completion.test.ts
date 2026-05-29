import { describe, expect, it } from "vitest";
import { commonPrefix, completeSlash } from "../src/completion.js";

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
