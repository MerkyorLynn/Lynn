import { getLocale } from "../i18n.js";
import { buildPseudoToolRetryPrompt } from "./chat-recovery.js";
import { canScheduleInternalRetry } from "./internal-retry.js";
import {
  LOCAL_COMPLETION_TOOLS,
  buildEmptyReplyFallbackText,
  buildEmptyReplyRetryPrompt,
  buildCodingDiagnosticVerificationAppend,
  buildFailedToolFallbackText,
  buildLocalMutationContinuationRetryPrompt,
  buildLocalToolSuccessFallback,
  buildShortLeadInRetryPrompt,
  buildSuccessfulToolNoTextFallback,
  buildToolContinuationRetryPrompt,
  buildToolFailedRetryPrompt,
  buildTruncatedStructuredRetryPrompt,
  classifyRequestedLocalMutation,
  looksLikeTruncatedStructuredAnswer,
  shouldRetryUnverifiedLocalMutation,
} from "./turn-retry-policy.js";
import { looksLikePendingToolExecutionText } from "../../shared/task-route-intent.js";

const PENDING_LANGUAGE_RE = /(?:再抓取|进一步|尚未提取|还需|稍后|still fetching|incomplete|unable to extract|let me (?:try|check|fetch|search) again)/i;
const SHORT_LEADIN_RE = /(?:先读一下|先看一下|先查一下|先搜索|先检索|先检查|先确认|先定位|定位一下|看看相关文件|我先.{0,12}(?:查|搜|看|确认|获取|检索|定位)|接下来|我将|我会|我来|让我先|准备|ensure|make sure)/i;
const TOOL_FAILED_LEADIN_RE = /(?:两个任务|多个任务|一起处理|同时处理|我来搜索|让我搜索|开始搜索|开始查|开始处理|来查找|来找|来看|来分析|来帮你|马上来|稍等|let me (?:search|fetch|find|look)|i'?ll (?:search|check|look|fetch))/i;
const LOCAL_MUTATION_LEADIN_RE = /(?:我来帮你|我来处理|我来执行|让我先|让我再|先查找|先检查|先列出|先确认|先创建|先执行|开始处理|搜索到的信息|查找当前|查看当前|接下来会|准备(?:创建|移动|整理|处理)|let me (?:check|list|find|handle)|i'?ll (?:check|list|find|handle))/i;
const GENERIC_ACK_RE = /^(?:好(?:的|了)?|收到|明白|可以|ok(?:ay)?|sure|done)[。.!！\s]*$/i;
const CODING_DIAGNOSTIC_PROMPT_RE = /(?:traceback|importerror|cannot import|main\.py|comfyui|代码|报错|导入失败|修复)/i;

function promptText(ss) {
  return ss?.effectivePromptText || ss?.originalPromptText || "";
}

function retryDecision({
  reason,
  prompt,
  logLevel = "warn",
  logMessage = "",
  markPendingToolRetryAttempted = false,
  markToolFailedFallbackRetryAttempted = false,
}) {
  return {
    type: "retry",
    reason,
    prompt,
    logLevel,
    logMessage,
    markPendingToolRetryAttempted,
    markToolFailedFallbackRetryAttempted,
  };
}

function fallbackDecision({ text, logLevel = "warn", logMessage = "" }) {
  return { type: "fallback", text, logLevel, logMessage };
}

function markDecision({ flag, logLevel = "log", logMessage = "" }) {
  return { type: "mark", flag, logLevel, logMessage };
}

function buildSuppressedPseudoToolFallbackText() {
  return getLocale().startsWith("zh")
    ? "模型输出了无效工具标记，Lynn 已拦截这段内容；本轮没有执行未确认操作。请直接重试一次，或把任务说得更具体一点。"
    : "The model emitted invalid tool markup. Lynn blocked it and did not execute any unconfirmed action. Please retry or make the task more specific.";
}

export function createTurnQualitySnapshot(ss, visibleTextBeforeReset) {
  const visibleTrimmed = String(visibleTextBeforeReset || "").trim();
  const visibleLen = visibleTrimmed.length;
  const successfulTools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const hasAnyToolCall = !!(ss?.hasToolCall || ss?.hasPrefetchToolCall || successfulTools.length > 0 || ss?.hasFailedTool);
  const original = ss?.originalPromptText || ss?.effectivePromptText || "";
  const localMutationRequest = classifyRequestedLocalMutation(original);

  const shouldRetryPendingToolText =
    !ss?.pendingToolRetryAttempted &&
    canScheduleInternalRetry(ss, "pending_tool_text") &&
    !ss?.hasToolCall &&
    looksLikePendingToolExecutionText(visibleTextBeforeReset, ss?.routeIntent);

  const isIncompletePending = visibleLen > 0 && visibleLen < 80 && PENDING_LANGUAGE_RE.test(visibleTrimmed);
  const isShortLeadInOnly = visibleLen > 0 && visibleLen < 120 && !ss?.hasToolCall && SHORT_LEADIN_RE.test(visibleTrimmed);
  const isTruncatedStructuredAnswer =
    visibleLen > 0 &&
    !ss?.hasToolCall &&
    looksLikeTruncatedStructuredAnswer(visibleTextBeforeReset, ss?.rawTextAcc);
  const isLocalMutationLeadInOnly =
    visibleLen > 0 &&
    visibleLen < 220 &&
    !ss?.hasToolCall &&
    Boolean(localMutationRequest) &&
    LOCAL_MUTATION_LEADIN_RE.test(visibleTrimmed);
  const shouldRetryLocalMutationWithoutTool =
    visibleLen > 0 &&
    visibleLen < 2400 &&
    !ss?.hasToolCall &&
    !hasAnyToolCall &&
    !ss?.pendingToolRetryAttempted &&
    Boolean(localMutationRequest) &&
    canScheduleInternalRetry(ss, "local_mutation_no_tool");
  const isToolDidNotProduceText = hasAnyToolCall && visibleLen < 5;
  const isToolSuccessMissingAnswer =
    successfulTools.length > 0 &&
    !ss?.hasFailedTool &&
    (visibleLen < 5 || (visibleLen < 30 && GENERIC_ACK_RE.test(visibleTrimmed)));
  const isToolSuccessLeadInOnly =
    successfulTools.length > 0 &&
    !ss?.hasFailedTool &&
    visibleLen > 0 &&
    visibleLen < 120 &&
    SHORT_LEADIN_RE.test(visibleTrimmed);
  const isPseudoToolNoOutput =
    ss?.pseudoToolSteered &&
    visibleLen < 5 &&
    !ss?.hasToolCall &&
    !ss?.hasError;
  const isToolFailedShortAnswer =
    ss?.hasFailedTool &&
    visibleLen < 80 &&
    (visibleLen < 30 || SHORT_LEADIN_RE.test(visibleTrimmed) || TOOL_FAILED_LEADIN_RE.test(visibleTrimmed));
  const isThinkingOnlyNoOutput = ss?.hasThinking && !ss?.hasOutput && !ss?.hasError;
  const hasSuccessfulLocalTool = successfulTools.some((tool) => LOCAL_COMPLETION_TOOLS.has(tool.name));
  const localToolSuccessFallback = hasSuccessfulLocalTool && isToolSuccessMissingAnswer
    ? buildLocalToolSuccessFallback(ss)
    : "";
  const successfulToolNoTextFallback = !localToolSuccessFallback && isToolSuccessMissingAnswer
    ? buildSuccessfulToolNoTextFallback(ss)
    : "";
  const toolSuccessFallback = localToolSuccessFallback || successfulToolNoTextFallback;
  const isCodingDiagnosticMissingVerification =
    visibleLen > 120 &&
    CODING_DIAGNOSTIC_PROMPT_RE.test(original) &&
    !/python\s+main\.py/i.test(visibleTrimmed) &&
    !/(?:请运行验证|run (?:the )?verification|verify by running)/i.test(visibleTrimmed);

  const shouldRetryToolFinalize =
    !ss?.hasError &&
    (isToolDidNotProduceText || isToolSuccessLeadInOnly) &&
    !ss?.hasFailedTool &&
    !toolSuccessFallback &&
    !ss?.toolFinalizationRetryAttempted &&
    canScheduleInternalRetry(ss, "tool_finalization");
  const canRetryToolContinuation =
    !ss?.hasError &&
    ss?.hasToolCall &&
    !ss?.pendingToolRetryAttempted &&
    canScheduleInternalRetry(ss, "tool_continuation");
  const shouldRetryLocalMutationContinuation =
    canRetryToolContinuation &&
    shouldRetryUnverifiedLocalMutation(ss, visibleTextBeforeReset);
  const shouldRetryToolContinuation =
    canRetryToolContinuation &&
    (looksLikePendingToolExecutionText(visibleTextBeforeReset, ss?.routeIntent) || shouldRetryLocalMutationContinuation);

  const fallbackKind = isToolDidNotProduceText ? "tool_no_final_text_after_retry"
    : isIncompletePending ? "incomplete_pending"
    : "thinking_only";

  return {
    visibleTrimmed,
    visibleLen,
    successfulTools,
    hasAnyToolCall,
    shouldRetryPendingToolText,
    isIncompletePending,
    isShortLeadInOnly,
    isTruncatedStructuredAnswer,
    isLocalMutationLeadInOnly,
    shouldRetryLocalMutationWithoutTool,
    isToolDidNotProduceText,
    isToolSuccessMissingAnswer,
    isToolSuccessLeadInOnly,
    isPseudoToolNoOutput,
    isToolFailedShortAnswer,
    isThinkingOnlyNoOutput,
    localToolSuccessFallback,
    successfulToolNoTextFallback,
    toolSuccessFallback,
    isCodingDiagnosticMissingVerification,
    shouldRetryToolFinalize,
    shouldRetryLocalMutationContinuation,
    shouldRetryToolContinuation,
    fallbackKind,
  };
}

const PRE_TURN_END_RULES = [
  {
    name: "empty_reply",
    priority: 100,
    guard: ({ ss, snapshot }) =>
      !ss.hasOutput &&
      !snapshot.hasAnyToolCall &&
      !ss.hasThinking &&
      !ss.hasError &&
      !ss.hasFailedTool,
    action: ({ ss, isActive, sessionPath }) => {
      if (ss.pseudoToolRecoveryHandled && !ss.pseudoToolSteered) {
        return fallbackDecision({
          text: buildSuppressedPseudoToolFallbackText(),
          logMessage: `[PSEUDO-TOOL-SUPPRESSED-FALLBACK v1] emitted visible fallback without client retry · session=${sessionPath}`,
        });
      }
      if (isActive && ss.pseudoToolSteered && canScheduleInternalRetry(ss, "pseudo_tool_text")) {
        return retryDecision({
          reason: "pseudo_tool_text",
          prompt: buildPseudoToolRetryPrompt(promptText(ss)),
          logMessage: `[PSEUDO-TOOL-EMPTY-RETRY v1] scheduled · session=${sessionPath}`,
        });
      }
      if (isActive && canScheduleInternalRetry(ss, "empty_reply")) {
        return retryDecision({
          reason: "empty_reply",
          prompt: buildEmptyReplyRetryPrompt(promptText(ss), ss.routeIntent),
          logMessage: `[EMPTY-REPLY-RETRY v1] scheduled · session=${sessionPath}`,
        });
      }
      return fallbackDecision({
        text: buildEmptyReplyFallbackText(ss),
        logMessage: `[EMPTY-REPLY-FALLBACK v2] emitted visible fallback · session=${sessionPath}`,
      });
    },
  },
  {
    name: "local_mutation_continuation_after_tool",
    priority: 180,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.shouldRetryLocalMutationContinuation,
    action: ({ ss, snapshot, visibleTextBeforeReset, sessionPath }) => retryDecision({
      reason: "tool_continuation",
      prompt: buildLocalMutationContinuationRetryPrompt(
        promptText(ss),
        visibleTextBeforeReset,
        ss.lastSuccessfulTools || [],
      ),
      markPendingToolRetryAttempted: true,
      logMessage: `[LOCAL-MUTATION-CONTINUATION v1] scheduled · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    }),
  },
  {
    name: "local_mutation_no_tool",
    priority: 190,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.shouldRetryLocalMutationWithoutTool,
    action: ({ ss, snapshot, visibleTextBeforeReset, sessionPath }) => retryDecision({
      reason: "local_mutation_no_tool",
      prompt: buildLocalMutationContinuationRetryPrompt(
        promptText(ss),
        visibleTextBeforeReset,
        ss.lastSuccessfulTools || [],
      ),
      logMessage: `[LOCAL-MUTATION-NO-TOOL v1] scheduled · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    }),
  },
  {
    name: "tool_success_fallback",
    priority: 200,
    guard: ({ ss, snapshot }) =>
      !ss.hasError &&
      !snapshot.shouldRetryLocalMutationContinuation &&
      Boolean(snapshot.toolSuccessFallback),
    action: ({ ss, snapshot, sessionPath }) => fallbackDecision({
      text: snapshot.toolSuccessFallback,
      logMessage: `[TOOL-SUCCESS-FALLBACK v2] emitted · local=${snapshot.localToolSuccessFallback ? "true" : "false"} tools=${(ss.lastSuccessfulTools || []).map(t => t.name).join(",")} · ${sessionPath}`,
    }),
  },
  {
    name: "tool_finalize_retry_marker",
    priority: 300,
    guard: ({ snapshot, isActive }) => isActive && snapshot.shouldRetryToolFinalize,
    action: ({ sessionPath }) => markDecision({
      flag: "toolFinalizationRetryAttempted",
      logLevel: "log",
      logMessage: `[TOOL-FINALIZE-RETRY v1] will retry · session=${sessionPath}`,
    }),
  },
  {
    name: "pseudo_tool_no_output",
    priority: 400,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.isPseudoToolNoOutput &&
      canScheduleInternalRetry(ss, "pseudo_tool_text"),
    action: ({ ss, sessionPath }) => retryDecision({
      reason: "pseudo_tool_text",
      prompt: buildPseudoToolRetryPrompt(promptText(ss)),
      logMessage: `[PSEUDO-TOOL-NO-OUTPUT-RETRY v1] scheduled · session=${sessionPath}`,
    }),
  },
  {
    name: "local_mutation_leadin",
    priority: 500,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.isLocalMutationLeadInOnly &&
      canScheduleInternalRetry(ss, "local_mutation_leadin"),
    action: ({ ss, snapshot, visibleTextBeforeReset, sessionPath }) => retryDecision({
      reason: "local_mutation_leadin",
      prompt: buildLocalMutationContinuationRetryPrompt(
        promptText(ss),
        visibleTextBeforeReset,
        ss.lastSuccessfulTools || [],
      ),
      logMessage: `[LOCAL-MUTATION-LEADIN-RETRY v1] scheduled · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    }),
  },
  {
    name: "pending_tool_text",
    priority: 600,
    guard: ({ ss, snapshot, isActive }) => isActive && !ss.hasError && snapshot.shouldRetryPendingToolText,
    action: ({ ss, snapshot, sessionPath }) => retryDecision({
      reason: "pending_tool_text",
      prompt: buildPseudoToolRetryPrompt(promptText(ss)),
      markPendingToolRetryAttempted: true,
      logMessage: `[PENDING-TOOL-TEXT-RETRY v2] scheduled · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    }),
  },
  {
    name: "short_leadin",
    priority: 700,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.isShortLeadInOnly &&
      !snapshot.isLocalMutationLeadInOnly &&
      canScheduleInternalRetry(ss, "short_leadin"),
    action: ({ ss, visibleTextBeforeReset, sessionPath }) => retryDecision({
      reason: "short_leadin",
      prompt: buildShortLeadInRetryPrompt(promptText(ss), visibleTextBeforeReset),
      logMessage: `[SHORT-LEADIN-RETRY v1] scheduled · visibleLen=${String(visibleTextBeforeReset || "").trim().length} · session=${sessionPath}`,
    }),
  },
  {
    name: "truncated_structured_answer",
    priority: 800,
    guard: ({ ss, snapshot, isActive }) =>
      isActive &&
      !ss.hasError &&
      snapshot.isTruncatedStructuredAnswer &&
      canScheduleInternalRetry(ss, "truncated_structured_answer"),
    action: ({ ss, snapshot, visibleTextBeforeReset, sessionPath }) => retryDecision({
      reason: "truncated_structured_answer",
      prompt: buildTruncatedStructuredRetryPrompt(promptText(ss), visibleTextBeforeReset),
      logMessage: `[TRUNCATED-STRUCTURED-RETRY v1] scheduled · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    }),
  },
  {
    name: "tool_failed_fallback",
    priority: 900,
    guard: ({ ss, snapshot }) =>
      snapshot.isToolFailedShortAnswer,
    action: ({ ss, snapshot, isActive, visibleTextBeforeReset, sessionPath }) => {
      if (isActive && !ss.toolFailedFallbackRetryAttempted && canScheduleInternalRetry(ss, "tool_failed_fallback")) {
        return retryDecision({
          reason: "tool_failed_fallback",
          prompt: buildToolFailedRetryPrompt(
            promptText(ss),
            visibleTextBeforeReset,
            ss.lastFailedTools || [],
          ),
          markToolFailedFallbackRetryAttempted: true,
          logMessage: `[TOOL-FAILED-FALLBACK v1] scheduled · visibleLen=${snapshot.visibleLen} failedTools=${(ss.lastFailedTools || []).join(",")} · session=${sessionPath}`,
        });
      }
      return fallbackDecision({
        text: buildFailedToolFallbackText(ss),
        logMessage: `[TOOL-FAILED-FALLBACK v2] emitted visible fallback · visibleLen=${snapshot.visibleLen} failedTools=${(ss.lastFailedTools || []).join(",")} · session=${sessionPath}`,
      });
    },
  },
  {
    name: "coding_diagnostic_verification_append",
    priority: 950,
    guard: ({ snapshot }) => snapshot.isCodingDiagnosticMissingVerification,
    action: ({ ss, sessionPath }) => fallbackDecision({
      text: buildCodingDiagnosticVerificationAppend(ss),
      logLevel: "log",
      logMessage: `[CODING-VERIFY-APPEND v1] appended verification command · session=${sessionPath}`,
    }),
  },
  {
    name: "flow_fallback",
    priority: 1000,
    guard: ({ ss, snapshot }) =>
      !ss.hasError &&
      (snapshot.isIncompletePending ||
        snapshot.isThinkingOnlyNoOutput ||
        (snapshot.isToolDidNotProduceText && ss.toolFinalizationRetryAttempted)),
    action: ({ ss, snapshot, sessionPath }) => {
      const localFallbackMsg = ss.pseudoToolRecoveryHandled && !ss.pseudoToolSteered
        ? buildSuppressedPseudoToolFallbackText()
        : ss.pseudoToolSteered
          ? buildEmptyReplyFallbackText(ss)
          : "";
      const text = localFallbackMsg || (getLocale().startsWith("zh")
        ? "本轮工具已执行，但未能整合出明确答案（原因：流程提前结束）。建议重新提问或换个说法。"
        : "Tools executed but the final answer could not be assembled because the flow ended early. Please rephrase or try again.");
      return fallbackDecision({
        text,
        logMessage: `[EMPTY-REPLY-FALLBACK v1] emitted (${snapshot.fallbackKind}) · visibleLen=${snapshot.visibleLen} hasToolCall=${ss.hasToolCall} hasThinking=${ss.hasThinking} · ${sessionPath}`,
      });
    },
  },
];

export const __turnQualityRulesForTest = PRE_TURN_END_RULES.map(({ name, priority }) => ({ name, priority }));

export function evaluatePreTurnEndQuality(ss, snapshot, { isActive = false, sessionPath = "", visibleTextBeforeReset = "" } = {}) {
  for (const rule of PRE_TURN_END_RULES) {
    if (rule.guard({ ss, snapshot, isActive, visibleTextBeforeReset, sessionPath })) {
      return rule.action({ ss, snapshot, isActive, visibleTextBeforeReset, sessionPath });
    }
  }
  return null;
}

export function evaluatePostTurnEndQuality(ss, snapshot, { internalRetry = null, sessionPath = "", visibleTextBeforeReset = "" } = {}) {
  if (internalRetry) return null;

  if (snapshot.shouldRetryPendingToolText) {
    return retryDecision({
      reason: "pending_tool_text",
      prompt: buildPseudoToolRetryPrompt(promptText(ss)),
      markPendingToolRetryAttempted: true,
    });
  }

  if (snapshot.shouldRetryToolContinuation) {
    return retryDecision({
      reason: "tool_continuation",
      prompt: snapshot.shouldRetryLocalMutationContinuation
        ? buildLocalMutationContinuationRetryPrompt(
          promptText(ss),
          visibleTextBeforeReset,
          ss.lastSuccessfulTools || [],
        )
        : buildToolContinuationRetryPrompt(
          promptText(ss),
          visibleTextBeforeReset,
        ),
      markPendingToolRetryAttempted: true,
      logMessage: `[TOOL-CONTINUATION-RETRY v1] triggered · localMutation=${snapshot.shouldRetryLocalMutationContinuation ? "true" : "false"} · visibleLen=${snapshot.visibleLen} · session=${sessionPath}`,
    });
  }

  if (snapshot.shouldRetryToolFinalize) {
    const isCodingRoute = /(?:coding|code|代码|debug|fix|修复)/i.test(String(ss?.routeIntent || ""))
      || /(?:代码|报错|traceback|importerror|main\.py|npm test|pytest|python)/i.test(promptText(ss));
    const retryPrompt = isCodingRoute
      ? (getLocale().startsWith("zh")
        ? [
            "[系统提示] 上面工具已经执行成功并拿到真实结果(在本次对话历史中)，但上一段只停在“先看/先定位/准备检查”的开场，没有给用户最终修复建议。",
            "现在不要再调用任何工具。请直接基于工具结果给最终答复，必须包含：",
            "1. 根因判断；",
            "2. 用户应该修改/检查的文件或代码位置；",
            "3. 一条可复制的验证命令，必须明确写出 `python main.py`；",
            "4. 明确提示用户：请运行验证。",
            "没有真实修改文件时，不要说“已修复”“应该好了”“这下能跑了”。",
          ].join("\n")
        : [
            "[System] The tools above executed successfully and returned real results, but the previous visible answer stopped at a lead-in instead of giving a final fix recommendation.",
            "Do not call any more tools. Use the tool results to give the final answer and include:",
            "1. Root cause;",
            "2. Which file/code location the user should inspect or change;",
            "3. A copyable verification command, explicitly including `python main.py`;",
            "4. Explicitly ask the user to run the verification.",
            "If no real file was changed, do not claim it is fixed.",
          ].join("\n"))
      : (getLocale().startsWith("zh")
      ? "[系统提示] 上面工具已经执行成功并拿到真实结果(在本次对话历史中)。请基于这些工具结果直接给用户最终答案 · 综合推理和结论。不要再调用任何工具 · 不要重复工具 raw output 的数据 · 直接给简洁可读的最终回答。"
      : "[System] The tools above executed successfully and returned real results (in this conversation history). Use those results to give the user the final answer directly — synthesize and conclude. Do not call any more tools. Do not restate raw tool output; produce a concise, readable final answer.");
    return retryDecision({
      reason: "tool_finalization",
      prompt: retryPrompt,
      logLevel: "log",
      logMessage: `[TOOL-FINALIZE-RETRY v1] triggered · session=${sessionPath}`,
    });
  }

  return null;
}

export function evaluateForcedTurnFallback(ss, snapshot, { sessionPath = "" } = {}) {
  if (!ss || ss.hasOutput) return null;

  if (!snapshot) {
    snapshot = createTurnQualitySnapshot(ss, ss.visibleTextAcc || "");
  }

  if (!ss.hasError && snapshot.toolSuccessFallback) {
    return fallbackDecision({
      text: snapshot.toolSuccessFallback,
      logMessage: `[FORCED-TOOL-SUCCESS-FALLBACK v1] emitted · tools=${(ss.lastSuccessfulTools || []).map(t => t.name).join(",")} · ${sessionPath}`,
    });
  }

  if (ss.hasFailedTool || snapshot.isToolFailedShortAnswer) {
    return fallbackDecision({
      text: buildFailedToolFallbackText(ss),
      logMessage: `[FORCED-TOOL-FAILED-FALLBACK v1] emitted · failedTools=${(ss.lastFailedTools || []).join(",")} · ${sessionPath}`,
    });
  }

  return fallbackDecision({
    text: buildEmptyReplyFallbackText(ss),
    logMessage: `[FORCED-EMPTY-FALLBACK v1] emitted · session=${sessionPath}`,
  });
}
