import { describe, expect, it } from "vitest";

import {
  buildEmptyReplyFallbackText,
  buildEmptyReplyRetryPrompt,
  buildPostRehydrateEscalationPrompt,
  buildShortLeadInRetryPrompt,
  buildLocalMutationContinuationRetryPrompt,
  buildSuccessfulToolNoTextFallback,
  buildTruncatedStructuredRetryPrompt,
  clearPendingMutationOnSuccessfulDelete,
  commandLooksLikeDelete,
  consumeMutationConfirmation,
  looksLikeTruncatedStructuredAnswer,
  recordPendingDeleteRequest,
  stripRouteMetadataLeaks,
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

  it("records pendingMutationContext on the session when delete fallback fires", () => {
    const ss = {
      pseudoToolSteered: true,
      originalPromptText: "请把下载文件夹的所有后缀 zip 的文件都删除",
      effectivePromptText: "请把下载文件夹的所有后缀 zip 的文件都删除",
    };

    const fallback = buildEmptyReplyFallbackText(ss);

    expect(fallback).toContain("确认删除");
    expect(ss.pendingMutationContext).toBeTruthy();
    expect(ss.pendingMutationContext.originalPrompt).toBe("请把下载文件夹的所有后缀 zip 的文件都删除");
    expect(ss.pendingMutationContext.requirement?.requiresDelete).toBe(true);
    expect(typeof ss.pendingMutationContext.recordedAt).toBe("number");
  });

  it("does not record pendingMutationContext for non-delete local mutations", () => {
    const ss = {
      pseudoToolSteered: true,
      originalPromptText: "请把桌面的截图都移动到下载文件夹",
      effectivePromptText: "请把桌面的截图都移动到下载文件夹",
    };

    buildEmptyReplyFallbackText(ss);

    expect(ss.pendingMutationContext).toBeUndefined();
  });

  it("consumeMutationConfirmation returns retry prompt when user replies 确认删除", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "请把下载文件夹的所有后缀 zip 的文件都删除",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    };

    const result = consumeMutationConfirmation(ss, "确认删除");

    expect(result).toBeTruthy();
    expect(result.originalPrompt).toBe("请把下载文件夹的所有后缀 zip 的文件都删除");
    expect(result.retryPrompt).toContain("严格执行要求");
    expect(result.retryPrompt).toContain("下载文件夹 / Downloads");
    expect(result.retryPrompt).toContain("删除任务安全要求");
    expect(result.retryPrompt).toContain("请把下载文件夹的所有后缀 zip 的文件都删除");
    expect(ss.pendingMutationContext).toBeNull();
  });

  it("consumeMutationConfirmation accepts common confirmation phrases", () => {
    for (const phrase of ["确认", "确认删除", "确认执行", "是", "好的", "可以", "yes", "y", "Confirm Delete", "go ahead", "proceed"]) {
      const ss = {
        pendingMutationContext: {
          originalPrompt: "删除下载里的 zip",
          requirement: { requiresDelete: true },
          recordedAt: Date.now(),
        },
      };
      const result = consumeMutationConfirmation(ss, phrase);
      expect(result, `phrase="${phrase}"`).toBeTruthy();
      expect(result.originalPrompt).toBe("删除下载里的 zip");
    }
  });

  it("consumeMutationConfirmation rejects unrelated user input and keeps context", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    };

    expect(consumeMutationConfirmation(ss, "再想想")).toBeNull();
    expect(consumeMutationConfirmation(ss, "我先看看文件列表")).toBeNull();
    expect(consumeMutationConfirmation(ss, "")).toBeNull();
    expect(ss.pendingMutationContext).toBeTruthy();
  });

  it("consumeMutationConfirmation returns null and clears expired context", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now() - 30 * 60 * 1000,
      },
    };

    const result = consumeMutationConfirmation(ss, "确认删除");

    expect(result).toBeNull();
    expect(ss.pendingMutationContext).toBeNull();
  });

  it("consumeMutationConfirmation no-ops without pendingMutationContext", () => {
    expect(consumeMutationConfirmation({}, "确认删除")).toBeNull();
    expect(consumeMutationConfirmation(null, "确认删除")).toBeNull();
  });

  it("recordPendingDeleteRequest stores context for delete prompts", () => {
    const ss = {};
    expect(recordPendingDeleteRequest(ss, "请把下载文件夹的所有 zip 文件删除")).toBe(true);
    expect(ss.pendingMutationContext?.requirement?.requiresDelete).toBe(true);
    expect(ss.pendingMutationContext?.originalPrompt).toBe("请把下载文件夹的所有 zip 文件删除");
  });

  it("recordPendingDeleteRequest skips non-delete prompts", () => {
    const ss = {};
    expect(recordPendingDeleteRequest(ss, "把桌面截图移动到下载文件夹")).toBe(false);
    expect(ss.pendingMutationContext).toBeUndefined();
    expect(recordPendingDeleteRequest(ss, "你好")).toBe(false);
    expect(ss.pendingMutationContext).toBeUndefined();
  });

  it("clearPendingMutationOnSuccessfulDelete clears context for rm/trash commands", () => {
    const baseCtx = () => ({
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    });
    for (const command of [
      "rm -f /tmp/foo.zip",
      "rm -rf /tmp/lynn-bug-test/*.zip",
      "trash ~/Downloads/old.zip",
      "find ~/Downloads -name '*.zip' -delete",
    ]) {
      const ss = baseCtx();
      expect(clearPendingMutationOnSuccessfulDelete(ss, command), `command="${command}"`).toBe(true);
      expect(ss.pendingMutationContext).toBeNull();
    }
  });

  it("clearPendingMutationOnSuccessfulDelete leaves non-delete commands alone", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    };
    for (const command of ["ls -la", "find ~/Downloads -name '*.zip'", "echo hello", "cat foo.txt"]) {
      expect(clearPendingMutationOnSuccessfulDelete(ss, command), `command="${command}"`).toBe(false);
    }
    expect(ss.pendingMutationContext).toBeTruthy();
  });

  it("buildPostRehydrateEscalationPrompt forces a real bash tool call, no narration", () => {
    const prompt = buildPostRehydrateEscalationPrompt("请把下载文件夹的 zip 都删除");

    expect(prompt).toContain("严重升级");
    expect(prompt).toContain("调用 bash 工具");
    expect(prompt).toContain("不要再输出任何前置说明");
    expect(prompt).toContain("禁止");
    expect(prompt).toContain("placeholder");
    expect(prompt).toContain("嘴炮");
    expect(prompt).toContain("下载文件夹 / Downloads");
    expect(prompt).toContain("请把下载文件夹的 zip 都删除");
  });

  it("commandLooksLikeDelete recognises rm / trash / find -delete forms", () => {
    expect(commandLooksLikeDelete("rm -rf /tmp/x")).toBe(true);
    expect(commandLooksLikeDelete("trash ~/Downloads/old.zip")).toBe(true);
    expect(commandLooksLikeDelete("find . -name '*.tmp' -delete")).toBe(true);
    expect(commandLooksLikeDelete("find /tmp -type f -iname '*.zip' -delete")).toBe(true);
    expect(commandLooksLikeDelete("ls -la")).toBe(false);
    expect(commandLooksLikeDelete("find /tmp -name '*.zip'")).toBe(false);
    expect(commandLooksLikeDelete("")).toBe(false);
  });

  it("buildEmptyReplyRetryPrompt does not embed route intent metadata that brain can echo", () => {
    for (const route of ["chat", "utility", "utility_large", "vision", "writing", "research"]) {
      const prompt = buildEmptyReplyRetryPrompt("帮我整理中国各个私董会的价格、人数、特点", route);
      expect(prompt, `route=${route}`).not.toMatch(/任务类型\s*[:：]\s*(?:chat|utility|utility_large|vision|writing|research)/);
      expect(prompt, `route=${route}`).not.toMatch(/Route\s*[:：]\s*(?:chat|utility|utility_large|vision|writing|research)/);
    }
  });

  it("stripRouteMetadataLeaks scrubs echoed Chinese/English route labels", () => {
    const cases = [
      ["这是回答正文。\n类型: utility", "这是回答正文。"],
      ["回答完毕。\n任务类型：utility_large\n", "回答完毕。\n"],
      ["Some answer.\nRoute: research\n", "Some answer.\n"],
      ["Answer.\nKind: vision", "Answer."],
    ];
    for (const [input, expected] of cases) {
      expect(stripRouteMetadataLeaks(input).trim()).toBe(expected.trim());
    }
  });

  it("stripRouteMetadataLeaks leaves benign content untouched", () => {
    expect(stripRouteMetadataLeaks("这是一篇关于私董会的分析。")).toBe("这是一篇关于私董会的分析。");
    expect(stripRouteMetadataLeaks("订单类型: 加急")).toBe("订单类型: 加急"); // not a route metadata leak
    expect(stripRouteMetadataLeaks("")).toBe("");
  });
});
