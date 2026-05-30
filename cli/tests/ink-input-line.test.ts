import { describe, expect, it } from "vitest";
import { normalizeSlashInput } from "../src/completion.js";
import { slashHint, slashPalette, slashPaletteItems } from "../src/ink-input-line.js";

describe("Ink input slash hints", () => {
  it("shows command candidates when the user starts slash input", () => {
    expect(slashHint("/", ["/help", "/model", "/providers"], 80)).toContain("/model");
  });

  it("shows the remaining suffix for a unique command prefix", () => {
    expect(slashHint("/mod", ["/help", "/model", "/providers"], 80)).toContain("el");
  });

  it("truncates long candidate lists to fit the input line", () => {
    const hint = slashHint("/", ["/help", "/model", "/providers", "/providers set", "/providers unset"], 18);
    expect(hint.length).toBeLessThanOrEqual(18);
    expect(hint).toContain("...");
  });

  it("does nothing for normal user text", () => {
    expect(slashHint("hello", ["/help"], 80)).toBe("");
  });

  it("renders a command palette next to slash input", () => {
    const palette = slashPalette("/", ["/help", "/model", "/providers"]);
    expect(palette).toContain("/model");
    expect(palette).toContain("路由");
  });

  it("shows an unknown-command guard for unmatched slash input", () => {
    expect(slashPalette("/bad", ["/help", "/model"])).toContain("未知命令");
  });

  it("returns structured palette items (command + label) for two-tone rendering", () => {
    const items = slashPaletteItems("/mod", ["/help", "/model", "/providers"]);
    expect(items.map((item) => item.command)).toEqual(["/model"]);
    expect(items[0].label.length).toBeGreaterThan(0);
    expect(slashPaletteItems("hello", ["/help"])).toEqual([]);
  });

  it("normalizes full-width slash from Chinese IMEs", () => {
    expect(normalizeSlashInput("／model")).toBe("/model");
  });
});
