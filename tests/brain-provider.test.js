import { describe, expect, it } from "vitest";
import { sanitizeBrainIdentityDisclosureText } from "../shared/brain-provider.js";

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
});
