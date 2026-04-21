import { describe, expect, it } from "vitest";

import {
  buildDirectResearchAnswer,
  extractStockTargetForResearch,
  inferReportResearchKind,
} from "../server/chat/report-research-context.js";

describe("report research context intent", () => {
  it("detects composite market plus weather prompts that need a direct snapshot answer", () => {
    expect(
      inferReportResearchKind("请同时看一下今天 AAPL 最新价、上证指数最新点位、以及明天上海白天的天气，然后给出我明早去浦东机场时的出行与着装建议。"),
    ).toBe("market_weather_brief");
  });

  it("detects named-stock research prompts without an explicit stock code", () => {
    expect(inferReportResearchKind("华丰科技怎么看")).toBe("stock");
    expect(inferReportResearchKind("帮我深入调研一下华丰科技的压力位支撑位")).toBe("stock");
  });

  it("extracts known stock target aliases for hidden prefetch", () => {
    expect(extractStockTargetForResearch("华丰科技怎么看")).toEqual({
      name: "华丰科技",
      code: "688629",
    });
  });

  it("uses recent context to identify follow-up technical-analysis requests", () => {
    const context = [
      "assistant: 标的：华丰科技（688629）",
      "user: 我希望你深入调研一下压力位支撑位",
    ].join("\n");

    expect(inferReportResearchKind(context)).toBe("stock");
  });

  it("detects non-stock evidence-chain research as generic instead of forcing a fixed template", () => {
    expect(inferReportResearchKind("帮我研究一下这个品牌在日本市场的竞品和价格区间")).toBe("generic");
  });

  it("builds a direct gold answer when market prefetch already contains prices", () => {
    const context = [
      "【系统已完成行情工具预取】",
      "可核验到的黄金价格（2026-04-21）：",
      "- 上海黄金交易所 Au99.99 789.12 元/克",
      "- 深圳水贝黄金 756.5-768.8 元/克",
      "- 国际现货黄金（XAU/USD） 3386.4 美元/盎司",
      "- 品牌金店首饰金价：1423-1469 元/克（中国黄金 ~ 周生生）",
      "- 银行投资金条：1070.7-1077.66 元/克（农行传世之宝金条 ~ 工商银行如意金条）",
      "- 黄金回收：约 1046 元/克",
      "- 示例品牌：周生生 1469，老凤祥 1465，周六福 1460，中国黄金 1423 元/克",
    ].join("\n");

    const answer = buildDirectResearchAnswer("market", context, "今天金价如何");
    expect(answer).toContain("2026-04-21");
    expect(answer).toContain("上海黄金交易所 Au99.99 789.12 元/克");
    expect(answer).toContain("深圳水贝黄金 756.5-768.8 元/克");
    expect(answer).toContain("国际现货黄金（XAU/USD） 3386.4 美元/盎司");
    expect(answer).toContain("1423-1469 元/克");
    expect(answer).toContain("1070.7-1077.66 元/克");
    expect(answer).toContain("1046 元/克");
  });

  it("builds a direct composite answer for market plus weather commute prompts", () => {
    const context = [
      "【系统已完成综合工具预取】",
      "【美股快照】",
      "- 标的: AAPL",
      "- 最新价: $273.05",
      "- 时间戳: 2026-04-20 22:00:18",
      "- 来源: Stooq",
      "- 链接: https://stooq.com/q/?s=aapl.us",
      "【指数快照】",
      "- 指数: 上证指数",
      "- 最新点位: 4082.13",
      "- 涨跌幅: 0.76%",
      "- 查询日期: 2026-04-21",
      "- 来源: 新浪财经",
      "- 链接: https://finance.sina.com.cn/realstock/company/sh000001/nc.shtml",
      "【天气快照】",
      "- 地点: 上海",
      "- 日期: 2026-04-22",
      "- 天气: Patchy rain nearby",
      "- 温度: 22~27 C",
    ].join("\n");

    const answer = buildDirectResearchAnswer(
      "market_weather_brief",
      context,
      "请同时看一下今天 AAPL 最新价、上证指数最新点位、以及明天上海白天的天气，然后给出我明早去浦东机场时的出行与着装建议。",
    );

    expect(answer).toContain("数据快照");
    expect(answer).toContain("AAPL：$273.05");
    expect(answer).toContain("上证指数：4082.13 点");
    expect(answer).toContain("上海 2026-04-22");
    expect(answer).toContain("行动建议");
    expect(answer).toContain("浦东机场");
    expect(answer).toContain("不构成投资建议");
  });
});
