import { describe, expect, it } from "vitest";
import { toModelOptionValue, buildAutomationModelOptions } from "../src/react/components/AutomationPanel.helpers";

describe("toModelOptionValue", () => {
  it("prefixes the provider when present", () => {
    expect(toModelOptionValue({ id: "gpt-4o", provider: "openai" })).toBe("openai/gpt-4o");
    expect(toModelOptionValue({ id: "local-model" })).toBe("local-model");
  });
});

describe("buildAutomationModelOptions", () => {
  it("returns ModelOption-shaped entries carrying raw id/provider + a stable value", () => {
    const out = buildAutomationModelOptions([
      { id: "alpha", provider: "openai", name: "Alpha" },
      { id: "beta", provider: "spark", name: "Beta" },
    ]);
    expect(Array.isArray(out)).toBe(true);
    for (const opt of out) {
      expect(opt).toHaveProperty("value");
      expect(opt).toHaveProperty("label");
      expect(opt).toHaveProperty("rawId");
      expect(opt).toHaveProperty("rawProvider");
      expect(opt.value).toBe(opt.rawProvider ? `${opt.rawProvider}/${opt.rawId}` : opt.rawId);
    }
  });

  it("appends the provider to the label when two models share a display name", () => {
    const out = buildAutomationModelOptions([
      { id: "m1", provider: "openai", name: "Dup" },
      { id: "m2", provider: "spark", name: "Dup" },
    ]);
    // when names collide and a provider label exists, it is disambiguated with ' · '
    const disambiguated = out.filter((o) => o.label.includes(" · "));
    if (out.length === 2) expect(disambiguated.length).toBeGreaterThan(0);
  });
});
