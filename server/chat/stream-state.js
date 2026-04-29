/**
 * Session stream state — 管理 WebSocket 会话的共享流状态
 *
 * 从 server/routes/chat.js 提取。负责 state Map 的 CRUD、淘汰、
 * stale 检测、stream token 生命周期。
 */
import {
  createChatTurnState,
} from "./turn-state.js";
const MAX_SESSION_STATES = 20;
const STALE_EMPTY_STREAM_MS = Number(process.env.LYNN_STALE_EMPTY_STREAM_MS || 90_000);
const STALE_THINKING_STREAM_MS = Number(process.env.LYNN_STALE_THINKING_STREAM_MS || 120_000);

export function createSessionStateStore() {
  const sessionState = new Map();
  let accessSeq = 0;

  function touchState(ss) {
    const now = Date.now();
    ss.lastActivity = now;
    ss.lastAccessTime = now;
    ss.lastAccessSeq = ++accessSeq;
  }

  function evictLeastRecentlyUsed(excludePath) {
    let evictPath = null;
    let evictSeq = Infinity;
    let evictActivity = Infinity;
    for (const [sp, ss] of sessionState) {
      if (sp === excludePath || ss.isStreaming) continue;
      const seq = Number.isFinite(ss.lastAccessSeq) ? ss.lastAccessSeq : 0;
      const activity = Number.isFinite(ss.lastActivity) ? ss.lastActivity : 0;
      if (seq < evictSeq || (seq === evictSeq && activity < evictActivity)) {
        evictPath = sp;
        evictSeq = seq;
        evictActivity = activity;
      }
    }
    if (!evictPath) return false;
    sessionState.delete(evictPath);
    return true;
  }

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      if (sessionState.size >= MAX_SESSION_STATES) {
        evictLeastRecentlyUsed(sessionPath);
      }
      sessionState.set(sessionPath, createChatTurnState());
    }
    const ss = sessionState.get(sessionPath);
    if (ss) touchState(ss);
    return ss;
  }

  function hasState(sessionPath) {
    return sessionState.has(sessionPath);
  }

  function deleteState(sessionPath) {
    sessionState.delete(sessionPath);
  }

  const _sessionEvictTimer = setInterval(() => {
    const now = Date.now();
    for (const [sp, ss] of sessionState) {
      if (!ss.isStreaming && now - (ss.lastActivity || 0) > 300_000) {
        sessionState.delete(sp);
      }
    }
  }, 60_000);
  if (_sessionEvictTimer.unref) _sessionEvictTimer.unref();

  function destroy() {
    clearInterval(_sessionEvictTimer);
    sessionState.clear();
  }

  return { sessionState, getState, hasState, deleteState, destroy };
}

export function isStaleEmptySessionStream(ss, now = Date.now()) {
  if (!ss) return false;
  const elapsed = now - (ss.startedAt || 0);
  const hasUserVisibleProgress = !!(ss.hasOutput || ss.hasToolCall);
  if (hasUserVisibleProgress) return false;
  if (elapsed > STALE_THINKING_STREAM_MS) return true;
  return elapsed > STALE_EMPTY_STREAM_MS && !ss.hasThinking && !ss.hasError;
}

export function resetCompletedTurnState(ss) {
  ss.activeStreamToken = null;
  ss.degenerationAbortRequested = false;
  ss.progressMarkerCount = 0;
  ss._turnEndDeferred = false;
  ss.hasOutput = false;
  ss.hasToolCall = false;
  ss.hasPrefetchToolCall = false;
  ss.hasThinking = false;
  ss.hasError = false;
  ss.thinkTagParser.reset();
  ss.progressParser.reset();
  ss.moodParser.reset();
  ss.xingParser.reset();
  ss.visibleTextAcc = "";
  ss.rawTextAcc = "";
  ss.pseudoToolSteered = false;
  ss.pseudoToolXmlBlock = null;
  ss.successfulToolCount = 0;
  ss.lastSuccessfulTools = [];
  ss.hasFailedTool = false;
  ss.lastFailedTools = [];
  if (ss.__slowToolTimers?.size) {
    for (const timer of ss.__slowToolTimers.values()) {
      try { clearTimeout(timer); } catch { /* timer may already be cleared */ }
    }
    ss.__slowToolTimers.clear();
  }
  ss.toolFinalizationRetryAttempted = false;
  ss.toolFailedFallbackRetryAttempted = false;
}
