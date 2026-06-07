import { describe, expect, it } from "vitest";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../src/runtime-answer.js";

describe("runtime answer", () => {
  it("detects local version and about questions", () => {
    expect(isLocalRuntimeQuestion("/version")).toBe(true);
    expect(isLocalRuntimeQuestion("/about")).toBe(true);
    expect(isLocalRuntimeQuestion("/model")).toBe(true);
    expect(isLocalRuntimeQuestion("你的版本号")).toBe(true);
    expect(isLocalRuntimeQuestion("你现在工作模型是什么模型")).toBe(true);
    expect(isLocalRuntimeQuestion("当前模型路由是什么")).toBe(true);
    expect(isLocalRuntimeQuestion("what version are you?")).toBe(true);
    expect(isLocalRuntimeQuestion("what model are you using?")).toBe(true);
    expect(isLocalRuntimeQuestion("show the active route")).toBe(true);
    expect(isLocalRuntimeQuestion("你的记忆可以保持多久")).toBe(true);
    expect(isLocalRuntimeQuestion("Lynn CLI 的 memory 会持久保存吗")).toBe(true);
    expect(isLocalRuntimeQuestion("本地优化了什么？")).toBe(true);
    expect(isLocalRuntimeQuestion("Lynn CLI 做了什么长任务优化")).toBe(true);
    expect(isLocalRuntimeQuestion("帮我写一个版本比较函数")).toBe(false);
    expect(isLocalRuntimeQuestion("帮我实现一个模型选择器")).toBe(false);
    expect(isLocalRuntimeQuestion("bump the package version in package.json")).toBe(false);
    expect(isLocalRuntimeQuestion("write a semantic version comparator")).toBe(false);
    expect(isLocalRuntimeQuestion("train a model router from logs")).toBe(false);
    expect(isLocalRuntimeQuestion("读一下这个项目给我一个你的架构评估和优化建议：https://github.com/MerkyorLynn/Lynn 只需要审阅CLI部分的架构")).toBe(false);
    expect(isLocalRuntimeQuestion("评估 Lynn CLI 的长任务架构")).toBe(false);
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
    expect(text).toContain("前置缓存");
    expect(text).toContain("decode TPS");
    expect(text).toContain("本地 9B");
    expect(text).toContain("升云到 StepFun");
    expect(text).toContain("本地 35B");
    expect(text).toContain("记忆和连续性");
    expect(text).toContain("/memory add");
    expect(text).toContain("docs/ops/lynn-cli-runtime-knowledge.md");
  });

  it("uses English for English prompts", () => {
    expect(localeForText("what version are you?")).toBe("en");
    expect(localeForText("what model are you using?")).toBe("en");
    expect(localeForText("你的版本号")).toBe("zh");
  });
});
