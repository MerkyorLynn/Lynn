import { describe, expect, it } from "vitest";
import {
  LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER,
  LOCAL_QWEN35_RUNTIME_POLICY,
  LOCAL_QWEN35_TOOL_SCHEMA_LIMIT,
  appendNoThinkHintToLastUserMessage,
  resolveLocalQwen35DirectMaxTokens,
  resolveLocalQwen35DirectThinking,
  shouldRetryLocalQwen35WithoutThinking,
  shouldUseLocalQwen35DirectBridge,
} from "../server/chat/local-qwen35-direct-policy.js";
import { TOOL_USE_BEHAVIOR } from "../server/chat/tool-use-behavior.js";

describe("local Qwen3.5 direct policy", () => {
  it("uses the direct bridge only for small local non-prefetch text requests", () => {
    expect(shouldUseLocalQwen35DirectBridge("hello", {
      isLocalModel: true,
      toolBehavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    })).toBe(true);
    expect(shouldUseLocalQwen35DirectBridge("hello", { isLocalModel: false })).toBe(false);
    expect(shouldUseLocalQwen35DirectBridge("hello", { isLocalModel: true, hasImages: true })).toBe(false);
    expect(shouldUseLocalQwen35DirectBridge("hello", {
      isLocalModel: true,
      toolBehavior: TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP,
    })).toBe(false);
  });

  it("disables thinking and tightens max tokens for lightweight asks", () => {
    expect(resolveLocalQwen35DirectThinking("ping", { getThinkingLevel: () => "high" })).toBe(false);
    expect(resolveLocalQwen35DirectThinking("证明这个复杂算法", { getThinkingLevel: () => "off" })).toBe(false);
    expect(resolveLocalQwen35DirectMaxTokens("ping", false)).toBe(256);
    expect(resolveLocalQwen35DirectMaxTokens("一句话介绍你自己", false)).toBe(1536);
  });

  it("retries with thinking off only for thinking-only local output", () => {
    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: true,
      assistantText: "",
      reasoningText: "Thinking Process...",
    })).toBe(true);

    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: true,
      assistantText: "正文",
      reasoningText: "思考",
    })).toBe(false);

    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: false,
      assistantText: "",
      reasoningText: "思考",
    })).toBe(false);
  });

  it("adds one no-think hint to the latest user message", () => {
    const messages = [
      { role: "user", content: "上一轮" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "杭州滨江有什么好吃的吗" },
    ];

    appendNoThinkHintToLastUserMessage(messages);
    appendNoThinkHintToLastUserMessage(messages);

    expect(messages[0].content).toBe("上一轮");
    expect(messages[2].content).toBe("杭州滨江有什么好吃的吗\n/no_think");
  });

  it("keeps the local 9B runtime opt-in and small-context by default", () => {
    expect(LOCAL_QWEN35_RUNTIME_POLICY.warmPoolDefault).toBe(false);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.idleUnload).toBe(true);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.kvCacheReuse).toBe(true);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.stablePrefix).toBe(true);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.maxHistoryMessages).toBeLessThanOrEqual(8);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.maxHistoryChars).toBeLessThanOrEqual(8000);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.toolSchemaLimit).toBe(LOCAL_QWEN35_TOOL_SCHEMA_LIMIT);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.toolSchemaLimit).toBeGreaterThanOrEqual(3);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.toolSchemaLimit).toBeLessThanOrEqual(5);
    expect(LOCAL_QWEN35_RUNTIME_POLICY.failureFallbackProvider).toBe("step-3.7-flash");
    expect(LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER).toBe("step-3.7-flash");
  });
});
