import { describe, expect, it } from "vitest";

import {
  buildEmptyReplyFallbackText,
  buildEmptyReplyRetryPrompt,
  buildShortLeadInRetryPrompt,
  buildLocalMutationContinuationRetryPrompt,
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

  it("builds an empty-reply recovery prompt that forces a visible answer", () => {
    const prompt = buildEmptyReplyRetryPrompt("你知道 Qwen-Image-Layered 吗？", "chat");

    expect(prompt).toContain("补救回答");
    expect(prompt).toContain("必须产出用户可见的最终答案");
    expect(prompt).toContain("不要调用工具");
    expect(prompt).toContain("你知道 X");
    expect(prompt).toContain("Qwen-Image-Layered");
    expect(prompt).not.toContain("本轮模型没有生成可见答案");
  });

  it("builds a lead-in recovery prompt that blocks another lookup-only answer", () => {
    const prompt = buildShortLeadInRetryPrompt("你知道 Qwen-Image-Layered 吗？", "让我查一下这个最新的信息。");

    expect(prompt).toContain("补救回答");
    expect(prompt).toContain("必须产出用户可见的最终内容");
    expect(prompt).toContain("不要再说");
    expect(prompt).toContain("让我查一下");
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

  it("adds known folder aliases and delete safety to local mutation retry prompts", () => {
    const prompt = "请把下载文件夹的所有后缀 zip 的文件都删除";
    const retryPrompt = buildLocalMutationContinuationRetryPrompt(prompt, "找到2个 zip 文件，现在删除。", [
      {
        name: "bash",
        command: "find ~/Downloads -maxdepth 1 -type f -iname '*.zip'",
      },
    ]);

    expect(retryPrompt).toContain("下载文件夹 / Downloads");
    expect(retryPrompt).toContain("删除任务安全要求");
    expect(retryPrompt).toContain("find ~/Downloads");
    expect(retryPrompt).toContain(prompt);
  });

  it("does not show pseudo_tool_after_retry for local delete task fallback", () => {
    const fallback = buildEmptyReplyFallbackText({
      pseudoToolSteered: true,
      originalPromptText: "请把下载文件夹的所有后缀 zip 的文件都删除",
      effectivePromptText: "请把下载文件夹的所有后缀 zip 的文件都删除",
    });

    expect(fallback).toContain("本地文件任务没有真正完成");
    expect(fallback).toContain("下载文件夹 / Downloads");
    expect(fallback).toContain("确认删除");
    expect(fallback).not.toContain("pseudo_tool_after_retry");
  });

  it("does not expose internal route intent labels in generic empty-reply fallback", () => {
    const fallback = buildEmptyReplyFallbackText({
      routeIntent: "chat",
      originalPromptText: "时间",
      effectivePromptText: "时间",
    });

    expect(fallback).toContain("本轮模型没有生成可见答案");
    expect(fallback).not.toContain("类型：");
    expect(fallback).not.toContain("Kind:");
    expect(fallback).not.toContain("chat");
  });

  it("uses a specific fallback for vision empty replies", () => {
    const fallback = buildEmptyReplyFallbackText({
      routeIntent: "vision",
      originalPromptText: "请看图",
      effectivePromptText: "请看图",
    });

    expect(fallback).toContain("图片没有被模型可靠识别到");
    expect(fallback).not.toContain("类型：");
  });
});
