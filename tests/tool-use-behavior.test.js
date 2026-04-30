import { describe, expect, it } from "vitest";
import {
  TOOL_USE_BEHAVIOR,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
} from "../server/chat/tool-use-behavior.js";

describe("tool-use behavior resolver", () => {
  it("stops immediately for local office direct answers", () => {
    const decision = resolveInitialToolUseBehavior("【DATA-01】华东 Q1 120 Q2 150；华南 Q1 90 Q2 81；华北 Q1 60 Q2 78（万元）。算环比增长率，给 3 条管理建议。");

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.STOP_WITH_DIRECT_ANSWER);
    expect(decision.directAnswer).toContain("25%");
    expect(decision.reason).toBe("local_office_direct_answer");
  });

  it("prefetches realtime report context for non-brain models", () => {
    const decision = resolveInitialToolUseBehavior("今天金价如何？给我最新价格和风险提示。", {
      modelInfo: { isBrain: false },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP);
    expect(decision.reportKind).toBeTruthy();
    expect(decision.toolName).toBeTruthy();
  });

  it("falls back to normal LLM flow when local prefetch is suppressed", () => {
    const decision = resolveInitialToolUseBehavior("不要联网，今天金价如何？只回复：收到", {
      modelInfo: { isBrain: false },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.effectivePromptText).toContain("不要联网");
  });

  it("builds a single augmented prompt after prefetch", () => {
    const prompt = buildPrefetchAugmentedPrompt("原始问题", "证据\n", "预算上下文");
    expect(prompt).toBe("证据\n\n预算上下文\n\n【用户原始问题】\n原始问题");
  });
});
