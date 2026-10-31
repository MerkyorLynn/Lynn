/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { Hono } from "hono";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t, getLocale } from "../i18n.js";
import { createLifecycleHooks } from "../chat/lifecycle-hooks.js";
import { buildVisionUnsupportedMessage } from "../../shared/vision-prompt.js";
import { finishSessionStream } from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import { BRAIN_DEFAULT_MODEL_ID, BRAIN_PROVIDER_ID } from "../../shared/brain-provider.js";
import {
  clearToolFinalizationTimer,
  clearTurnTimers,
  createSessionStateStore,
  isStaleEmptySessionStream,
  resetCompletedTurnState,
} from "../chat/stream-state.js";
import type { SessionLike } from "../chat/stream-state.js";
import { extractText } from "../chat/content-utils.js";
import { buildCodeVerificationPostscript } from "../chat/code-verification-postscript.js";
import { createEditRollbackStore } from "../chat/edit-rollback-store.js";
import { createTokenBucketRateLimiter } from "../chat/rate-limit.js";
import {
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  countPersistedAssistantMessages,
  countPersistedAssistantVisibleTexts,
} from "../chat/session-persistence.js";
import { createStreamEmitters } from "../chat/stream-events.js";
import { createChatRouteContext } from "../chat/chat-route-context.js";
import { generateSessionTitle } from "../chat/title-generator.js";
import { createToolTurnFinalizer } from "../chat/tool-turn-finalizer.js";
import { createLocalModelBridge } from "../chat/local-model-bridge.js";
import { createPromptSession, normalizePromptRequest, resolveCreatedPromptSessionPath, validatePromptImages } from "../chat/request-normalizer.js";
import { createHubEventForwarder } from "../chat/hub-event-forwarder.js";
import { createPromptTurnRunner } from "../chat/prompt-turn-runner.js";
import { createWsControlHandler } from "../chat/ws-control-handler.js";
import { createKeyedSerialExecutor } from "../chat/keyed-serial-executor.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type AnyRecord = Record<string, any>;

function hasStreamEvent(ss: any, type: any) {
  return Array.isArray(ss?.events) && ss.events.some((entry: any) => entry?.event?.type === type);
}

function hasToolExecutionInFlight(ss: any) {
  return !!(ss?.recoveredBashInFlight || Number(ss?.activeToolCallCount || 0) > 0);
}

function hasDifferentActiveStreamToken(ss: any, streamToken: any) {
  return Boolean(streamToken && ss?.activeStreamToken && ss.activeStreamToken !== streamToken);
}

function resolveBrainFallbackModel(engine: any) {
  const models = Array.isArray(engine?.availableModels) ? engine.availableModels : [];
  return models.find((model: any) => model?.provider === BRAIN_PROVIDER_ID && model?.id === BRAIN_DEFAULT_MODEL_ID)
    || models.find((model: any) => model?.provider === BRAIN_PROVIDER_ID)
    || null;
}

export function createChatRoute(engine: any, hub: any, { upgradeWebSocket }: any) {
  const routeContext = createChatRouteContext(engine, hub, { upgradeWebSocket });
  const restRoute = new Hono();
  const wsRoute = new Hono();

  let activeWsClients = 0;
  let disconnectAbortTimer: TimerHandle | null = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const TURN_HARD_ABORT_MS = Number(process.env.LYNN_TURN_HARD_ABORT_MS || 0);
  const TURN_LONG_RESEARCH_HARD_ABORT_MS = Number(process.env.LYNN_TURN_LONG_RESEARCH_HARD_ABORT_MS || 240_000);
  const TOOL_FINALIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_FINALIZATION_GRACE_MS || 8_000);
  const TOOL_AUTHORIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_AUTHORIZATION_GRACE_MS || 45_000);
  const RETURNED_TURN_FINALIZATION_GRACE_MS = Number(process.env.LYNN_RETURNED_TURN_FINALIZATION_GRACE_MS || 3_000);

  const { sessionState, getState: getStoredState } = createSessionStateStore();
  const closedSessionPaths = new Set<string>();
  const getState = (sessionPath: string) => closedSessionPaths.has(sessionPath) ? null : getStoredState(sessionPath);
  const lifecycleHooks = createLifecycleHooks({
    onError: (err: any, meta: any) => {
      debugLog()?.warn("ws", `lifecycle hook failed · event=${meta?.eventName || "unknown"} · ${err?.message || err}`);
    },
  });
  lifecycleHooks.tap("prompt_start", ({ sessionPath, routeIntent, streamToken }: any) => {
    debugLog()?.span("prompt_start", { sessionPath, routeIntent, streamToken }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_start", ({ sessionPath, toolName }: any) => {
    debugLog()?.span("tool_start", { sessionPath, toolName }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_end", ({ sessionPath, toolName, success }: any) => {
    debugLog()?.span("tool_end", { sessionPath, toolName, success }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_end", ({ sessionPath, hasOutput, hasToolCall }: any) => {
    debugLog()?.span("turn_end", { sessionPath, hasOutput, hasToolCall }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_close", ({ sessionPath, reason }: any) => {
    debugLog()?.span("turn_close", { sessionPath, reason }, { module: "ws", level: "INFO" });
  });

  const checkRateLimit = createTokenBucketRateLimiter({ capacity: 5, refillMs: 10_000 });
  const runPromptForSession = createKeyedSerialExecutor();
  const pendingPromptAdmissions = new Set<string>();

  function closeSessionStream(sessionPath: string) {
    closedSessionPaths.add(sessionPath);
    const state = sessionState.get(sessionPath);
    if (state) {
      editRollbackStore.discardPendingForSession(sessionPath, typeof state.activeStreamToken === "string" ? state.activeStreamToken : null);
      finishSessionStream(state);
      resetCompletedTurnState(state);
      state.streamId = null;
      state._turnClosed = true;
      sessionState.delete(sessionPath);
    }
    broadcast({ type: "status", isStreaming: false, sessionPath });
    return () => { closedSessionPaths.delete(sessionPath); };
  }

  type ToolTurnFinalizers = ReturnType<typeof createToolTurnFinalizer>;
  let buildRealtimeToolFallbackText: ToolTurnFinalizers["buildRealtimeToolFallbackText"] = () => "";
  let closeStreamAfterError: ToolTurnFinalizers["closeStreamAfterError"] = () => {};
  let closeStreamWithVisibleFallback: ToolTurnFinalizers["closeStreamWithVisibleFallback"] = () => false;
  let finalizeReturnedTurnWithoutStream: ToolTurnFinalizers["finalizeReturnedTurnWithoutStream"] = () => false;
  let schedulePersistedFinalAnswerPoll: ToolTurnFinalizers["schedulePersistedFinalAnswerPoll"] = () => false;
  let scheduleReturnedTurnFinalizationFallback: ToolTurnFinalizers["scheduleReturnedTurnFinalizationFallback"] = () => false;
  let scheduleSilentBrainAbort: ToolTurnFinalizers["scheduleSilentBrainAbort"] = () => {};
  let scheduleToolAuthorizationFallback: ToolTurnFinalizers["scheduleToolAuthorizationFallback"] = () => {};
  let scheduleToolFinalizationFallback: ToolTurnFinalizers["scheduleToolFinalizationFallback"] = () => {};
  let scheduleTurnHardAbort: ToolTurnFinalizers["scheduleTurnHardAbort"] = () => {};

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;
      // Sessions and their resumable event logs outlive a renderer connection.
      // A global abort here also kills unrelated bridge and scheduled tasks.
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms; preserving resumable sessions`);
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  async function releaseStaleSessionStream(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err: any) {
      console.warn("[chat] failed to abort stale session stream:", err?.message || err);
    }
    if (ss.isStreaming) {
      closeStreamAfterError(sessionPath, ss);
    } else {
      editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
      finishSessionStream(ss);
      resetCompletedTurnState(ss);
      broadcast({ type: "status", isStreaming: false, sessionPath });
    }
    debugLog()?.warn("ws", `[STALE-STREAM-RELEASE v1] released stale stream · elapsed=${Date.now() - (ss.startedAt || Date.now())}ms · ${sessionPath}`);
    return true;
  }

  async function closeBusySessionBeforeNextPrompt(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err: any) {
      console.warn("[chat] failed to abort busy session stream:", err?.message || err);
    }
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (!hasStreamEvent(ss, "turn_end")) {
      emitStreamEvent(sessionPath, ss, { type: "turn_end", streamSource: ss.streamSource });
    }
    lifecycleHooks.run("turn_close", { sessionPath, ss, reason: "busy_new_prompt", forced: true });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `[BUSY-STREAM-FENCE v1] closed active stream before accepting next prompt · session=${sessionPath}`);
    return true;
  }

  const clients = new Set<any>();

  const editRollbackStore = createEditRollbackStore({ maxSnapshots: 200 });

  function broadcast(msg: any) {
    for (const client of clients) {
      wsSend(client as any, msg);
    }
  }

  function maybeGenerateFirstTurnTitle(sessionPath: any, ss: any) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter((m: any) => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok: any) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err: any) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  const {
    emitStreamEvent,
    emitTrustedVisibleTextDelta,
    emitVisibleTextDelta,
    flushBufferedToolVisibleText,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
  } = createStreamEmitters({
    broadcast,
    hasStreamEvent,
    hasToolExecutionInFlight,
    scheduleToolFinalizationFallback: (sessionPath, ss) => scheduleToolFinalizationFallback(sessionPath, ss as SessionLike),
    clearToolFinalizationTimer: (ss) => clearToolFinalizationTimer(ss as SessionLike),
    maybeGenerateFirstTurnTitle: (sessionPath, ss) => maybeGenerateFirstTurnTitle(sessionPath, ss),
  });

  function maybeAppendCodeVerificationPostscript(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    const addition = buildCodeVerificationPostscript(
      `${ss.originalPromptText || ""}\n${ss.effectivePromptText || ""}`,
      ss.visibleTextAcc || "",
    );
    if (!addition) return false;
    emitTrustedVisibleTextDelta(sessionPath, ss, addition);
    appendTextToLatestAssistantRecord(sessionPath, addition);
    appendTextToLatestAssistantInMemory(engine.getSessionByPath(sessionPath), addition);
    debugLog()?.log("ws", `[CODE-VERIFY-POSTSCRIPT v1] appended verification command · ${sessionPath}`);
    return true;
  }

  ({
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    closeStreamWithVisibleFallback,
    finalizeReturnedTurnWithoutStream,
    schedulePersistedFinalAnswerPoll,
    scheduleReturnedTurnFinalizationFallback,
    scheduleSilentBrainAbort,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    scheduleTurnHardAbort,
  } = createToolTurnFinalizer({
    engine,
    editRollbackStore,
    lifecycleHooks,
    broadcast,
    emitStreamEvent,
    emitTrustedVisibleTextDelta,
    emitVisibleTextDelta,
    flushBufferedAssistantText,
    flushBufferedToolVisibleText,
    maybeAppendCodeVerificationPostscript,
    hasStreamEvent,
    hasToolExecutionInFlight,
    hasDifferentActiveStreamToken,
    timeouts: {
      returnedTurnFinalizationGraceMs: RETURNED_TURN_FINALIZATION_GRACE_MS,
      turnHardAbortMs: TURN_HARD_ABORT_MS,
      turnLongResearchHardAbortMs: TURN_LONG_RESEARCH_HARD_ABORT_MS,
      toolFinalizationGraceMs: TOOL_FINALIZATION_GRACE_MS,
      toolAuthorizationGraceMs: TOOL_AUTHORIZATION_GRACE_MS,
    },
  }));

  const {
    fallbackLocalQwen35DirectToBrain,
    startLocalQwen35PrefetchFeedback,
    streamLocalQwen35DirectBridge,
  } = createLocalModelBridge({
    engine,
    hub,
    lifecycleHooks,
    broadcast,
    emitStreamEvent,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
    maybeAppendCodeVerificationPostscript,
    resolveBrainFallbackModel,
    hasToolExecutionInFlight,
    scheduleSilentBrainAbort,
    scheduleToolFinalizationFallback,
    scheduleReturnedTurnFinalizationFallback,
    finalizeReturnedTurnWithoutStream,
  });

  const runPromptTurn = createPromptTurnRunner({
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
  });

  createHubEventForwarder({
    hub,
    engine,
    sessionState,
    editRollbackStore,
    lifecycleHooks,
    broadcast,
    emitStreamEvent,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
    maybeAppendCodeVerificationPostscript,
    maybeGenerateFirstTurnTitle,
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    closeStreamWithVisibleFallback,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    hasStreamEvent,
    hasToolExecutionInFlight,
  });

  const handleWsControlMessage = createWsControlHandler({
    engine,
    hub,
    sessionState,
    broadcast,
  });

  // ── WebSocket 路由 ──

  wsRoute.get("/ws",
    routeContext.upgradeWebSocket((_c: any) => {
      let closed = false;

      return {
        onOpen(event: any, ws: any) {
          activeWsClients++;
          clients.add(ws);
          cancelDisconnectAbort();
          debugLog()?.log("ws", "client connected");
        },

        onMessage(event: any, ws: any) {
          const msg: AnyRecord | null = wsParse(event.data) as AnyRecord | null;
          if (!msg) return;

          (async () => {
            if (msg.type === "abort"
              || msg.type === "resume_stream"
              || msg.type === "context_usage"
              || msg.type === "compact"
              || msg.type === "toggle_plan_mode") {
              if (await handleWsControlMessage(msg, ws)) return;
            }

            if (msg.type === "steer" && msg.text) {
              debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
              const steerPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.steerSession(steerPath, msg.text)) {
                wsSend(ws, { type: "steered" });
                return;
              }
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

            if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
              const imageValidation = validatePromptImages(msg.images, t);
              if (!imageValidation.ok) {
                wsSend(ws, { type: "error", message: imageValidation.message || t("error.imageTooLarge") });
                return;
              }
              const _resolved = engine.resolveModelOverrides(engine.currentModel);
              if (msg.images?.length && _resolved?.vision === false) {
                wsSend(ws, { type: "error", message: buildVisionUnsupportedMessage({ locale: getLocale() }) });
                return;
              }
              let promptSessionPath = msg.sessionPath || engine.currentSessionPath;
              if (!promptSessionPath) {
                const createdSession = await createPromptSession(engine);
                promptSessionPath = resolveCreatedPromptSessionPath(createdSession, engine);
              }
              if (!checkRateLimit(promptSessionPath)) {
                wsSend(ws, { type: "error", message: "Rate limit exceeded. Please wait before sending another message." });
                return;
              }
              pendingPromptAdmissions.add(promptSessionPath);
              let promptAdmission;
              try {
                promptAdmission = await runPromptForSession(promptSessionPath, async () => {
                const ss = getState(promptSessionPath);
                if (!ss) {
                  wsSend(ws, { type: "error", message: t("error.noActiveSession") });
                  return;
                }
                const { promptText } = normalizePromptRequest(msg, promptSessionPath, { locale: getLocale() });
                debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
                const engineStreaming = engine.isSessionStreaming(promptSessionPath);
                if (engineStreaming || ss?.isStreaming) {
                  const shouldReleaseStale = isStaleEmptySessionStream(ss)
                    || (engineStreaming && !ss?.isStreaming);
                  let releasedStale = shouldReleaseStale
                    ? await releaseStaleSessionStream(promptSessionPath, ss)
                    : false;
                  if (!releasedStale && ss?.isStreaming) {
                    releasedStale = await closeBusySessionBeforeNextPrompt(promptSessionPath, ss);
                  }
                  if (!releasedStale) {
                    wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
                    return;
                  }
                }
                const replaceFromMessageId = msg.replaceFromMessageId != null
                  ? String(msg.replaceFromMessageId || "").trim()
                  : "";
                if (replaceFromMessageId) {
                  const replaceFromMessageIndex = Number.isInteger(Number(msg.replaceFromMessageIndex)) && Number(msg.replaceFromMessageIndex) >= 0
                    ? String(Number(msg.replaceFromMessageIndex))
                    : replaceFromMessageId;
                  const result = await Promise.resolve(
                    engine.truncateSessionBeforeVisibleMessage?.(promptSessionPath, replaceFromMessageIndex),
                  );
                  if (!result?.ok) {
                    debugLog()?.warn("ws", `edit-resend rewind failed · session=${promptSessionPath} · reason=${result?.reason || "unknown"}`);
                    wsSend(ws, {
                      type: "error",
                      message: "无法定位要编辑的历史消息，请重新打开会话后再试。",
                      sessionPath: promptSessionPath,
                    });
                    return;
                  }
                }
                if (closedSessionPaths.has(promptSessionPath)) return;
                wsSend(ws, {
                  type: "prompt_accepted",
                  sessionPath: promptSessionPath,
                  clientMessageId: msg.clientMessageId || null,
                });
                return {
                  pending: runPromptTurn({
                    ws,
                    msg,
                    promptSessionPath,
                    ss,
                    promptText,
                  }),
                };
                });
              } finally {
                pendingPromptAdmissions.delete(promptSessionPath);
              }
              if (promptAdmission?.pending) await promptAdmission.pending;
            }
          })().catch((err: any) => {
            const appErr = AppError.wrap(err);
            errorBus.report(appErr, { context: { wsMessageType: msg.type } });
            if (!appErr.message?.includes('aborted')) {
              wsSend(ws, { type: 'error', message: appErr.message || 'Unknown error', error: appErr.toJSON() });
            }
          });
        },

        onError(event: any, _ws: any) {
          const err = event.error || event;
          console.error("[ws] error:", err.message || err);
          debugLog()?.error("ws", err.message || String(err));
        },

        onClose(event: any, ws: any) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming && !pendingPromptAdmissions.has(sp)) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute, broadcast, editRollbackStore, lifecycleHooks, closeSessionStream };
}
