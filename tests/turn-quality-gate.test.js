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

    // [BRAIN ROLL 2026-05-05] evaluator 已 stub return null,brain 不替模型决策
    expect(decision).toBeNull();
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

    // [BRAIN ROLL 2026-05-05] evaluator 已 stub return null,brain 不替模型决策
    expect(decision).toBeNull();
  });

  it("continues local mutation tasks before summarizing a partial mkdir as success", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      internalRetryCounts: {},
      lastSuccessfulTools: [{ name: "bash", command: "mkdir -p /Users/lynn/Desktop/Claude" }],
      originalPromptText: "把我桌面的HTML移动到桌面Claude文件夹",
      effectivePromptText: "把我桌面的HTML移动到桌面Claude文件夹",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: true, sessionPath: "/sessions/current.jsonl" });

    expect(snapshot.shouldRetryLocalMutationContinuation).toBe(true);
    // [BRAIN ROLL 2026-05-05] evaluator 已 stub return null,brain 不替模型决策
    expect(decision).toBeNull();
  });

  it("retries local mutation tasks that produced prose without any real tool call", () => {
    const ss = {
      hasOutput: true,
      hasToolCall: false,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      internalRetryCounts: {},
      lastSuccessfulTools: [],
      originalPromptText: "把我桌面的HTML移动到桌面Claude文件夹",
      effectivePromptText: "把我桌面的HTML移动到桌面Claude文件夹",
    };
    const visible = "根据搜索结果，Claude AI 可以通过 Anthropic 的官方网站获取。";
    const snapshot = createTurnQualitySnapshot(ss, visible);
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: true, sessionPath: "/sessions/current.jsonl", visibleTextBeforeReset: visible });

    expect(snapshot.shouldRetryLocalMutationWithoutTool).toBe(true);
    // [BRAIN ROLL 2026-05-05] evaluator 已 stub return null,brain 不替模型决策
    expect(decision).toBeNull();
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

    // [BRAIN ROLL 2026-05-05] evaluator 已 stub return null,brain 不替模型决策
    expect(decision).toBeNull();
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

    // evaluateForcedTurnFallback 不在 brain v1 nuke 范围内(watchdog forced fallback 仍 active)
    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("工具调用失败");
    expect(decision.text).toContain("live_news");
  });
});
