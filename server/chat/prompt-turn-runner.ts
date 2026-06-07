import { wsSend } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t } from "../i18n.js";
import { classifyRouteIntent } from "../../shared/task-route-intent.js";
import { beginSessionStream } from "../session-stream-store.js";
import {
  LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS,
  resolveLocalQwen35DirectMaxTokens,
  resolveLocalQwen35DirectThinking,
  shouldUseLocalQwen35DirectBridge,
} from "./local-qwen35-direct-policy.js";
import { resolveCurrentModelInfo } from "./chat-recovery.js";
import {
  TOOL_USE_BEHAVIOR,
  buildNoToolTurnPrompt,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
} from "./tool-use-behavior.js";
import { attachLocalQwen35BenchContext, isLocalQwen35Model } from "./local-qwen35-bench-context.js";
import { buildPrefetchToolSummary, rememberFailedTool, rememberSuccessfulTool } from "./tool-summary.js";
import { buildReportResearchContext } from "./report-research-context.js";
import { consumeMutationConfirmation, recordPendingDeleteRequest } from "./turn-retry-policy.js";
import { buildLocalOfficeDirectAnswer } from "./local-office-answer.js";
import { skillCrystallizeEnabled, recallSkillFrame, resolveBrainDataDir } from "./skill-crystallize.js";
import {
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  countPersistedAssistantMessages,
  countPersistedAssistantVisibleTexts,
} from "./session-persistence.js";

type AnyRecord = Record<string, any>;

export interface PromptTurnRunnerDeps {
  engine: any;
  hub: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: any, ss: any, event: any) => void;
  closeStreamAfterError: (sessionPath: any, ss: any) => void;
  closeStreamWithVisibleFallback: (sessionPath: any, ss: any, text: any, reason: any, options?: any) => boolean;
  finalizeReturnedTurnWithoutStream: (sessionPath: any, ss: any, reason: any, options?: any) => boolean;
  fallbackLocalQwen35DirectToBrain: (args: any) => Promise<boolean>;
  startLocalQwen35PrefetchFeedback: (sessionPath: any, ss: any, toolName: any, promptText: any) => () => void;
  streamLocalQwen35DirectBridge: (sessionPath: any, ss: any, promptText: any, effectivePromptText: any, modelInfo: any, options?: any) => Promise<any>;
  schedulePersistedFinalAnswerPoll: (sessionPath: any, ss: any) => boolean;
  scheduleReturnedTurnFinalizationFallback: (sessionPath: any, ss: any, reason?: any) => boolean;
  scheduleSilentBrainAbort: (sessionPath: any, ss: any) => void;
  scheduleToolFinalizationFallback: (sessionPath: any, ss: any) => void;
  scheduleTurnHardAbort: (sessionPath: any, ss: any) => void;
  clearTurnTimers: (ss: any) => void;
  hasStreamEvent: (ss: any, type: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
}

export interface RunPromptTurnOptions {
  ws: any;
  msg: AnyRecord;
  promptSessionPath: any;
  ss: any;
  promptText: string;
}

export function createPromptTurnRunner({
  engine,
  hub,
  lifecycleHooks,
  broadcast,
  emitStreamEvent,
  closeStreamAfterError,
  closeStreamWithVisibleFallback,
  finalizeReturnedTurnWithoutStream,
  fallbackLocalQwen35DirectToBrain,
  startLocalQwen35PrefetchFeedback,
  streamLocalQwen35DirectBridge,
  schedulePersistedFinalAnswerPoll,
  scheduleReturnedTurnFinalizationFallback,
  scheduleSilentBrainAbort,
  scheduleToolFinalizationFallback,
  scheduleTurnHardAbort,
  clearTurnTimers,
  hasStreamEvent,
  hasToolExecutionInFlight,
}: PromptTurnRunnerDeps) {
  function buildClosedEmptyTurnFallback(ss: AnyRecord) {
    const toolFallback = String(ss?.realtimeToolFallbackText || "").trim();
    if (toolFallback) return toolFallback;
    const deterministic = buildLocalOfficeDirectAnswer(ss?.originalPromptText || ss?.effectivePromptText || "");
    if (deterministic) return deterministic;
    if (ss?.hasToolCall) {
      return "工具已经完成执行，但模型没有返回最终总结。请查看上方工具结果；如果需要，我可以基于这些结果继续整理成简短回答。";
    }
    return "";
  }

  return async function runPromptTurn({
    ws,
    msg,
    promptSessionPath,
    ss,
    promptText,
  }: RunPromptTurnOptions) {
    try {
      ss.thinkTagParser.reset();
      ss.progressParser.reset();
      ss.moodParser.reset();
      ss.xingParser.reset();
      ss.titleRequested = false;
      ss.titlePreview = "";
      ss.visibleTextAcc = "";
      ss.bufferedVisibleTextDuringTool = "";
      ss.hasBufferedVisibleTextDuringTool = false;
      ss.rawTextAcc = "";
      ss.routeIntent = classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 });
      ss.originalPromptText = promptText;
      ss.effectivePromptText = promptText;
      ss.hasLocalPrefetchEvidence = false;
      ss.pendingToolRetryAttempted = false;
      ss.internalRetryCounts = {};
      ss.internalRetryPending = false;
      ss.internalRetryInFlight = false;
      ss.internalRetryReason = "";
      ss.pseudoToolSteered = false;
      ss.pseudoToolRecoveryHandled = false;
      ss.pseudoToolCommandRecoveryAttempted = false;
      ss.pseudoToolXmlBlock = null;
      ss.emittedFileOutputPaths = new Set();
      ss.rehydratedThisTurn = false;
      ss.postRehydrateEscalationAttempted = false;
      ss.postRehydrateDeterministicAttempted = false;
      ss.hasOutput = false;
      ss.hasToolCall = false;
      ss.hasThinking = false;
      ss.hasError = false;
      ss.realtimeToolFallbackText = "";
      ss.persistedAssistantTextBaseline = countPersistedAssistantVisibleTexts(
        engine.getSessionByPath(promptSessionPath),
        promptSessionPath,
      );
      ss.persistedAssistantMessageBaseline = countPersistedAssistantMessages(
        engine.getSessionByPath(promptSessionPath),
        promptSessionPath,
      );
      const rehydratedMutation = consumeMutationConfirmation(ss, promptText);
      if (rehydratedMutation) {
        ss.originalPromptText = rehydratedMutation.originalPrompt;
        ss.routeIntent = classifyRouteIntent(rehydratedMutation.originalPrompt, { imagesCount: msg.images?.length || 0 });
        ss._rehydratedEffectivePrompt = rehydratedMutation.retryPrompt;
        ss.rehydratedThisTurn = true;
        debugLog()?.warn("ws", `[MUTATION-CONFIRM-REHYDRATE v1] rehydrated prior delete request · session=${promptSessionPath}`);
      } else if (recordPendingDeleteRequest(ss, promptText)) {
        debugLog()?.log("ws", `[PENDING-DELETE-REQUEST v1] tracked delete request for confirmation rehydrate · session=${promptSessionPath}`);
      }
      const streamToken = beginSessionStream(ss);
      ss.activeStreamToken = streamToken;
      ss.streamSource = "user";
      scheduleTurnHardAbort(promptSessionPath, ss);
      schedulePersistedFinalAnswerPoll(promptSessionPath, ss);
      broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
      lifecycleHooks.run("prompt_start", {
        ss,
        sessionPath: promptSessionPath,
        routeIntent: ss.routeIntent,
        streamToken,
      });
      const currentModelInfo: AnyRecord = resolveCurrentModelInfo(engine) as AnyRecord;
      const initialToolUse = resolveInitialToolUseBehavior(promptText, { modelInfo: currentModelInfo });
      const budgetContext = initialToolUse.budgetContext || "";
      let effectivePromptText = initialToolUse.effectivePromptText || promptText;
      let disableTurnTools = !!initialToolUse.disableTools;
      effectivePromptText = attachLocalQwen35BenchContext(effectivePromptText, currentModelInfo);
      if (ss._rehydratedEffectivePrompt) {
        effectivePromptText = String(ss._rehydratedEffectivePrompt);
        disableTurnTools = false;
        ss._rehydratedEffectivePrompt = null;
      }
      // ① Skill recall: prepend SOPs crystallized from past similar tasks
      // (opt-in via BRAIN_SKILL_CRYSTALLIZE=1; fully guarded, no-op when off/empty).
      if (skillCrystallizeEnabled()) {
        const recallFrame = recallSkillFrame(resolveBrainDataDir(), promptText);
        if (recallFrame) effectivePromptText = `${recallFrame}\n\n${effectivePromptText}`;
      }
      const noToolTurnInstruction = disableTurnTools ? buildNoToolTurnPrompt(effectivePromptText) : "";
      if (shouldUseLocalQwen35DirectBridge(promptText, {
        isLocalModel: isLocalQwen35Model(currentModelInfo),
        hasImages: Boolean(msg.images?.length),
        rehydratedMutation: Boolean(rehydratedMutation),
        toolBehavior: initialToolUse.behavior,
        reason: initialToolUse.reason,
        routeIntent: ss.routeIntent,
      })) {
        ss.effectivePromptText = effectivePromptText;
        try {
          const localEnableThinking = resolveLocalQwen35DirectThinking(promptText, engine);
          await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
            enableThinking: localEnableThinking,
            maxTokens: resolveLocalQwen35DirectMaxTokens(promptText, localEnableThinking),
          });
        } catch (directErr: any) {
          debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v1] failed · ${directErr?.message || directErr} · ${promptSessionPath}`);
          const fallbackOk = await fallbackLocalQwen35DirectToBrain({
            sessionPath: promptSessionPath,
            ss,
            promptText,
            effectivePromptText,
            modelInfo: currentModelInfo,
            msg,
            streamToken,
            disableTools: disableTurnTools,
            turnInstruction: noToolTurnInstruction,
            reason: "local_qwen35_direct_failed",
          });
          if (!fallbackOk) {
            closeStreamWithVisibleFallback(
              promptSessionPath,
              ss,
              "",
              "local_qwen35_direct_failed",
              { trustedFallback: true },
            );
          }
        }
        return;
      }
      const localQwenSynthesisAfterPrefetch = isLocalQwen35Model(currentModelInfo);
      if (!rehydratedMutation && initialToolUse.behavior === TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP) {
        const toolName = initialToolUse.toolName;
        ss.hasPrefetchToolCall = true;
        emitStreamEvent(promptSessionPath, ss, { type: "tool_start", name: toolName, args: { query: promptText } });
        const stopPrefetchFeedback = localQwenSynthesisAfterPrefetch
          ? startLocalQwen35PrefetchFeedback(promptSessionPath, ss, toolName, promptText)
          : () => {};
        lifecycleHooks.run("tool_start", {
          ss,
          sessionPath: promptSessionPath,
          toolName,
          args: { query: promptText },
          localPrefetch: true,
        });
        try {
          const reportContext = await buildReportResearchContext(promptText, { userPrompt: promptText });
          if (reportContext && reportContext.trim()) {
            const toolSummary = buildPrefetchToolSummary(reportContext);
            ss.hasLocalPrefetchEvidence = true;
            effectivePromptText = buildPrefetchAugmentedPrompt(promptText, reportContext, budgetContext);
            emitStreamEvent(promptSessionPath, ss, {
              type: "tool_end",
              name: toolName,
              success: true,
              summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
            });
            lifecycleHooks.run("tool_end", {
              ss,
              sessionPath: promptSessionPath,
              toolName,
              success: true,
              summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
              localPrefetch: true,
            });
            rememberSuccessfulTool(ss, toolName, toolSummary, { query: promptText });
          } else {
            emitStreamEvent(promptSessionPath, ss, { type: "tool_end", name: toolName, success: false, error: "no evidence returned" });
            lifecycleHooks.run("tool_end", {
              ss,
              sessionPath: promptSessionPath,
              toolName,
              success: false,
              error: "no evidence returned",
              localPrefetch: true,
            });
            rememberFailedTool(ss, toolName);
          }
        } catch (prefetchErr: any) {
          emitStreamEvent(promptSessionPath, ss, {
            type: "tool_end",
            name: toolName,
            success: false,
            error: prefetchErr?.message || "prefetch failed",
          });
          lifecycleHooks.run("tool_end", {
            ss,
            sessionPath: promptSessionPath,
            toolName,
            success: false,
            error: prefetchErr?.message || "prefetch failed",
            localPrefetch: true,
          });
          rememberFailedTool(ss, toolName);
        } finally {
          stopPrefetchFeedback();
        }
        if (localQwenSynthesisAfterPrefetch) {
          ss.effectivePromptText = effectivePromptText;
          try {
            await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
              // The realtime tool result is already supplied as context.
              // Keep this path as a fast local writer so weather/market
              // asks do not spend a minute in hidden reasoning.
              enableThinking: false,
              maxTokens: Math.min(LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS, 768),
              timeoutMs: 45_000,
              earlyCloseVisibleChars: 240,
            });
          } catch (directErr: any) {
            debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v2] failed after prefetch · ${directErr?.message || directErr} · ${promptSessionPath}`);
            const fallbackOk = await fallbackLocalQwen35DirectToBrain({
              sessionPath: promptSessionPath,
              ss,
              promptText,
              effectivePromptText,
              modelInfo: currentModelInfo,
              msg,
              streamToken,
              disableTools: disableTurnTools,
              turnInstruction: noToolTurnInstruction,
              reason: "local_qwen35_direct_after_prefetch_failed",
            });
            if (!fallbackOk) {
              closeStreamWithVisibleFallback(
                promptSessionPath,
                ss,
                "",
                "local_qwen35_direct_after_prefetch_failed",
                { trustedFallback: true },
              );
            }
          }
          return;
        }
      }
      if (ss._lastTurnAborted) {
        ss._lastTurnAborted = false;
      }
      ss.effectivePromptText = effectivePromptText;
      scheduleSilentBrainAbort(promptSessionPath, ss);
      await hub.send(
        effectivePromptText,
        msg.images
          ? { images: msg.images, sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction }
          : { sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction },
      );
      if (!ss.isStreaming) {
        if (hasToolExecutionInFlight(ss)) {
          scheduleToolFinalizationFallback(promptSessionPath, ss);
          debugLog()?.log("ws", `[HUB-SEND v2] returned while tool is still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}; defer close · ${promptSessionPath}`);
        } else {
          if (!finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_closed_without_turn_end")) {
            const fallbackText = buildClosedEmptyTurnFallback(ss);
            if (fallbackText) {
              closeStreamWithVisibleFallback(promptSessionPath, ss, fallbackText, "hub_send_returned_closed_empty_fallback", { trustedFallback: true });
            } else {
              clearTurnTimers(ss);
              broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
            }
          }
        }
      } else if (!hasToolExecutionInFlight(ss) && finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_open_without_turn_end", { requirePersistedText: true })) {
        // finalized from the persisted non-streaming assistant message
      } else {
        scheduleReturnedTurnFinalizationFallback(promptSessionPath, ss, "hub_send_returned_open_safety_timeout");
        debugLog()?.log("ws", `hub.send returned while server stream remains open · ${promptSessionPath}`);
      }
    } catch (err: any) {
      clearTurnTimers(ss);
      const aborted = err.message?.includes("aborted");
      if (!aborted) {
        wsSend(ws, { type: "error", message: err.message, sessionPath: promptSessionPath });
        if (ss) ss.hasError = true;
      } else if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError) {
        wsSend(ws, { type: "error", message: t("error.modelNoResponse"), sessionPath: promptSessionPath });
      }
      if (ss && !hasStreamEvent(ss, "turn_end")) {
        closeStreamAfterError(promptSessionPath, ss);
      } else {
        broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
      }
    }
  };
}
