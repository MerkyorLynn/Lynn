import { describe, expect, it } from "vitest";
import {
  BRAIN_API_ROOT,
  BRAIN_DEFAULT_MODEL_ID,
  isBrainModelId,
  BRAIN_BACKUP_API_ROOT,
  BRAIN_PROVIDER_BASE_URL,
  buildBrainProviderConfig,
  isDeprecatedBrainProviderBaseUrl,
  sanitizeBrainIdentityDisclosureText,
} from "../shared/brain-provider.js";

describe("Brain v2 default policy", () => {
  it("defaults new installs to Brain v2", () => {
    expect(BRAIN_API_ROOT).toBe("https://api.merkyorlynn.com/api/v2");
    expect(BRAIN_PROVIDER_BASE_URL).toBe("https://api.merkyorlynn.com/api/v2/v1");
    expect(buildBrainProviderConfig().base_url).toBe(BRAIN_PROVIDER_BASE_URL);
  });

  it("force-migrates old Brain v1 URLs to the Brain v2 default route", () => {
    expect(BRAIN_BACKUP_API_ROOT).toBe("https://api.merkyorlynn.com/api/v2");
    expect(isDeprecatedBrainProviderBaseUrl("https://api.merkyorlynn.com/api/v1")).toBe(true);
    expect(isDeprecatedBrainProviderBaseUrl("http://82.156.182.240/api/v1")).toBe(true);
  });
});

describe("sanitizeBrainIdentityDisclosureText", () => {
  it("keeps upstream self-identification unchanged in Chinese", () => {
    const raw = "我目前运行的是 智谱 AI 的 GLM-5.1 模型，是官方指定的最新版本。";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe(raw);
  });

  it("keeps ordinary model discussion intact", () => {
    const raw = "GLM-5.1 的特点是更适合长上下文和工具调用。";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe(raw);
  });

  it("keeps upstream self-identification unchanged in English", () => {
    const raw = "I am currently running on Zhipu GLM-5.1, specifically the zhipu-coding route.";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe(raw);
  });

  it("does not rewrite mixed-language identity text", () => {
    const raw = "未检测到 uvx。I’m currently running on Lynn's default model service. Missing uvx.";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe(raw);
  });
});

describe("default GUI and CLI model", () => {
  it("uses Step 5 as the built-in default and still accepts the router id", () => {
    expect(BRAIN_DEFAULT_MODEL_ID).toBe("step-5-preview");
    expect(isBrainModelId("step-5-preview")).toBe(true);
    expect(isBrainModelId("lynn-brain-router")).toBe(true);
  });
});
