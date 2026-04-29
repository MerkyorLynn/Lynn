import { describe, expect, it } from "vitest";
import {
  buildSuccessfulToolNoTextFallback,
  buildTruncatedStructuredRetryPrompt,
  looksLikeTruncatedStructuredAnswer,
} from "../server/chat/turn-retry-policy.js";

describe("turn retry policy", () => {
  it("detects an answer truncated at a markdown table separator", () => {
    const visible = [
      "**环比增长率计算**",
      "",
      "| 区域 | Q1（万元） | Q2（万元） | 环比增长率 |",
      "|------|-----------",
    ].join("\n");

    expect(looksLikeTruncatedStructuredAnswer(visible, "")).toBe(true);
  });

  it("detects hidden-reflect-heavy output with only a short structured visible prefix", () => {
    const raw = `${"<reflect>内部推理。".repeat(20)}</reflect>\n\n**环比增长率计算**\n\n| 区域 | Q1 | Q2 |`;
    const visible = "**环比增长率计算**\n\n| 区域 | Q1 | Q2 |";

    expect(looksLikeTruncatedStructuredAnswer(visible, raw)).toBe(true);
  });

  it("does not retry a complete short answer", () => {
    const visible = "华东增长 25%，华南下降 10%，华北增长 30%。建议：稳华东、修复华南、验证华北增长来源。";

    expect(looksLikeTruncatedStructuredAnswer(visible, visible)).toBe(false);
  });

  it("builds a retry prompt that asks for a complete final answer", () => {
    const prompt = buildTruncatedStructuredRetryPrompt("算增长率", "|------|");

    expect(prompt).toContain("结构化答案");
    expect(prompt).toContain("完整最终答案");
    expect(prompt).toContain("算增长率");
  });

  it("builds visible fallback text when a successful non-local tool produced no final answer", () => {
    const fallback = buildSuccessfulToolNoTextFallback({
      lastSuccessfulTools: [
        {
          name: "weather",
          outputPreview: "上海 2026-04-29 天气：小雨，18-22°C。",
        },
      ],
    });

    expect(fallback).toContain("工具已成功执行");
    expect(fallback).toContain("weather");
    expect(fallback).toContain("上海");
  });
});
