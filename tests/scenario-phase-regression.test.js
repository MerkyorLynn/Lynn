import { describe, expect, it } from "vitest";

import {
  buildScenarioContractHintForText,
  classifyScenarioContract,
  SCENARIO_CONTRACT_IDS,
} from "../shared/scenario-contracts.js";
import { inferReportResearchKind } from "../server/chat/report-research-context.js";

describe("scenario phase regression matrix", () => {
  it("keeps the high-risk user-facing scenario contracts routed", () => {
    const rows = [
      ["上海明天下雨吗", SCENARIO_CONTRACT_IDS.WEATHER],
      ["今天金价如何", SCENARIO_CONTRACT_IDS.GOLD],
      ["DeepSeek概念股今天表现", SCENARIO_CONTRACT_IDS.STOCK],
      ["美伊谈判今天有进展吗", SCENARIO_CONTRACT_IDS.NEWS],
      ["读取这个 PDF 并提取付款条款", SCENARIO_CONTRACT_IDS.FILES],
      ["帮我整理桌面，把文件按项目归档", SCENARIO_CONTRACT_IDS.FILES],
      ["分析这张图片内容", SCENARIO_CONTRACT_IDS.MULTIMEDIA],
      ["给我做一份完整深度报告，不要伪深度", SCENARIO_CONTRACT_IDS.LONG_REPORT],
    ];

    for (const [prompt, expected] of rows) {
      expect(classifyScenarioContract(prompt, { imagesCount: prompt.includes("图片") ? 1 : 0 })).toBe(expected);
    }
  });

  it("requires hard evidence for realtime data instead of verbose fallback prose", () => {
    const hint = buildScenarioContractHintForText("今天布伦特原油价格是多少");

    expect(hint).toContain("实时数据类");
    expect(hint).toContain("数字、时间戳、来源");
    expect(hint).toContain("拿不到主源时换源");
  });

  it("requires scenario-specific evidence and fallback for weather/gold/stock/files/news/long report", () => {
    const cases = [
      ["上海明天下雨吗", "天气", "地点、日期/时间、天气状态、温度/降雨、来源"],
      ["今天金价如何", "金价", "品种、价格、单位、时间戳、来源"],
      ["查 AAPL 和 TSLA 最新股价", "股票/行情", "标的/候选池、价格或关键指标、时间戳、来源、风险提示"],
      ["把当前目录所有 Excel 和 CSV 移到表格文件夹", "文件", "真实路径、执行前状态、执行动作/读取内容、执行后状态"],
      ["今天科技/AI 领域两条重要新闻", "新闻", "发生日期、可靠来源、链接/出处、事实与解读分离"],
      ["做一份完整深度报告，不要伪深度", "长报告", "任务拆解、证据链、中间产物、最终交付"],
    ];

    for (const [prompt, title, evidence] of cases) {
      const hint = buildScenarioContractHintForText(prompt);
      expect(hint).toContain(title);
      expect(hint).toContain(evidence);
      expect(hint).toContain("失败兜底");
    }
  });

  it("keeps common realtime and market prompts on deterministic prefetch kinds", () => {
    expect(inferReportResearchKind("今天金价如何")).toBe("market");
    expect(inferReportResearchKind("今天布伦特石油价格")).toBe("market");
    expect(inferReportResearchKind("上海明天下雨吗")).toBe("weather");
    expect(inferReportResearchKind("美股七姐妹今天表现")).toBe("market");
    expect(inferReportResearchKind("DeepSeek概念股今天表现")).toBe("market");
  });
});
