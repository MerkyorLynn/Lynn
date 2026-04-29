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
  const streamToken = beginSessionStream(ss);
  ss.activeStreamToken = streamToken;
  ss.streamSource = "internal_retry";
  debugLog()?.log("ws", `[INTERNAL-RETRY v1] opened retry stream · reason=${reason} · session=${sessionPath}`);
  return streamToken;
}

export function scheduleInternalRetry({
  sessionPath, reason, retryPrompt,
  getState, broadcast, hub, engine,
  scheduleSilentBrainAbort, clearSilentBrainAbort,
  closeStreamAfterError, emitStreamEvent,
}) {
  if (!sessionPath || !reason || !String(retryPrompt || "").trim()) return false;
  const ss = getState(sessionPath);
  if (!ss || !canScheduleInternalRetry(ss, reason)) {
    debugLog()?.warn("ws", `[INTERNAL-RETRY v1] skipped · reason=${reason} count=${internalRetryCount(ss, reason)} · session=${sessionPath}`);
    return false;
  }
  markInternalRetry(ss, reason);
  broadcast({ type: "turn_retry", sessionPath, reason });
  const startRetry = async (attempt = 0) => {
    const currentSs = getState(sessionPath);
    if (!currentSs) return;
    if (currentSs.isStreaming || engine.isSessionStreaming(sessionPath)) {
      if (attempt < 100) {
        setTimeout(() => startRetry(attempt + 1), 50);
        return;
      }
      debugLog()?.warn("ws", `[INTERNAL-RETRY v1] abandoned because session stayed streaming · reason=${reason} · session=${sessionPath}`);
      broadcast({ type: "status", isStreaming: false, sessionPath });
      return;
    }
    const streamToken = prepareInternalRetryStream(sessionPath, currentSs, reason);
    broadcast({ type: "status", isStreaming: true, sessionPath });
    scheduleSilentBrainAbort(sessionPath, currentSs);
    let hardTimedOut = false;
    const hardTimeout = setTimeout(() => {
      const timeoutSs = getState(sessionPath);
      if (!timeoutSs || timeoutSs.activeStreamToken !== streamToken || timeoutSs.streamSource !== "internal_retry") return;
      hardTimedOut = true;
      debugLog()?.warn("ws", `[INTERNAL-RETRY-TIMEOUT v1] closing retry stream · reason=${reason} timeout=${INTERNAL_RETRY_HARD_TIMEOUT_MS}ms · session=${sessionPath}`);
      try {
        engine.abortSessionByPath?.(sessionPath).catch(() => {});
      } catch {
        // Abort is best-effort; the stream is closed locally below.
      }
      clearSilentBrainAbort(timeoutSs);
      if (timeoutSs.isThinking) {
        timeoutSs.isThinking = false;
        emitStreamEvent?.(sessionPath, timeoutSs, { type: "thinking_end" });
      }
      if (!timeoutSs.hasOutput) {
        const fallback = reason === "empty_reply"
          ? "本轮回答生成超时，未能拿到稳定文本。请重试一次或换个说法。"
          : "补写回答超时，已保留上方已有内容；如果需要，我可以继续展开或重新整理。";
        emitStreamEvent?.(sessionPath, timeoutSs, { type: "text_delta", delta: fallback });
        timeoutSs.visibleTextAcc += fallback;
        timeoutSs.hasOutput = true;
      }
      emitStreamEvent?.(sessionPath, timeoutSs, { type: "turn_end" });
      broadcast({ type: "status", isStreaming: false, sessionPath });
      finishSessionStream(timeoutSs);
      resetCompletedTurnState(timeoutSs);
    }, INTERNAL_RETRY_HARD_TIMEOUT_MS);
    if (hardTimeout.unref) hardTimeout.unref();
    try {
      await hub.send(retryPrompt, { sessionPath, streamToken });
      if (hardTimedOut) return;
      if (!currentSs.isStreaming) {
        clearTimeout(hardTimeout);
        clearSilentBrainAbort(currentSs);
        broadcast({ type: "status", isStreaming: false, sessionPath });
      } else {
        debugLog()?.warn("ws", `[INTERNAL-RETRY v1] hub.send returned while retry stream remains open; keeping hard timeout armed · reason=${reason} · session=${sessionPath}`);
      }
    } catch (retryErr) {
      clearTimeout(hardTimeout);
      if (hardTimedOut) return;
      clearSilentBrainAbort(currentSs);
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
