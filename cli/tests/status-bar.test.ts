import { describe, expect, it } from "vitest";
import { renderStatusBar } from "../src/status-bar.js";

describe("status bar", () => {
  it("renders model, cwd, mode, reasoning, and usage", () => {
    const rendered = renderStatusBar({
      model: "StepFun",
      cwd: process.cwd(),
      mode: "ask / workspace-write",
      reasoning: "auto",
      decodeTps: "42 TPS",
      metrics: "avg decode 200 TPS · prefix-cache 70% recent",
      usage: "12 tokens",
      color: false,
    });

    expect(rendered).toContain("StepFun");
    expect(rendered).toContain("ask / workspace-write");
    expect(rendered).toContain("think auto");
    expect(rendered).toContain("decode 42 TPS");
    expect(rendered).toContain("avg decode 200 TPS");
    expect(rendered).toContain("prefix-cache 70% recent");
    expect(rendered).toContain("12 tokens");
  });
});
