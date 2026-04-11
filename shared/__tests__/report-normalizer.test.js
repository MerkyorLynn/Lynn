import { describe, expect, it } from "vitest";

import {
  buildReportStructureHint,
  inferReportKind,
  inferReportPromptKind,
  normalizeReportResponseText,
} from "../report-normalizer.js";

describe("report normalizer", () => {
  it("cleans stock-report text without synthesizing fixed sections", () => {
    const raw = [
      "**华丰科技（688629.SH）深度走势预测报告**",
      "",
      "## 一、基本面分析",
      "公司处于高端连接器赛道。",
      "",
      "## 二、技术面分析",
      "当前处于高位震荡，压力位 135 元。",
      "",
      "## 四、三种情景推演（未来1-3个月）",
      "乐观、中性、悲观三种路径。",
      "",
      "## 五、操作策略与仓位管理",
      "分批建仓并设置止损。",
    ].join("\n");

    const normalized = normalizeReportResponseText(raw);
    expect(inferReportKind(raw)).toBe("stock");
    expect(normalized).not.toContain("## 一句话结论");
    expect(normalized).not.toContain("## 核心数据底稿");
    expect(normalized).toContain("技术面分析");
    expect(normalized).toContain("三种情景推演");
  });

  it("cleans real-estate report text without adding fixed headings", () => {
    const raw = [
      "**深圳蛇口低密山海豪宅对标分析报告**",
      "",
      "### 一、基准楼盘核心指标画像",
      "鸣溪谷、山语海、兰溪谷一期均需要对比容积率、绿化率、山海景观和价格。",
      "",
      "#### 1. 兰溪谷二期",
      "- 匹配度评级：4/5",
      "",
      "#### 资料局限性说明",
      "部分容积率和均价待核实。",
    ].join("\n");

    const normalized = normalizeReportResponseText(raw);
    expect(inferReportKind(raw)).toBe("real_estate");
    expect(normalized).not.toContain("## 基准项目标准");
    expect(normalized).not.toContain("## 匹配度排序");
    expect(normalized).toContain("鸣溪谷");
    expect(normalized).toContain("兰溪谷二期");
  });

  it("leaves ordinary answers alone", () => {
    const raw = "今天深圳天气局部多云，适合带伞但主要注意防晒。";
    expect(inferReportKind(raw)).toBe("");
    expect(normalizeReportResponseText(raw)).toBe(raw);
  });

  it("repairs glued report headings and removes unfinished lookup promises", () => {
    const raw = "核心数据底稿\n\n标的：华丰科技（688629）\n数据约束：以公告核验。## 一句话结论\n华丰科技高位震荡。我搜一下最新财报和机构观点。## 技术面\n需补充K线。- 操作上观察支撑。## 三种情景推演\n乐观、中性、悲观。";
    const normalized = normalizeReportResponseText(raw);

    expect(normalized).toContain("核验。\n\n## 一句话结论");
    expect(normalized).toContain("## 技术面");
    expect(normalized).not.toContain("我搜一下");
    expect(normalized).toContain("需补充K线。\n- 操作上观察支撑。");
  });

  it("removes stock lookup promises that would otherwise become shallow report text", () => {
    const raw = "核心数据底稿\n\n标的：华丰科技（688629）\n\n## 一句话结论\n高位震荡。我来搜索一下压力位支撑位的技术分析资料。## 技术面\n需补充K线、均线、成交量、筹码和关键支撑/压力位二次核验。";
    const normalized = normalizeReportResponseText(raw);

    expect(normalized).not.toContain("我来搜索一下");
    expect(normalized).toContain("## 技术面");
    expect(normalized).toContain("压力位二次核验");
  });

  it("builds stricter structure hints for stock and real-estate prompts", () => {
    expect(inferReportPromptKind("按腾讯文档水平分析华丰科技688629未来1-3个月走势")).toBe("stock");
    expect(inferReportPromptKind("华丰科技怎么看")).toBe("stock");
    expect(inferReportPromptKind("帮我深入调研一下华丰科技的压力位支撑位")).toBe("stock");
    expect(inferReportPromptKind("以鸣溪谷、山语海、兰溪谷一期为基准评估蛇口楼盘容积率和价格")).toBe("real_estate");
    expect(buildReportStructureHint("帮我深入调研一下华丰科技的压力位支撑位")).toContain("用户要什么就研究什么");
    expect(buildReportStructureHint("帮我深入调研一下华丰科技的压力位支撑位")).toContain("压力位/支撑位");
    expect(buildReportStructureHint("分析华丰科技基本面、估值与市值区间预判")).toContain("估值/市值区间");
    expect(buildReportStructureHint("以鸣溪谷、山语海、兰溪谷一期为基准评估蛇口楼盘容积率和价格")).toContain("用户要什么就研究什么");
  });
});
