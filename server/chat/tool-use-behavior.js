import { buildLocalOfficeDirectAnswer } from "./local-office-answer.js";
import { inferReportResearchKind } from "./report-research-context.js";
import {
  buildBudgetCalculationContext,
  prefetchToolNameForKind,
  shouldPrefetchReportContext,
  shouldSuppressLocalToolPrefetch,
} from "./prefetch-context.js";

export const TOOL_USE_BEHAVIOR = Object.freeze({
  RUN_LLM_AGAIN: "run_llm_again",
  STOP_WITH_DIRECT_ANSWER: "stop_with_direct_answer",
  PREFETCH_THEN_RUN_OR_STOP: "prefetch_then_run_or_stop",
});

export function resolveInitialToolUseBehavior(promptText, opts = {}) {
  const text = String(promptText || "");
  const directAnswer = buildLocalOfficeDirectAnswer(text);
  if (directAnswer) {
    return {
      behavior: TOOL_USE_BEHAVIOR.STOP_WITH_DIRECT_ANSWER,
      reason: "local_office_direct_answer",
      directAnswer,
      reportKind: "",
      budgetContext: "",
      effectivePromptText: text,
    };
  }

  const reportKind = inferReportResearchKind(text);
  const budgetContext = buildBudgetCalculationContext(text);
  const effectivePromptText = budgetContext
    ? `${budgetContext}\n\n【用户原始问题】\n${text}`
    : text;
  const suppressLocalPrefetch = shouldSuppressLocalToolPrefetch(text);

  if (!suppressLocalPrefetch && shouldPrefetchReportContext(reportKind, opts.modelInfo)) {
    return {
      behavior: TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP,
      reason: "report_context_prefetch",
      reportKind,
      budgetContext,
      effectivePromptText,
      toolName: prefetchToolNameForKind(reportKind),
    };
  }

  return {
    behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    reason: "default",
    reportKind,
    budgetContext,
    effectivePromptText,
  };
}

export function buildPrefetchAugmentedPrompt(promptText, reportContext, budgetContext = "") {
  return [
    String(reportContext || "").trim(),
    budgetContext,
    `【用户原始问题】\n${String(promptText || "")}`,
  ].filter(Boolean).join("\n\n");
}
