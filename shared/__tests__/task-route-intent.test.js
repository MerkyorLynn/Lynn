import { describe, expect, it } from "vitest";

import {
  buildProviderToolCallHint,
  buildRouteIntentSystemHint,
  classifyRouteIntent,
  isInternalAutomationPrompt,
  looksLikePendingToolExecutionText,
} from "../task-route-intent.js";

describe("task route intent", () => {
  it("routes real-time lookup tasks to the utility path", () => {
    expect(classifyRouteIntent("今天金价多少")).toBe("utility");
    expect(classifyRouteIntent("北京今天天气怎么样")).toBe("utility");
    expect(classifyRouteIntent("今天有什么热点新闻")).toBe("utility");
    expect(classifyRouteIntent("湖人今天比分")).toBe("utility");
    expect(classifyRouteIntent("美伊谈判今天有进展吗？")).toBe("utility");
    expect(classifyRouteIntent("伊朗和美国谈判最新消息")).toBe("utility");
    expect(classifyRouteIntent("华丰科技怎么看")).toBe("utility");
    expect(classifyRouteIntent("帮我深入调研一下华丰科技的压力位支撑位")).toBe("utility");
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

  it("keeps internal automation prompts away from tool-prefetch routing", () => {
    const heartbeat = [
      "[心跳巡检] 现在是 2026/4/11 15:00:00",
      "注意：这是系统自动触发的巡检消息，不是用户发来的。",
      "用户目前没有在跟你对话，不要把巡检当作用户的提问来回应。",
      "## 工作空间文件：",
      "- 0407-最近一周迭代复盘.md",
    ].join("\n");
    const crew = [
      "#ch_crew 频道最近消息：",
      "[2026-04-11 15:00:00] system: error.defaultChannelDesc",
      "请阅读这些消息，用 search_memory 查阅记忆来了解上下文。",
      "注意：你现在的回复用户看不到，这是你的内部思考环节。",
    ].join("\n");

    expect(isInternalAutomationPrompt(heartbeat)).toBe(true);
    expect(isInternalAutomationPrompt(crew)).toBe(true);
    expect(classifyRouteIntent(heartbeat)).toBe("reasoning");
    expect(classifyRouteIntent(crew)).toBe("reasoning");
  });

  it("still routes everyday user work requests to utility", () => {
    expect(classifyRouteIntent("帮我整理桌面，把报告合并一下")).toBe("utility");
    expect(classifyRouteIntent("读取这个PDF，提取付款和违约条款")).toBe("utility");
    expect(classifyRouteIntent("明天早上9点提醒我执行日报定时任务")).toBe("utility");
  });

  it("tells utility routes to research the user's actual question and use scripts when useful", () => {
    const hint = buildRouteIntentSystemHint("utility", "zh");
    expect(hint).toContain("用户问什么就围绕什么自然延展");
    expect(hint).toContain("临时 Python/Node 脚本");
    expect(hint).toContain("截图、链接、导出文件、PDF");
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

  it("detects pending local workspace reads", () => {
    expect(looksLikePendingToolExecutionText("我来读取桌面Lynn文件夹的内容。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("我来看工作空间和你的工作清单。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("我需要用正确的工具来读取文件夹内容，而不是搜索。让我用bash来列出文件夹。", "utility")).toBe(true);
  });

  it("detects local file permission deflections as unfinished execution", () => {
    expect(looksLikePendingToolExecutionText("抱歉，我当前没有文件系统读取权限，无法直接列出 /Users/lynn/Desktop/Lynn 文件夹内的内容。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("I cannot access the local file system to list this folder.", "utility")).toBe(true);
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

  it("adds strict tool-first hints for the default brain router on execution tasks", () => {
    const hint = buildProviderToolCallHint({
      routeIntent: "utility",
      provider: "brain",
      modelId: "lynn-brain-router",
      locale: "zh",
    });
    expect(hint).toContain("第一步就直接调用真实工具");
  });
});
