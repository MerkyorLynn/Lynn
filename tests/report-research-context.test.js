import { describe, expect, it } from "vitest";

import {
  extractStockTargetForResearch,
  inferReportResearchKind,
} from "../server/chat/report-research-context.js";

describe("report research context intent", () => {
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
});
