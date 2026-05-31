import { describe, expect, it } from "vitest";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../src/runtime-answer.js";

describe("runtime answer", () => {
  it("detects local version and about questions", () => {
    expect(isLocalRuntimeQuestion("/version")).toBe(true);
    expect(isLocalRuntimeQuestion("/about")).toBe(true);
    expect(isLocalRuntimeQuestion("你的版本号")).toBe(true);
    expect(isLocalRuntimeQuestion("what version are you?")).toBe(true);
    expect(isLocalRuntimeQuestion("帮我写一个版本比较函数")).toBe(false);
    expect(isLocalRuntimeQuestion("bump the package version in package.json")).toBe(false);
    expect(isLocalRuntimeQuestion("write a semantic version comparator")).toBe(false);
  });

  it("renders the local CLI version instead of asking the model", () => {
    const text = renderLocalRuntimeAnswer({
      routeLabel: "StepFun 3.7 Flash → MiMo V2.5 Pro",
      brainUrl: "https://api.merkyorlynn.com/api/v2",
      cwd: "/tmp/project",
      mode: "ask / workspace-write",
      reasoning: "high",
    }, "zh");
    expect(text).toContain("Lynn CLI 版本:");
    expect(text).toContain("模型路由:StepFun 3.7 Flash");
    expect(text).toContain("Brain:https://api.merkyorlynn.com/api/v2");
    expect(text).toContain("权限:ask / workspace-write");
  });

  it("uses English for English prompts", () => {
    expect(localeForText("what version are you?")).toBe("en");
    expect(localeForText("你的版本号")).toBe("zh");
  });
});
