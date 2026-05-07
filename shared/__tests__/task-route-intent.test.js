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

  it("does not route named model knowledge questions to vision just because the name contains Image", () => {
    expect(classifyRouteIntent("你知道 Qwen-Image-Layered 吗？")).toBe("chat");
    expect(classifyRouteIntent("什么是 Qwen-Image-Layered")).toBe("chat");
  });

  it("keeps explicit screenshot and image analysis prompts on the vision path", () => {
    expect(classifyRouteIntent("帮我看一下这张截图里的问题")).toBe("vision");
    expect(classifyRouteIntent("识别一下图片里的文字")).toBe("vision");
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
    expect(hint).toContain("工具链没有稳定返回");
    expect(hint).toContain("不要只输出");
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

  it("detects unfinished continuation text after a partial local tool run", () => {
    expect(looksLikePendingToolExecutionText("找到 2 个 PDF 文件（`a.pdf` 和 `b.PDF`），开始创建文件夹并移动。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("目录已经列出来了，接下来执行 mkdir 和 mv。", "utility")).toBe(true);
  });

  it("detects research progress narration as unfinished tool execution", () => {
    expect(looksLikePendingToolExecutionText("开始系统调研，先并行搜索多个维度的信息。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("搜索结果较简略，继续深挖具体数据和报告。", "utility")).toBe(true);
    expect(looksLikePendingToolExecutionText("需要抓取具体页面获取数据。继续深挖。", "utility")).toBe(true);
  });

  it("does not flag ordinary research conclusions as pending execution", () => {
    expect(looksLikePendingToolExecutionText("本次调研显示，老年用户的轻娱乐需求主要集中在陪伴、低门槛和稳定反馈。", "utility")).toBe(false);
    expect(looksLikePendingToolExecutionText("根据现有资料，三个渠道的转化路径存在明显差异。", "utility")).toBe(false);
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
    expect(hint).toContain("不能空答");
  });

  it("does not add strict tool-first hints for zhipu-coding", () => {
    expect(buildProviderToolCallHint({
      routeIntent: "utility",
      provider: "zhipu-coding",
      modelId: "glm-5-turbo",
      locale: "zh",
    })).toBe("");
  });

  it("does not add strict tool-first hints for the default brain router", () => {
    expect(buildProviderToolCallHint({
      routeIntent: "utility",
      provider: "brain",
      modelId: "lynn-brain-router",
      locale: "zh",
    })).toBe("");
  });

  // ─────────────────────────────────────────────────────────────────
  // [REGRESSION GUARANTEE · 2026-04-27 night]
  // 文件管理动词 + "图片"宾语 不能再被 VISION_RE 误判 → 必须 UTILITY
  // 原 bug:模型只 narrate 不 emit tool_call(因为被注入"按默认推理链路处理"系统提示)
  // 这组测试通过 = 文件移动/整理图片不再走伪 tool_call 路径
  // ─────────────────────────────────────────────────────────────────
  describe("file-move-image regression guarantee (2026-04-27 night)", () => {
    it("file-create + folder + 图片 noun → utility (not vision)", () => {
      expect(classifyRouteIntent("桌面新建一个图片文件夹把桌面的图片都挪进去")).toBe("utility");
      expect(classifyRouteIntent("桌面新建一个图片文件夹把桌面的图片都")).toBe("utility");  // 截断版本也要对
      expect(classifyRouteIntent("帮我建一个图片目录")).toBe("utility");
    });

    it("file-move verb + 图片 + 文件夹 → utility", () => {
      expect(classifyRouteIntent("把下载文件夹的图片都放到下载图片文件夹里面")).toBe("utility");
      expect(classifyRouteIntent("移动桌面上的所有图片到新文件夹")).toBe("utility");
      expect(classifyRouteIntent("把这些图片挪进归档目录")).toBe("utility");
    });

    it("organize/cleanup verb + 图片 + 桌面/下载 → utility", () => {
      expect(classifyRouteIntent("整理桌面图片")).toBe("utility");
      expect(classifyRouteIntent("整理下载文件夹的图片")).toBe("utility");
      expect(classifyRouteIntent("清理桌面图片文件")).toBe("utility");
      expect(classifyRouteIntent("把下载里的图片归档到 Pictures")).toBe("utility");
    });

    it("ensure pure vision (无文件管理动词) still goes to vision", () => {
      // 反向 sanity check:真正的图像分析不能被 FILE_OPS_RE 误吃
      expect(classifyRouteIntent("看图说话")).toBe("vision");
      expect(classifyRouteIntent("识别一下这张截图里的文字")).toBe("vision");
      expect(classifyRouteIntent("OCR 提取图片内容", { imagesCount: 1 })).toBe("vision");
    });
  });

  it("requires copyable verification commands for coding fix tasks", () => {
    const hint = buildRouteIntentSystemHint("coding", "zh-CN");

    expect(hint).toContain("python main.py");
    expect(hint).toContain("请运行验证");
    expect(hint).toContain("没有真实修改时不要说“已修复”");
  });
});
