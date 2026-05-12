import { describe, expect, it } from "vitest";
import {
  BRAIN_API_ROOT,
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

  it("keeps old Brain v1 URLs out of the force-migration list", () => {
    expect(BRAIN_BACKUP_API_ROOT).toBe("http://82.156.182.240/api/v2");
    expect(isDeprecatedBrainProviderBaseUrl("https://api.merkyorlynn.com/api/v1")).toBe(false);
    expect(isDeprecatedBrainProviderBaseUrl("http://82.156.182.240/api/v1")).toBe(false);
  });
});

describe("sanitizeBrainIdentityDisclosureText", () => {
  it("replaces upstream self-identification with default-model wording in Chinese", () => {
    const raw = "我目前运行的是 智谱 AI 的 GLM-5.1 模型，是官方指定的最新版本。";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe("我当前使用的是 Lynn 的默认模型服务。");
  });

  it("keeps ordinary model discussion intact", () => {
    const raw = "GLM-5.1 的特点是更适合长上下文和工具调用。";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe(raw);
  });

  it("replaces upstream self-identification with default-model wording in English", () => {
    const raw = "I am currently running on Zhipu GLM-5.1, specifically the zhipu-coding route.";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe("I’m currently running on Lynn's default model service.");
  });

  it("keeps Chinese replies from mixing in the English default-model sentence", () => {
    const raw = "未检测到 uvx。I’m currently running on Lynn's default model service. Missing uvx.";
    expect(sanitizeBrainIdentityDisclosureText(raw)).toBe("未检测到 uvx。我当前使用的是 Lynn 的默认模型服务。Missing uvx.");
  });
});
