import { describe, expect, it } from "vitest";

import {
  buildScenarioContractHintForText,
  classifyScenarioContract,
  SCENARIO_CONTRACT_IDS,
} from "../shared/scenario-contracts.js";
import { inferReportResearchKind } from "../server/chat/report-research-context.js";

describe("scenario phase regression matrix", () => {
  it("keeps the seven user-facing scenario classes routed", () => {
    const rows = [
      ["今天金价如何", SCENARIO_CONTRACT_IDS.REALTIME_DATA],
      ["DeepSeek概念股今天表现", SCENARIO_CONTRACT_IDS.MARKET_RESEARCH],
      ["美伊谈判今天有进展吗", SCENARIO_CONTRACT_IDS.NEWS_FACT],
      ["读取这个 PDF 并提取付款条款", SCENARIO_CONTRACT_IDS.DOCUMENT_FILE],
      ["帮我整理桌面，把文件按项目归档", SCENARIO_CONTRACT_IDS.LOCAL_AUTOMATION],
      ["分析这张图片内容", SCENARIO_CONTRACT_IDS.MULTIMEDIA],
      ["给我做一份完整深度报告，不要伪深度", SCENARIO_CONTRACT_IDS.LONG_AGENT],
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

  it("keeps common realtime and market prompts on deterministic prefetch kinds", () => {
    expect(inferReportResearchKind("今天金价如何")).toBe("market");
    expect(inferReportResearchKind("今天布伦特石油价格")).toBe("market");
    expect(inferReportResearchKind("上海明天下雨吗")).toBe("weather");
    expect(inferReportResearchKind("美股七姐妹今天表现")).toBe("market");
    expect(inferReportResearchKind("DeepSeek概念股今天表现")).toBe("market");
  });
});
