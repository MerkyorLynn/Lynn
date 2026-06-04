import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const m = require("../brain-url-policy.cjs");

describe("normalizeBrainUrl", () => {
  it("trims and strips trailing slashes", () => {
    expect(m.normalizeBrainUrl("  https://x.com/api/  ")).toBe("https://x.com/api");
    expect(m.normalizeBrainUrl("https://x.com///")).toBe("https://x.com");
    expect(m.normalizeBrainUrl("")).toBe("");
    expect(m.normalizeBrainUrl(null)).toBe("");
  });
});

describe("deprecation checks", () => {
  it("flags deprecated brain API roots", () => {
    expect(m.isDeprecatedBrainApiRoot("https://api.merkyorlynn.com/api/")).toBe(true);
    expect(m.isDeprecatedBrainApiRoot("http://82.156.182.240/api")).toBe(true);
    expect(m.isDeprecatedBrainApiRoot(m.CANONICAL_BRAIN_API_ROOT)).toBe(false);
    expect(m.isDeprecatedBrainApiRoot("")).toBe(false);
  });
  it("flags deprecated provider base URLs", () => {
    expect(m.isDeprecatedBrainProviderBaseUrl("https://api.merkyorlynn.com/api/v1")).toBe(true);
    expect(m.isDeprecatedBrainProviderBaseUrl(m.CANONICAL_BRAIN_PROVIDER_BASE_URL)).toBe(false);
  });
  it("canonical provider base = api root + /v1", () => {
    expect(m.CANONICAL_BRAIN_PROVIDER_BASE_URL).toBe(`${m.CANONICAL_BRAIN_API_ROOT}/v1`);
  });
});
