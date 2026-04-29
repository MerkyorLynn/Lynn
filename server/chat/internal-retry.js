/**
 * Internal retry — 空答/短答/工具失败等场景的隐式重试调度
 *
 * 从 server/routes/chat.js 提取。负责 retry 计数、准备、调度、执行。
 */
import { debugLog } from "../../lib/debug-log.js";
import {
  beginSessionStream,
  finishSessionStream,
} from "../session-stream-store.js";
import { resetCompletedTurnState } from "./stream-state.js";

const INTERNAL_RETRY_HARD_TIMEOUT_MS = Number(process.env.LYNN_INTERNAL_RETRY_HARD_TIMEOUT_MS || 60_000);
const INTERNAL_RETRY_START_WAIT_ATTEMPTS = Number(process.env.LYNN_INTERNAL_RETRY_START_WAIT_ATTEMPTS || 300);

export function internalRetryCount(ss, reason) {
  if (!ss || !reason) return 0;
  const counts = ss.internalRetryCounts || {};
  return Number(counts[reason] || 0);
}

export function canScheduleInternalRetry(ss, reason) {
  return !!ss && !!reason && internalRetryCount(ss, reason) < 1;
}

export function markInternalRetry(ss, reason) {
  if (!ss || !reason) return false;
  if (!ss.internalRetryCounts || typeof ss.internalRetryCounts !== "object") {
    ss.internalRetryCounts = {};
  }
  ss.internalRetryCounts[reason] = internalRetryCount(ss, reason) + 1;
  return true;
}

export function prepareInternalRetryStream(sessionPath, ss, reason) {
  ss.thinkTagParser.reset();
  ss.progressParser.reset();
  ss.moodParser.reset();
  ss.xingParser.reset();
  ss.titleRequested = true;
  ss.titlePreview = "";
  ss.visibleTextAcc = "";
  ss.rawTextAcc = "";
  ss.hasOutput = false;
  ss.hasToolCall = false;
  ss.hasPrefetchToolCall = false;
  ss.hasThinking = false;
  ss.hasError = false;
  ss.isThinking = false;
  ss.pseudoToolSteered = false;
  ss.pseudoToolXmlBlock = null;
  ss.successfulToolCount = 0;
  ss.lastSuccessfulTools = [];
  ss.hasFailedTool = false;
  ss.lastFailedTools = [];
  ss.progressMarkerCount = 0;
  ss.degenerationAbortRequested = false;
  ss._turnEndDeferred = false;
  ss.internalRetryPending = false;
  ss.internalRetryInFlight = true;
  ss.internalRetryReason = reason;
  const streamToken = beginSessionStream(ss);
  ss.activeStreamToken = streamToken;
  ss.streamSource = "internal_retry";
  debugLog()?.log("ws", `[INTERNAL-RETRY v1] opened retry stream · reason=${reason} · session=${sessionPath}`);
  return streamToken;
}

function clearRetryLifecycle(ss, reason = "") {
  if (!ss) return;
  if (!reason || ss.internalRetryReason === reason) {
    ss.internalRetryPending = false;
    ss.internalRetryInFlight = false;
    ss.internalRetryReason = "";
  }
}

function retryFallbackText(reason) {
  return reason === "empty_reply" || reason === "pseudo_tool_text"
    ? "本轮模型没有生成可用回复，Lynn 已结束这次空转以免卡住会话。请重试一次，或把任务说得更具体一点。"
    : "本轮补写回答没有稳定完成，Lynn 已结束这次空转以免卡住会话。上方已有内容已保留，你可以让我继续核对。";
}

function closeRetryWithFallback({
  sessionPath,
  ss,
  reason,
  streamToken = null,
  broadcast,
  engine,
  clearSilentBrainAbort,
  emitStreamEvent,
  cleanupPendingEdits,
  logReason,
}) {
  if (!sessionPath || !ss) return false;
  try {
    engine.abortSessionByPath?.(sessionPath).catch(() => {});
  } catch {
    // Abort is best-effort; local stream closure below is authoritative.
  }
  clearSilentBrainAbort(ss);
  clearRetryLifecycle(ss, reason);
  if (ss.isThinking) {
    ss.isThinking = false;
    emitStreamEvent?.(sessionPath, ss, { type: "thinking_end" });
  }
  if (!ss.hasOutput) {
    const fallback = retryFallbackText(reason);
    emitStreamEvent?.(sessionPath, ss, { type: "text_delta", delta: fallback });
    ss.visibleTextAcc += fallback;
    ss.hasOutput = true;
  }
  emitStreamEvent?.(sessionPath, ss, { type: "turn_end" });
  broadcast({ type: "status", isStreaming: false, sessionPath });
  cleanupPendingEdits?.(sessionPath, streamToken || ss.activeStreamToken || null);
  finishSessionStream(ss);
  resetCompletedTurnState(ss);
  debugLog()?.warn("ws", `[INTERNAL-RETRY-CLOSE v1] closed retry stream · reason=${reason} close=${logReason} · session=${sessionPath}`);
  return true;
}

export function scheduleInternalRetry({
  sessionPath, reason, retryPrompt,
  getState, broadcast, hub, engine,
  scheduleSilentBrainAbort, clearSilentBrainAbort,
  closeStreamAfterError, emitStreamEvent,
  finalizeReturnedTurnWithoutStream,
  cleanupPendingEdits,
}) {
  if (!sessionPath || !reason || !String(retryPrompt || "").trim()) return false;
  const ss = getState(sessionPath);
  if (!ss || !canScheduleInternalRetry(ss, reason)) {
    debugLog()?.warn("ws", `[INTERNAL-RETRY v1] skipped · reason=${reason} count=${internalRetryCount(ss, reason)} · session=${sessionPath}`);
    return false;
  }
  markInternalRetry(ss, reason);
  ss.internalRetryPending = true;
  ss.internalRetryInFlight = false;
  ss.internalRetryReason = reason;
  broadcast({ type: "turn_retry", sessionPath, reason });
  const startRetry = async (attempt = 0) => {
    const currentSs = getState(sessionPath);
    if (!currentSs) return;
    if (currentSs.isStreaming || engine.isSessionStreaming(sessionPath)) {
      if (attempt < INTERNAL_RETRY_START_WAIT_ATTEMPTS) {
        setTimeout(() => startRetry(attempt + 1), 50);
        return;
      }
      debugLog()?.warn("ws", `[INTERNAL-RETRY v1] abandoned because session stayed streaming · reason=${reason} · session=${sessionPath}`);
      closeRetryWithFallback({
        sessionPath,
        ss: currentSs,
        reason,
        broadcast,
        engine,
        clearSilentBrainAbort,
        emitStreamEvent,
        cleanupPendingEdits,
        logReason: "session_stayed_streaming",
      });
      return;
    }
    const streamToken = prepareInternalRetryStream(sessionPath, currentSs, reason);
    broadcast({ type: "status", isStreaming: true, sessionPath });
    scheduleSilentBrainAbort(sessionPath, currentSs);
    let hardTimedOut = false;
    const hardTimeout = setTimeout(() => {
      const timeoutSs = getState(sessionPath);
      if (
        !timeoutSs ||
        (timeoutSs.activeStreamToken && timeoutSs.activeStreamToken !== streamToken) ||
        timeoutSs.streamSource !== "internal_retry"
      ) return;
      hardTimedOut = true;
      debugLog()?.warn("ws", `[INTERNAL-RETRY-TIMEOUT v1] closing retry stream · reason=${reason} timeout=${INTERNAL_RETRY_HARD_TIMEOUT_MS}ms · session=${sessionPath}`);
      closeRetryWithFallback({
        sessionPath,
        ss: timeoutSs,
        reason,
        streamToken,
        broadcast,
        engine,
        clearSilentBrainAbort,
        emitStreamEvent,
        cleanupPendingEdits,
        logReason: "hard_timeout",
      });
    }, INTERNAL_RETRY_HARD_TIMEOUT_MS);
    if (hardTimeout.unref) hardTimeout.unref();
    try {
      await hub.send(retryPrompt, { sessionPath, streamToken });
      if (hardTimedOut) return;
      if (!currentSs.isStreaming) {
        clearTimeout(hardTimeout);
        clearSilentBrainAbort(currentSs);
        clearRetryLifecycle(currentSs, reason);
        if (finalizeReturnedTurnWithoutStream?.(sessionPath, currentSs, `internal_retry_returned_without_turn_end:${reason}`, { ignoreInternalRetry: true })) {
          return;
        }
        broadcast({ type: "status", isStreaming: false, sessionPath });
      } else {
        debugLog()?.warn("ws", `[INTERNAL-RETRY v1] hub.send returned while retry stream remains open; keeping hard timeout armed · reason=${reason} · session=${sessionPath}`);
      }
    } catch (retryErr) {
      clearTimeout(hardTimeout);
      if (hardTimedOut) return;
      clearSilentBrainAbort(currentSs);
      clearRetryLifecycle(currentSs, reason);
      currentSs.hasError = true;
      debugLog()?.warn("ws", `[INTERNAL-RETRY v1] failed · reason=${reason}: ${retryErr?.message || retryErr}`);
      if (currentSs.isStreaming) {
        closeStreamAfterError(sessionPath, currentSs);
      } else {
        broadcast({ type: "error", message: retryErr?.message || String(retryErr), sessionPath });
        broadcast({ type: "status", isStreaming: false, sessionPath });
      }
    }
  };
  Promise.resolve().then(() => startRetry());
  return true;
}
