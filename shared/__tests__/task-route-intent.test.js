import { describe, expect, it } from "vitest";

import {
  buildProviderToolCallHint,
  classifyRouteIntent,
  looksLikePendingToolExecutionText,
} from "../task-route-intent.js";

describe("task route intent", () => {
  it("routes real-time lookup tasks to the utility path", () => {
    expect(classifyRouteIntent("今天金价多少")).toBe("utility");
    expect(classifyRouteIntent("北京今天天气怎么样")).toBe("utility");
    expect(classifyRouteIntent("今天有什么热点新闻")).toBe("utility");
    expect(classifyRouteIntent("湖人今天比分")).toBe("utility");
  });

  it("routes search-heavy benchmark comparisons to the utility path", () => {
    expect(classifyRouteIntent("GLM-5.1 和 KIMI K2.5 编程能力对比")).toBe("utility");
    expect(classifyRouteIntent("MiniMax M2.7 和 Step Star 最新评测对比")).toBe("utility");
  });

  it("keeps pure analysis tasks on the reasoning path", () => {
    expect(classifyRouteIntent("为什么最近大家都在讨论 Agent")).toBe("reasoning");
    expect(classifyRouteIntent("帮我分析这份方案的风险")).toBe("reasoning");
  });

  it("keeps install requests on the utility path", () => {
    expect(classifyRouteIntent("帮我安装 uv")).toBe("utility");
  });

  it("detects pending tool execution even when reflection text comes first", () => {
    const text = [
      "前提 Premise：",
      "- 用户反复询问今日金价",
      "",
      "推演 Conduct：",
      "- 直接用真实工具搜索今日金价",
      "",
      "我来查询今天4月10日的最新金价。",
    ].join("\n");
    expect(looksLikePendingToolExecutionText(text, "utility")).toBe(true);
  });

  it("adds strict tool-first hints for Kimi-like providers on utility tasks", () => {
    const hint = buildProviderToolCallHint({
      routeIntent: "utility",
      provider: "moonshot",
      modelId: "kimi-k2.5",
      locale: "zh",
    });
    expect(hint).toContain("第一步就直接调用真实工具");
    expect(hint).toContain("Premise / Conduct / Reflection / Act");
  });

  it("does not add strict tool-first hints for zhipu-coding", () => {
    expect(buildProviderToolCallHint({
      routeIntent: "utility",
      provider: "zhipu-coding",
      modelId: "glm-5-turbo",
      locale: "zh",
    })).toBe("");
  });
});
