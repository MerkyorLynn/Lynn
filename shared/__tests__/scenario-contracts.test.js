import { describe, expect, it } from "vitest";

import {
  buildScenarioContractHint,
  classifyScenarioContract,
  SCENARIO_CONTRACTS,
  SCENARIO_CONTRACT_IDS,
} from "../scenario-contracts.js";

describe("scenario contracts", () => {
  it("classifies realtime data requests", () => {
    expect(classifyScenarioContract("今天金价如何")).toBe(SCENARIO_CONTRACT_IDS.GOLD);
    expect(classifyScenarioContract("上海明天下雨吗，温度多少")).toBe(SCENARIO_CONTRACT_IDS.WEATHER);
    expect(classifyScenarioContract("今天布伦特石油价格")).toBe(SCENARIO_CONTRACT_IDS.REALTIME_DATA);
  });

  it("classifies market and research requests", () => {
    expect(classifyScenarioContract("DeepSeek概念股今天表现")).toBe(SCENARIO_CONTRACT_IDS.STOCK);
    expect(classifyScenarioContract("美股七姐妹今天表现")).toBe(SCENARIO_CONTRACT_IDS.STOCK);
    expect(classifyScenarioContract("帮我分析华丰科技基本面、估值和市值区间")).toBe(SCENARIO_CONTRACT_IDS.STOCK);
    expect(classifyScenarioContract("以鸣溪谷和兰溪谷为基准评估蛇口楼盘")).toBe(SCENARIO_CONTRACT_IDS.MARKET_RESEARCH);
  });

  it("classifies news and fact-checking requests", () => {
    expect(classifyScenarioContract("美伊谈判今天有进展吗")).toBe(SCENARIO_CONTRACT_IDS.NEWS);
    expect(classifyScenarioContract("这个政策最新消息按时间线整理")).toBe(SCENARIO_CONTRACT_IDS.NEWS);
  });

  it("classifies document and file requests", () => {
    expect(classifyScenarioContract("读取这个PDF，提取付款和违约条款")).toBe(SCENARIO_CONTRACT_IDS.FILES);
    expect(classifyScenarioContract("帮我分析桌面上的Excel并合并报表")).toBe(SCENARIO_CONTRACT_IDS.FILES);
  });

  it("classifies local automation requests", () => {
    expect(classifyScenarioContract("帮我整理桌面，把文件按项目归档")).toBe(SCENARIO_CONTRACT_IDS.FILES);
    expect(classifyScenarioContract("明天9点提醒我执行日报")).toBe(SCENARIO_CONTRACT_IDS.LOCAL_AUTOMATION);
  });

  it("classifies multimedia requests", () => {
    expect(classifyScenarioContract("分析这张图片内容", { imagesCount: 1 })).toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
    expect(classifyScenarioContract("帮我朗读这条回复")).toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
    expect(classifyScenarioContract("语音输入转文字失败了")).toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
  });

  it("classifies long agent requests", () => {
    expect(classifyScenarioContract("给我做一份完整深度报告，不要伪深度")).toBe(SCENARIO_CONTRACT_IDS.LONG_REPORT);
    expect(classifyScenarioContract("分析这个项目代码结构并给优化方案")).toBe(SCENARIO_CONTRACT_IDS.LONG_REPORT);
  });

  it("builds scenario hints with concrete pass bars", () => {
    expect(buildScenarioContractHint("weather", "zh")).toContain("必需证据：地点、日期/时间、天气状态、温度/降雨、来源");
    expect(buildScenarioContractHint("files", "zh")).toContain("不能把计划、扫描或空输出说成已经完成");
    expect(buildScenarioContractHint("long_report", "zh")).toContain("不能只给标题或空壳");
  });

  it("defines regression cases for the high-risk contracts", () => {
    for (const id of [
      SCENARIO_CONTRACT_IDS.WEATHER,
      SCENARIO_CONTRACT_IDS.GOLD,
      SCENARIO_CONTRACT_IDS.STOCK,
      SCENARIO_CONTRACT_IDS.FILES,
      SCENARIO_CONTRACT_IDS.NEWS,
      SCENARIO_CONTRACT_IDS.LONG_REPORT,
    ]) {
      const hint = buildScenarioContractHint(id, "zh");
      expect(hint).toContain("完成标准");
      expect(hint).toContain("失败兜底");
      expect(SCENARIO_CONTRACTS[id].requiredEvidence.length).toBeGreaterThan(0);
      expect(SCENARIO_CONTRACTS[id].failureMode).toBeTruthy();
      expect(SCENARIO_CONTRACTS[id].regressionCases.length).toBeGreaterThanOrEqual(3);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // [REGRESSION GUARANTEE · 2026-04-27 night]
  // 文件管理动词 + "图片"宾语 不能再被 MULTIMEDIA_RE 误判 → 必须 LOCAL_AUTOMATION
  // 原 bug:被判 MULTIMEDIA → 注入"附件必须可靠进入模型/TTS+ASR 健康检查"系统提示 → 模型只 narrate
  // 这组测试通过 = 用户文件管理任务不再被塞错"多媒体契约"
  // ─────────────────────────────────────────────────────────────────
  describe("file-move-image regression guarantee (2026-04-27 night)", () => {
    it("file-create + folder + 图片 noun → local_automation (not multimedia)", () => {
      expect(classifyScenarioContract("桌面新建一个图片文件夹把桌面的图片都挪进去"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
      expect(classifyScenarioContract("帮我建一个图片目录"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
    });

    it("file-move verb + 图片 + 文件夹 → local_automation", () => {
      expect(classifyScenarioContract("把下载文件夹的图片都放到下载图片文件夹里面"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
      expect(classifyScenarioContract("移动桌面上的所有图片到新文件夹"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
      expect(classifyScenarioContract("把这些图片挪进归档目录"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
    });

    it("organize/cleanup + 图片 + 桌面/下载 → local_automation", () => {
      expect(classifyScenarioContract("整理桌面图片"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
      expect(classifyScenarioContract("整理下载文件夹的图片"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
      expect(classifyScenarioContract("清理桌面图片文件"))
        .toBe(SCENARIO_CONTRACT_IDS.FILES);
    });

    it("with attached image (hasImages > 0) → multimedia (sanity)", () => {
      // 如果用户真上传了图片,优先走 multimedia(因为 hasImages 短路了)
      expect(classifyScenarioContract("看下这张截图说了什么", { imagesCount: 1 }))
        .toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
      expect(classifyScenarioContract("分析这张图片", { imagesCount: 1 }))
        .toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
    });

    it("pure vision verbs (no file ops) → multimedia (sanity)", () => {
      expect(classifyScenarioContract("识别一下这张截图里的文字"))
        .toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
      expect(classifyScenarioContract("OCR 提取图片内容"))
        .toBe(SCENARIO_CONTRACT_IDS.MULTIMEDIA);
    });
  });
});
