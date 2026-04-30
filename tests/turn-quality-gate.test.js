import { describe, expect, it } from "vitest";

import {
  __turnQualityRulesForTest,
  createTurnQualitySnapshot,
  evaluateForcedTurnFallback,
  evaluatePreTurnEndQuality,
} from "../server/chat/turn-quality-gate.js";

describe("turn quality gate", () => {
  it("declares explicit, non-overlapping rule priorities in evaluation order", () => {
    const seen = new Set();
    let previous = -Infinity;

    for (const rule of __turnQualityRulesForTest) {
      expect(rule.name).toBeTruthy();
      expect(seen.has(rule.name)).toBe(false);
      seen.add(rule.name);
      expect(Number.isFinite(rule.priority)).toBe(true);
      expect(rule.priority).toBeGreaterThan(previous);
      previous = rule.priority;
    }
  });

  it("emits a fallback for inactive/background empty turns instead of relying on retry", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: false,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "chat",
      originalPromptText: "随便答一句",
      effectivePromptText: "随便答一句",
      internalRetryCounts: {},
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("没有生成可见答案");
  });

  it("summarizes successful tools when the model produced no final answer", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      lastSuccessfulTools: [{ name: "bash", command: "mkdir -p 表格 && mv *.xlsx 表格/" }],
      originalPromptText: "把 Excel 移到表格文件夹",
      effectivePromptText: "把 Excel 移到表格文件夹",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("已完成本轮本地操作");
    expect(decision.text).toContain("mkdir -p 表格");
  });

  it("does not expose internal fallback kind labels in flow fallback", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: false,
      hasThinking: true,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "chat",
      originalPromptText: "时间",
      effectivePromptText: "时间",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("本轮工具已执行");
    expect(decision.text).not.toContain("类型：");
    expect(decision.text).not.toContain("thinking_only");
  });

  it("forces a failed-tool fallback when a stream is closed by a watchdog", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: true,
      routeIntent: "news",
      lastFailedTools: ["live_news"],
      originalPromptText: "今天科技新闻",
      effectivePromptText: "今天科技新闻",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluateForcedTurnFallback(ss, snapshot, { sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("工具调用失败");
    expect(decision.text).toContain("live_news");
  });
});
