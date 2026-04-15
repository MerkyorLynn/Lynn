/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { MoodParser, XingParser, ThinkTagParser } from "../../core/events.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { getLocale, t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import { sanitizeBrainIdentityDisclosureText } from "../../shared/brain-provider.js";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.js";
import {
  buildProviderToolCallHint,
  classifyRouteIntent,
  getRouteIntentNoticeKey,
  looksLikePendingToolExecutionText,
  matchesInstallIntent,
  ROUTE_INTENTS,
} from "../../shared/task-route-intent.js";
import {
  buildEmptyResponseUserMessage,
  buildInstallRecoverySteerText,
  buildInstallRetryPrompt,
  buildInvalidToolSimulationUserMessage,
  buildPseudoToolRecoveryNotice,
  buildPseudoToolRecoverySteerText,
  buildPseudoToolRetryPrompt,
  buildSlowNoticePayload,
  looksLikeManualShellDeflection,
  MAX_PSEUDO_TOOL_MARKERS_WITHOUT_REAL_TOOL,
  MAX_PSEUDO_TOOL_RECOVERY_ATTEMPTS,
  reportEmptyResponse,
  resolveCurrentModelInfo,
} from "../chat/chat-recovery.js";
import {
  buildLocalWorkspaceDirectReply,
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
} from "../chat/local-workspace-context.js";
import { buildReportResearchContext, inferReportResearchKind } from "../chat/report-research-context.js";
import { buildReportStructureHint } from "../../shared/report-normalizer.js";
import {
  recordCurrentProvider,
  recordFallback,
  recordProviderIssue,
  recordToolCall,
} from "../diagnostics.js";

/** tool_start 事件只广播这些 arg 字段，避免传输完整文件内容（同步维护：chat-render-shim.ts extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "key", "value", "action", "type", "schedule", "prompt", "label"];
const ENABLE_LOCAL_TOOL_RECOVERY = process.env.LYNN_ENABLE_LOCAL_TOOL_RECOVERY !== "0";
const DEFAULT_TOOL_EVENT_GRACE_MS = 8_000;
const BRAIN_TOOL_EVENT_GRACE_MS = 5_000;

function appendHiddenRetryContext(engine, sessionPath, context) {
  const text = String(context || "").trim();
  if (!text) return false;
  try {
    const session = engine.getSessionByPath?.(sessionPath);
    const sessionManager = session?.sessionManager;
    if (typeof sessionManager?.appendCustomMessageEntry !== "function") return false;
    sessionManager.appendCustomMessageEntry("lynn.tool-recovery", text, false, {
      source: "local-tool-recovery",
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    debugLog()?.warn?.("ws", `append hidden retry context failed: ${err?.message || err}`);
    return false;
  }
}

function appendSessionMessage(engine, sessionPath, message) {
  try {
    const session = engine.getSessionByPath?.(sessionPath);
    const sessionManager = session?.sessionManager;
    if (typeof sessionManager?.appendMessage !== "function") return false;
    sessionManager.appendMessage(message);
    return true;
  } catch (err) {
    debugLog()?.warn?.("ws", `append session message failed: ${err?.message || err}`);
    return false;
  }
}

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function resolveLocalPrefetchToolMeta(kind, promptText) {
  const query = String(promptText || "").trim();
  const normalized = String(kind || "").trim();
  const common = { query, type: normalized || "research", source: "local-prefetch" };
  if (normalized === "weather") return { name: "weather", args: common };
  if (normalized === "sports") return { name: "sports_score", args: common };
  if (normalized === "market" || normalized === "stock") return { name: "stock_market", args: common };
  if (normalized === "news") return { name: "live_news", args: common };
  if (normalized === "real_estate" || normalized === "generic") return { name: "web_search", args: common };
  return { name: "web_search", args: common };
}

function buildLocalPrefetchToolSummary(contextText, kind) {
  const text = String(contextText || "").trim();
  return {
    outputPreview: text
      ? text.replace(/\s+/g, " ").slice(0, 220)
      : `No local ${kind || "research"} evidence was collected.`,
    matchCount: text ? Math.max(1, Math.min(9, (text.match(/查询：|URL:|【/g) || []).length)) : 0,
    source: "local-prefetch",
  };
}

/**
 * 从 Pi SDK 的 content 块中提取纯文本
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("");
}

function getRecentConversationText(engine, sessionPath, maxChars = 6000) {
  try {
    const session = engine.getSessionByPath?.(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const text = messages.slice(-8).map((message) => {
      const role = message?.role || "message";
      const content = extractText(message?.content);
      return content ? `${role}: ${content}` : "";
    }).filter(Boolean).join("\n\n");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function resolveEditSnapshotPath(session, engine, rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
  return path.resolve(cwd, trimmed);
}

export function createChatRoute(engine, hub, { upgradeWebSocket }) {
  const restRoute = new Hono();
  const wsRoute = new Hono();

  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const sessionState = new Map(); // sessionPath -> shared stream state

  // ── Per-client rate limiting (token bucket) ──
  const _wsRateLimits = new WeakMap();
  const RATE_TOKENS = 5;       // max burst
  const RATE_REFILL_MS = 10000; // refill interval

  function checkRateLimit(ws) {
    let bucket = _wsRateLimits.get(ws);
    if (!bucket) {
      bucket = { tokens: RATE_TOKENS, lastRefill: Date.now() };
      _wsRateLimits.set(ws, bucket);
    }
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= RATE_REFILL_MS) {
      const refills = Math.floor(elapsed / RATE_REFILL_MS);
      bucket.tokens = Math.min(RATE_TOKENS, bucket.tokens + refills * RATE_TOKENS);
      bucket.lastRefill += refills * RATE_REFILL_MS;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens--;
    return true;
  }

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

      // 中断所有正在 streaming 的 owner session（焦点 + 后台）
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  const MAX_SESSION_STATES = 20;

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      // 超过上限时，淘汰非流式的旧 entry
      if (sessionState.size >= MAX_SESSION_STATES) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== sessionPath) {
            sessionState.delete(sp);
            if (sessionState.size < MAX_SESSION_STATES) break;
          }
        }
      }
      sessionState.set(sessionPath, {
        thinkTagParser: new ThinkTagParser(),
        moodParser: new MoodParser(),
        xingParser: new XingParser(),
        isThinking: false,
        hasOutput: false,
        hasToolCall: false,
        hasThinking: false,
        hasError: false,
        rawTextAcc: "",
        cleanTextAcc: "",
        pseudoToolSimulationDetected: false,
        pseudoToolSimulationSteered: false,
        pseudoToolMarkerCount: 0,
        pseudoToolAbortRequested: false,
        pseudoToolNeedsRetry: false,
        pseudoToolRetryCount: 0,
        missingToolExecutionDetected: false,
        localEvidencePrefetched: false,
        routeNoticeSent: false,
        installPrompt: false,
        installDeflectionDetected: false,
        pendingToolExecutionDetected: false,
        titleRequested: false,
        titlePreview: "",
        lastActivity: Date.now(),
        routeIntent: ROUTE_INTENTS.CHAT,
        ...createSessionStreamState(),
      });
    }
    const ss = sessionState.get(sessionPath);
    if (ss) ss.lastActivity = Date.now();
    return ss;
  }

  // ── Idle session state eviction (every 60s, evict entries idle > 5 min) ──
  const _sessionEvictTimer = setInterval(() => {
    const now = Date.now();
    for (const [sp, ss] of sessionState) {
      if (!ss.isStreaming && now - (ss.lastActivity || 0) > 300_000) {
        sessionState.delete(sp);
      }
    }
  }, 60_000);
  if (_sessionEvictTimer.unref) _sessionEvictTimer.unref();

  const clients = new Set();

  const pendingEditSnapshots = new Map(); // toolCallId -> { filePath, originalContent, sessionPath }
  const rollbackSnapshots = new Map(); // rollbackId -> snapshot
  const rollbackOrder = [];
  const MAX_ROLLBACK_SNAPSHOTS = 200;

  const editRollbackStore = {
    get(rollbackId) {
      return rollbackSnapshots.get(rollbackId) || null;
    },
    setPending(toolCallId, snapshot) {
      if (!toolCallId || !snapshot) return;
      pendingEditSnapshots.set(toolCallId, snapshot);
    },
    discardPending(toolCallId) {
      if (!toolCallId) return;
      pendingEditSnapshots.delete(toolCallId);
    },
    finalize(toolCallId) {
      if (!toolCallId) return null;
      const snapshot = pendingEditSnapshots.get(toolCallId);
      pendingEditSnapshots.delete(toolCallId);
      if (!snapshot) return null;

      const rollbackId = toolCallId;
      if (!rollbackSnapshots.has(rollbackId)) rollbackOrder.push(rollbackId);
      rollbackSnapshots.set(rollbackId, {
        rollbackId,
        createdAt: Date.now(),
        ...snapshot,
      });

      while (rollbackOrder.length > MAX_ROLLBACK_SNAPSHOTS) {
        const oldestId = rollbackOrder.shift();
        if (oldestId) rollbackSnapshots.delete(oldestId);
      }

      return rollbackSnapshots.get(rollbackId);
    },
  };

  function broadcast(msg) {
    for (const client of clients) {
      wsSend(client, msg);
    }
  }

  // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const entry = appendSessionStreamEvent(ss, event);
    // Phase 4: 始终广播所有事件，前端按 sessionPath 路由到对应 panel
    broadcast({
      ...event,
      sessionPath,
      streamId: entry.streamId,
      seq: entry.seq,
    });
    return entry;
  }

  function resetTextTracking(ss, opts = {}) {
    const preserveRetry = !!opts.preserveRetry;
    const preserveRetryCount = !!opts.preserveRetryCount;
    const preserveRecoveryCause = !!opts.preserveRecoveryCause || preserveRetry;
    ss.rawTextAcc = "";
    ss.cleanTextAcc = "";
    ss.pseudoToolSimulationDetected = false;
    ss.pseudoToolSimulationSteered = false;
    ss.pseudoToolMarkerCount = 0;
    ss.pseudoToolAbortRequested = false;
    if (!preserveRetry) ss.pseudoToolNeedsRetry = false;
    if (!preserveRetryCount) ss.pseudoToolRetryCount = 0;
    ss.toolCallWithoutText = false;
    if (!preserveRecoveryCause) {
      ss.missingToolExecutionDetected = false;
      ss.installDeflectionDetected = false;
      ss.pendingToolExecutionDetected = false;
    }
  }

  function shouldRecoverMissingToolExecution(ss, currentModelInfo, attemptIndex) {
    if (!ss || ss.hasToolCall || ss.hasError || ss.pseudoToolAbortRequested) return false;
    if (ss.pendingToolExecutionDetected) return true;
    if (ss.localEvidencePrefetched) return false;
    if (!currentModelInfo?.isBrain || attemptIndex > 0) return false;
    return !ss.hasOutput && !ss.hasThinking;
  }

  function emitSanitizedTextDelta(sessionPath, ss, rawDelta) {
    if (!rawDelta) return;

    ss.rawTextAcc += rawDelta;
    const cleanText = sanitizeBrainIdentityDisclosureText(stripPseudoToolCallMarkup(ss.rawTextAcc));
    const prevCleanText = ss.cleanTextAcc || "";
    const currentModelInfo = resolveCurrentModelInfo(engine);
    const pseudoDetected = !currentModelInfo.isBrain
      && (containsPseudoToolSimulation(rawDelta) || containsPseudoToolSimulation(ss.rawTextAcc));

    if (ENABLE_LOCAL_TOOL_RECOVERY && pseudoDetected) {
      ss.pseudoToolSimulationDetected = true;
      ss.pseudoToolMarkerCount = Math.max(ss.pseudoToolMarkerCount || 0, countPseudoToolMarkers(ss.rawTextAcc));
      if (!ss.hasToolCall && !ss.pseudoToolSimulationSteered && engine.steerSession(sessionPath, buildPseudoToolRecoverySteerText())) {
        ss.pseudoToolSimulationSteered = true;
        broadcast(buildPseudoToolRecoveryNotice(engine, sessionPath, ss.routeIntent));
      }
      if (!ss.hasToolCall
        && !ss.pseudoToolAbortRequested
        && (ss.pseudoToolMarkerCount || 0) >= MAX_PSEUDO_TOOL_MARKERS_WITHOUT_REAL_TOOL) {
        ss.pseudoToolAbortRequested = true;
        ss.pseudoToolNeedsRetry = true;
        queueMicrotask(() => {
          engine.abortSessionByPath(sessionPath).catch(() => {});
        });
      }
    }

    if (ENABLE_LOCAL_TOOL_RECOVERY && ss.installPrompt && !ss.hasToolCall && looksLikeManualShellDeflection(cleanText)) {
      ss.installDeflectionDetected = true;
      if (!ss.pseudoToolAbortRequested) {
        ss.pseudoToolAbortRequested = true;
        queueMicrotask(() => {
          engine.abortSessionByPath(sessionPath).catch(() => {});
        });
      }
    }

    if (ENABLE_LOCAL_TOOL_RECOVERY && !ss.hasToolCall && !ss.hasError && looksLikePendingToolExecutionText(cleanText, ss.routeIntent)) {
      ss.pendingToolExecutionDetected = true;
    }

    if (cleanText.trim()) ss.hasOutput = true;

    let delta = "";
    if (cleanText.startsWith(prevCleanText)) {
      delta = cleanText.slice(prevCleanText.length);
    } else if (!prevCleanText.startsWith(cleanText)) {
      delta = cleanText;
    }
    ss.cleanTextAcc = cleanText;

    if (delta) {
      ss.titlePreview += delta || "";
      emitStreamEvent(sessionPath, ss, { type: "text_delta", delta });
      maybeGenerateFirstTurnTitle(sessionPath, ss);
    }
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  function resolveSessionCwd(sessionPath) {
    const activeSession = engine.getSessionByPath?.(sessionPath);
    return activeSession?.sessionManager?.getCwd?.()
      || engine.homeCwd
      || engine.cwd
      || process.cwd();
  }

  function handleLocalWorkspaceDirect(promptText, sessionPath, ss) {
    if (!ENABLE_LOCAL_TOOL_RECOVERY || !sessionPath || !ss) return false;
    const routeIntent = classifyRouteIntent(promptText);
    if (!shouldAttachLocalWorkspaceContext(promptText, routeIntent)) return false;

    const cwd = resolveSessionCwd(sessionPath);
    const reply = buildLocalWorkspaceDirectReply({ promptText, cwd });
    const text = reply.text || "";
    if (!text.trim()) return false;

    resetTextTracking(ss);
    ss.routeIntent = routeIntent;
    ss.hasToolCall = true;
    ss.hasOutput = true;
    beginSessionStream(ss);
    broadcast({ type: "status", isStreaming: true, sessionPath });

    appendSessionMessage(engine, sessionPath, {
      role: "user",
      content: [{ type: "text", text: promptText }],
    });

    const toolArgs = { path: reply.root || cwd };
    emitStreamEvent(sessionPath, ss, { type: "tool_start", name: "ls", args: toolArgs });
    recordToolCall({ phase: "start", name: "ls", sessionPath, args: toolArgs });
    emitStreamEvent(sessionPath, ss, {
      type: "tool_end",
      name: "ls",
      success: reply.ok !== false,
      details: {
        path: reply.root || cwd,
        entriesCount: reply.entriesCount || 0,
        docsCount: reply.docsCount || 0,
        source: "local-workspace-direct",
      },
      summary: {
        outputPreview: text.slice(0, 200),
        matchCount: reply.entriesCount || 0,
      },
    });
    recordToolCall({ phase: "end", name: "ls", sessionPath, args: toolArgs });

    emitSanitizedTextDelta(sessionPath, ss, text);
    appendSessionMessage(engine, sessionPath, {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: createZeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    finishSessionStream(ss);
    broadcast({ type: "status", isStreaming: false, sessionPath });
    maybeGenerateFirstTurnTitle(sessionPath, ss);
    debugLog()?.log("ws", "local workspace direct reply done");
    return true;
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event, sessionPath) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? getState(sessionPath) : null;

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
        // ThinkTagParser（最外层）→ MoodParser → XingParser
        ss.thinkTagParser.feed(delta, (tEvt) => {
          switch (tEvt.type) {
            case "think_start":
              emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
              break;
            case "think_text":
              emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
              break;
            case "think_end":
              emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
              break;
            case "text":
              // 非 think 内容继续走 MoodParser → XingParser 链
              ss.moodParser.feed(tEvt.data, (evt) => {
                switch (evt.type) {
                  case "text":
                    ss.xingParser.feed(evt.data, (xEvt) => {
                      switch (xEvt.type) {
                        case "text":
                          emitSanitizedTextDelta(sessionPath, ss, xEvt.data);
                          break;
                        case "xing_start":
                          ss.hasXing = true;
                          emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                          break;
                        case "xing_text":
                          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                          break;
                        case "xing_end":
                          emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                          break;
                      }
                    });
                    break;
                  case "mood_start":
                    emitStreamEvent(sessionPath, ss, { type: "mood_start" });
                    break;
                  case "mood_text":
                    emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
                    break;
                  case "mood_end":
                    emitStreamEvent(sessionPath, ss, { type: "mood_end" });
                    break;
                }
              });
              break;
          }
        });
      } else if (sub === "thinking_delta") {
        ss.hasThinking = true;
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "error") {
        ss.hasError = true;
        if (isActive) broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error" });
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      recordToolCall({
        phase: "start",
        name: event.toolName || "",
        sessionPath,
        args: event.args || null,
      });
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }

      if ((event.toolName === "edit" || event.toolName === "edit-diff") && event.toolCallId) {
        const session = engine.getSessionByPath(sessionPath);
        const rawPath = event.args?.file_path || event.args?.path || "";
        const resolvedPath = resolveEditSnapshotPath(session, engine, rawPath);

        if (resolvedPath) {
          try {
            const originalContent = fs.readFileSync(resolvedPath, "utf-8");
            editRollbackStore.setPending(event.toolCallId, {
              sessionPath,
              cwd: session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd(),
              filePath: resolvedPath,
              originalContent,
            });
          } catch {
            editRollbackStore.discardPending(event.toolCallId);
          }
        }
      }

      // 只保留前端 extractToolDetail 需要的字段，避免广播完整文件内容
      const rawArgs = event.args;
      let args;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgs[k] !== undefined) args[k] = rawArgs[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;

      // 构建前端友好的工具结果摘要
      const rawDetails = event.result?.details || {};
      const toolSummary = {};
      const toolName = event.toolName || "";

      if (toolName === "edit" || toolName === "edit-diff") {
        // edit 工具返回 diff 和 firstChangedLine
        if (rawDetails.diff) {
          const lines = rawDetails.diff.split("\n");
          let added = 0, removed = 0;
          for (const l of lines) {
            if (l.startsWith("+") && !l.startsWith("+++")) added++;
            if (l.startsWith("-") && !l.startsWith("---")) removed++;
          }
          toolSummary.linesAdded = added;
          toolSummary.linesRemoved = removed;
          toolSummary.filePath = event.args?.file_path || event.args?.path || "";
        }
      } else if (toolName === "write") {
        toolSummary.filePath = event.args?.file_path || event.args?.path || "";
        // 从 result content 中提取写入的字节数信息
        const text = extractText(event.result?.content);
        const bytesMatch = text.match(/(\d+)\s*bytes/i);
        if (bytesMatch) toolSummary.bytesWritten = parseInt(bytesMatch[1], 10);
      } else if (toolName === "bash") {
        const text = extractText(event.result?.content);
        // 取输出的前 200 字符作为预览
        if (text) toolSummary.outputPreview = text.slice(0, 200);
        toolSummary.command = (event.args?.command || "").slice(0, 80);
        if (rawDetails.truncation) {
          toolSummary.totalLines = rawDetails.truncation.totalLines;
          toolSummary.truncated = true;
        }
      } else if (toolName === "grep" || toolName === "glob" || toolName === "find") {
        const text = extractText(event.result?.content);
        if (text) {
          const matchLines = text.trim().split("\n").filter(Boolean);
          toolSummary.matchCount = matchLines.length;
          toolSummary.outputPreview = matchLines.slice(0, 5).join("\n");
        }
      } else if (toolName === "web_search") {
        const text = extractText(event.result?.content);
        if (text) toolSummary.outputPreview = text.slice(0, 200);
      } else if (toolName === "read") {
        toolSummary.filePath = event.args?.file_path || event.args?.path || "";
        const text = extractText(event.result?.content);
        if (text) {
          const lineCount = text.split("\n").length;
          toolSummary.lineCount = lineCount;
        }
      }

      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: toolName,
        success: !event.isError,
        details: rawDetails,
        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
      });
      recordToolCall({
        phase: "end",
        name: toolName,
        sessionPath,
        success: !event.isError,
        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
        error: event.isError ? extractText(event.result?.content) : null,
      });

      if ((toolName === "edit" || toolName === "edit-diff") && event.toolCallId) {
        if (event.isError || !rawDetails.diff) {
          editRollbackStore.discardPending(event.toolCallId);
        }
      }

      if (event.toolName === "present_files") {
        const details = event.result?.details || {};
        const files = details.files || [];
        if (files.length === 0 && details.filePath) {
          files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
        }
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "",
          });
        }
      }

      // 编辑类工具完成后发送 file_diff 事件（内联 diff 查看器）
      if ((event.toolName === "edit" || event.toolName === "edit-diff") && rawDetails.diff && !event.isError) {
        const diffFilePath = event.args?.file_path || event.args?.path || "";
        const rollback = event.toolCallId ? editRollbackStore.finalize(event.toolCallId) : null;
        emitStreamEvent(sessionPath, ss, {
          type: "file_diff",
          filePath: diffFilePath,
          diff: rawDetails.diff,
          linesAdded: toolSummary.linesAdded || 0,
          linesRemoved: toolSummary.linesRemoved || 0,
          rollbackId: rollback?.rollbackId,
        });
      }

      if (event.toolName === "create_artifact") {
        const d = event.result?.details || {};
        emitStreamEvent(sessionPath, ss, {
          type: "artifact",
          artifactId: d.artifactId,
          artifactType: d.type,
          title: d.title,
          content: d.content,
          language: d.language,
        });
      }

      if (event.toolName === "create_pptx") {
        const details = event.result?.details || {};
        const files = details.files || [];
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "pptx",
          });
        }
      }

      if (event.toolName === "create_poster") {
        const d = event.result?.details || {};
        if (d.artifactId) {
          emitStreamEvent(sessionPath, ss, {
            type: "artifact",
            artifactId: d.artifactId,
            artifactType: d.type || "html",
            title: d.title,
            content: d.content,
          });
        }
        const files = d.files || [];
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, { type: "file_output", filePath: f.filePath, label: f.label, ext: f.ext || "html" });
        }
      }

      if (event.toolName === "create_report") {
        const d = event.result?.details || {};
        if (d.artifactId) {
          emitStreamEvent(sessionPath, ss, {
            type: "artifact",
            artifactId: d.artifactId,
            artifactType: d.type || "html",
            title: d.title,
            content: d.content,
          });
        }
        const files = d.files || [];
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "html",
          });
        }
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        if (d.action === "screenshot" && event.result?.content) {
          const imgBlock = event.result.content.find(c => c.type === "image");
          if (imgBlock?.data) {
            emitStreamEvent(sessionPath, ss, {
              type: "browser_screenshot",
              base64: imgBlock.data,
              mimeType: imgBlock.mimeType || "image/jpeg",
            });
          }
        }

        const statusMsg = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) statusMsg.thumbnail = d.thumbnail;
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else stopBrowserThumbPoll();
      }

      if (event.toolName === "cron") {
        const d = event.result?.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      if (isActive && ["write", "edit", "bash"].includes(event.toolName)) {
        broadcast({ type: "desk_changed" });
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url });
    } else if (event.type === "cron_confirmation" && event.confirmId) {
      // 新的阻塞式 cron 确认（通过 emitEvent 触发）
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "cron_confirmation",
        confirmId: event.confirmId,
        jobData: event.jobData,
      });
    } else if (event.type === "settings_confirmation") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "settings_confirmation",
        confirmId: event.confirmId,
        settingKey: event.settingKey,
        cardType: event.cardType,
        currentValue: event.currentValue,
        proposedValue: event.proposedValue,
        options: event.options,
        optionLabels: event.optionLabels || null,
        label: event.label,
        description: event.description,
        frontend: event.frontend,
      });
    } else if (event.type === "tool_authorization") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "tool_authorization",
        confirmId: event.confirmId,
        command: event.command,
        reason: event.reason,
        description: event.description,
        category: event.category,
        identifier: event.identifier,
        trustedRoot: event.trustedRoot || null,
      });
    } else if (event.type === "skill_activated") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "skill_activated",
        skillName: event.skillName,
        skillFilePath: event.skillFilePath,
      });
    } else if (event.type === "confirmation_resolved") {
      broadcast({
        type: "confirmation_resolved",
        confirmId: event.confirmId,
        action: event.action,
        value: event.value,
      });
    } else if (event.type === "apply_frontend_setting") {
      broadcast({
        type: "apply_frontend_setting",
        key: event.key,
        value: event.value,
      });
    } else if (event.type === "task_update") {
      broadcast({ type: "task_update", task: event.task });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "bridge_message") {
      broadcast({ type: "bridge_message", message: event.message });
    } else if (event.type === "bridge_status") {
      broadcast({ type: "bridge_status", platform: event.platform, status: event.status, error: event.error });
    } else if (event.type === "plan_mode") {
      broadcast({ type: "plan_mode", enabled: event.enabled });
    } else if (event.type === "security_mode") {
      broadcast({ type: "security_mode", mode: event.mode });
    } else if (event.type === "notification") {
      broadcast({ type: "notification", title: event.title, body: event.body });
    } else if (event.type === "channel_new_message") {
      broadcast({ type: "channel_new_message", channelName: event.channelName, sender: event.sender });
    } else if (event.type === "channel_archived") {
      broadcast({
        type: "channel_archived",
        channelName: event.channelName,
        archived: event.archived ?? true,
        archivedAt: event.archivedAt || null,
      });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "turn_end") {
      if (!ss) return;
      // 关闭结构化 thinking（如有）——必须在 flush 之前，否则前端收不到 thinking_end
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // flush 顺序：ThinkTag → Mood → Xing（和 feed 顺序一致）
      // flush 内部的 mood → xing 管线（thinkTag flush 和 mood flush 共用）
      const feedMoodPipeline = (text) => {
        ss.moodParser.feed(text, (evt) => {
          if (evt.type === "text") {
            ss.xingParser.feed(evt.data, (xEvt) => {
              switch (xEvt.type) {
                case "text":
                  emitSanitizedTextDelta(sessionPath, ss, xEvt.data);
                  break;
                case "xing_start":
                  emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                  break;
                case "xing_text":
                  emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                  break;
                case "xing_end":
                  emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                  break;
              }
            });
          } else if (evt.type === "mood_start") {
            emitStreamEvent(sessionPath, ss, { type: "mood_start" });
          } else if (evt.type === "mood_text") {
            emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
          } else if (evt.type === "mood_end") {
            emitStreamEvent(sessionPath, ss, { type: "mood_end" });
          }
        });
      };
      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedMoodPipeline(tEvt.data);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          ss.xingParser.feed(evt.data, (xEvt) => {
            switch (xEvt.type) {
              case "text":
                emitSanitizedTextDelta(sessionPath, ss, xEvt.data);
                break;
              case "xing_start":
                emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                break;
              case "xing_text":
                emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                break;
              case "xing_end":
                emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                break;
            }
          });
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        }
      });
      ss.xingParser.flush((xEvt) => {
        if (xEvt.type === "text") {
          emitSanitizedTextDelta(sessionPath, ss, xEvt.data);
        } else if (xEvt.type === "xing_text") {
          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        }
      });

      if (ENABLE_LOCAL_TOOL_RECOVERY && ss.pseudoToolSimulationDetected && !ss.hasToolCall && !ss.hasError) {
        ss.pseudoToolNeedsRetry = true;
      }
      if (ENABLE_LOCAL_TOOL_RECOVERY && ss.pendingToolExecutionDetected && !ss.hasToolCall && !ss.hasError) {
        ss.pseudoToolNeedsRetry = true;
      }

      // 工具调了/只有反思/只有思考但没有文字输出：标记为可恢复场景，下一轮追加提示
      if (!ss.hasOutput && !ss.hasError && isActive && (ss.hasToolCall || ss.hasThinking || ss.hasXing)) {
        ss.toolCallWithoutText = true;
        ss._recoveryHadToolCall = ss.hasToolCall; // 保存原始值，重置后恢复逻辑需要
      }

      // 空回复检测：本轮没有任何有效输出（无文本、无工具、无思考）。
      if (!ss.pseudoToolNeedsRetry && !ss.pseudoToolSimulationDetected && !ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError && isActive) {
        reportEmptyResponse(engine, sessionPath);
        broadcast({ type: "error", message: buildEmptyResponseUserMessage(engine) });
      }

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      ss.hasOutput = false;
      ss.hasToolCall = false;
      ss.hasThinking = false;
      ss.hasXing = false;
      ss.hasError = false;
      ss.routeIntent = ROUTE_INTENTS.CHAT;
      ss.localEvidencePrefetched = false;
      ss.routeNoticeSent = false;
      resetTextTracking(ss, {
        preserveRetry: ss.pseudoToolNeedsRetry,
        preserveRetryCount: ss.pseudoToolNeedsRetry,
      });
      ss.thinkTagParser.reset();
      ss.moodParser.reset();
      ss.xingParser.reset();

      if (isActive) debugLog()?.log("ws", "assistant reply done");
      maybeGenerateFirstTurnTitle(sessionPath, ss);
    } else if (event.type === "auto_compaction_start") {
      broadcast({ type: "compaction_start", sessionPath });
    } else if (event.type === "auto_compaction_end") {
      const s = engine.getSessionByPath(sessionPath);
      const usage = s?.getContextUsage?.();
      broadcast({
        type: "compaction_end",
        sessionPath,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
      });
    } else if (event.type === "session_relay") {
      broadcast({
        type: "session_relay",
        oldSessionPath: event.oldSessionPath || sessionPath,
        newSessionPath: event.newSessionPath || null,
        summary: event.summary || "",
        summaryTokens: event.summaryTokens ?? null,
        compactionCount: event.compactionCount ?? null,
        reason: event.reason || "auto_compaction_limit",
      });
    }
  });

  // ── WebSocket 路由（挂载在 wsRoute，由 index.js 挂到根路径） ──

  wsRoute.get("/ws",
    upgradeWebSocket((c) => {
      let closed = false;

      return {
        onOpen(event, ws) {
          activeWsClients++;
          clients.add(ws);
          cancelDisconnectAbort();
          debugLog()?.log("ws", "client connected");
        },

        onMessage(event, ws) {
          // Hono @hono/node-ws delivers event.data as a string for text frames
          const msg = wsParse(event.data);
          if (!msg) return;

          // Wrap the async handler with error handling (replaces wrapWsHandler)
          (async () => {
            if (msg.type === "abort") {
              const abortPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.isSessionStreaming(abortPath)) {
                try { await hub.abort(abortPath); } catch {}
              }
              return;
            }

            if (msg.type === "steer" && msg.text) {
              debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
              const steerPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.steerSession(steerPath, msg.text)) {
                wsSend(ws, { type: "steered" });
                return;
              }
              // agent 已停止，降级为正常 prompt（下面的 prompt 分支会处理）
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

            // session 切回时，前端请求补发离屏期间的流式内容
            if (msg.type === "resume_stream") {
              const currentPath = msg.sessionPath || engine.currentSessionPath;
              const ss = sessionState.get(currentPath);
              if (ss) {
                const resumed = resumeSessionStream(ss, {
                  streamId: msg.streamId,
                  sinceSeq: msg.sinceSeq,
                });
                wsSend(ws, {
                  type: "stream_resume",
                  sessionPath: currentPath,
                  streamId: resumed.streamId,
                  sinceSeq: resumed.sinceSeq,
                  nextSeq: resumed.nextSeq,
                  reset: resumed.reset,
                  truncated: resumed.truncated,
                  isStreaming: resumed.isStreaming,
                  events: resumed.events,
                });
              } else {
                wsSend(ws, {
                  type: "stream_resume",
                  sessionPath: currentPath,
                  streamId: null,
                  sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, msg.sinceSeq) : 0,
                  nextSeq: 1,
                  reset: false,
                  truncated: false,
                  isStreaming: false,
                  events: [],
                });
              }
              return;
            }

            if (msg.type === "context_usage") {
              const usagePath = msg.sessionPath || engine.currentSessionPath;
              const usageSession = engine.getSessionByPath(usagePath);
              const usage = usageSession?.getContextUsage?.();
              wsSend(ws, {
                type: "context_usage",
                sessionPath: usagePath,
                tokens: usage?.tokens ?? null,
                contextWindow: usage?.contextWindow ?? null,
                percent: usage?.percent ?? null,
              });
              return;
            }

            if (msg.type === "compact") {
              const compactPath = msg.sessionPath || engine.currentSessionPath;
              const session = engine.getSessionByPath(compactPath);
              if (!session) {
                wsSend(ws, { type: "error", message: t("error.noActiveSession") });
                return;
              }
              if (session.isCompacting) {
                wsSend(ws, { type: "error", message: t("error.compacting") });
                return;
              }
              if (engine.isSessionStreaming(compactPath)) {
                wsSend(ws, { type: "error", message: t("error.waitForReply") });
                return;
              }
              broadcast({ type: "compaction_start", sessionPath: compactPath });
              try {
                await session.compact();
                const usage = session.getContextUsage?.();
                broadcast({
                  type: "compaction_end",
                  sessionPath: compactPath,
                  tokens: usage?.tokens ?? null,
                  contextWindow: usage?.contextWindow ?? null,
                  percent: usage?.percent ?? null,
                });
              } catch (err) {
                const errMsg = err.message || "";
                if (errMsg.includes("Already compacted") || errMsg.includes("Nothing to compact")) {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                } else {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                  wsSend(ws, { type: "error", message: t("error.compactFailed", { msg: errMsg }) });
                }
              }
              return;
            }

            if (msg.type === "toggle_plan_mode") {
              const current = engine.planMode;
              engine.setPlanMode(!current);
              broadcast({ type: "plan_mode", enabled: !current });
              broadcast({ type: "security_mode", mode: !current ? "plan" : "authorized" });
              return;
            }

            if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
              // Rate limit check
              if (!checkRateLimit(ws)) {
                wsSend(ws, { type: "error", message: "Rate limit exceeded. Please wait before sending another message." });
                return;
              }
              // 图片校验：最多 10 张，单张 ≤ 20MB，仅允许常见图片 MIME
              if (msg.images?.length) {
                const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
                const MAX_IMAGES = 10;
                const MAX_BYTES = 20 * 1024 * 1024; // 20MB base64 ≈ 15MB 原始
                if (msg.images.length > MAX_IMAGES) {
                  wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }) });
                  return;
                }
                for (const img of msg.images) {
                  if (!img?.mimeType || !ALLOWED_MIME.has(img.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }) });
                    return;
                  }
                  if (img.data && img.data.length > MAX_BYTES) {
                    wsSend(ws, { type: "error", message: t("error.imageTooLarge") });
                    return;
                  }
                }
              }
              // 非 vision 模型：静默剥离图片，只发文字。不拦截、不报错。
              // vision 未知（undefined）的模型：放行，让 API 决定。
              const _resolved = engine.resolveModelOverrides(engine.currentModel);
              if (msg.images?.length && _resolved?.vision === false) {
                msg.images = undefined;
              }
              // 只发图片没文字时补一个占位文本，防止空 text 导致某些 API 异常
              let promptText = msg.text || "";
              if (!promptText.trim() && msg.images?.length) {
                promptText = t("error.viewImage");
              }
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
              // Phase 2: 客户端可指定 sessionPath，否则用焦点 session
              const promptSessionPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.isSessionStreaming(promptSessionPath)) {
                wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
                return;
              }
              const ss = getState(promptSessionPath);
              if (!msg.images?.length && handleLocalWorkspaceDirect(promptText, promptSessionPath, ss)) {
                return;
              }
              try {
                const prepareAttemptState = (attemptIndex) => {
                  ss.routeIntent = classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 });
                  ss.thinkTagParser.reset();
                  ss.moodParser.reset();
                  ss.xingParser.reset();
                  resetTextTracking(ss, { preserveRetryCount: attemptIndex > 0 });
                  ss.titleRequested = false;
                  ss.titlePreview = "";
                  ss.hasOutput = false;
                  ss.hasToolCall = false;
                  ss.hasThinking = false;
                  ss.hasError = false;
                  ss.installPrompt = matchesInstallIntent(promptText);
                  if (attemptIndex > 0) {
                    ss.pseudoToolRetryCount = attemptIndex;
                  }
                };

                const sendPromptAttempt = async (attemptText, attemptIndex) => {
                  prepareAttemptState(attemptIndex);
                  const reuseLocalPrefetchStream = attemptIndex === 0 && ss.isStreaming;
                  if (!reuseLocalPrefetchStream) beginSessionStream(ss);
                  broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
                  if (attemptIndex === 0 && !ss.routeNoticeSent) {
                    const routeNoticeKey = getRouteIntentNoticeKey(ss.routeIntent);
                    if (routeNoticeKey) {
                      broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath, noticeKey: routeNoticeKey });
                      ss.routeNoticeSent = true;
                    }
                  }
                  const STREAM_SLOW_MS = 15_000;
                  const STREAM_STILL_WORKING_MS = 30_000;
                  const currentModelInfo = resolveCurrentModelInfo(engine);
                  const toolEventGraceMs = currentModelInfo.isBrain ? BRAIN_TOOL_EVENT_GRACE_MS : DEFAULT_TOOL_EVENT_GRACE_MS;
                  const slowNoticeStartedAt = Date.now();
                  let slowStreamInterval = null;
                  let missingToolExecutionTimer = null;
                  const shouldShowSlowNotice = () =>
                    !ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError;
                  const broadcastSlowNotice = () => {
                    if (!shouldShowSlowNotice()) {
                      if (slowStreamInterval) {
                        clearInterval(slowStreamInterval);
                        slowStreamInterval = null;
                      }
                      return;
                    }
                    const elapsedMs = Date.now() - slowNoticeStartedAt;
                    broadcast(buildSlowNoticePayload(engine, promptSessionPath, ss.routeIntent, elapsedMs));
                  };
                  const slowStreamTimer = setTimeout(() => {
                    broadcastSlowNotice();
                    slowStreamInterval = setInterval(broadcastSlowNotice, STREAM_STILL_WORKING_MS);
                  }, STREAM_SLOW_MS);
                  if (ENABLE_LOCAL_TOOL_RECOVERY && [ROUTE_INTENTS.UTILITY, ROUTE_INTENTS.CODING].includes(ss.routeIntent)) {
                    missingToolExecutionTimer = setTimeout(() => {
                      if (!shouldRecoverMissingToolExecution(ss, currentModelInfo, attemptIndex)) return;
                      ss.missingToolExecutionDetected = !ss.pendingToolExecutionDetected;
                      ss.pseudoToolNeedsRetry = true;
                      ss.pseudoToolAbortRequested = true;
                      broadcast(buildPseudoToolRecoveryNotice(engine, promptSessionPath, ss.routeIntent));
                      engine.abortSessionByPath(promptSessionPath).catch(() => {});
                    }, toolEventGraceMs);
                  }
                  try {
                    await hub.send(attemptText, msg.images ? { images: msg.images, sessionPath: promptSessionPath } : { sessionPath: promptSessionPath });
                    return null;
                  } catch (err) {
                    return err;
                  } finally {
                    clearTimeout(slowStreamTimer);
                    if (slowStreamInterval) clearInterval(slowStreamInterval);
                    if (missingToolExecutionTimer) clearTimeout(missingToolExecutionTimer);
                    broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                  }
                };

                const promptRouteIntent = classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 });
                ss.routeIntent = promptRouteIntent;
                ss.localEvidencePrefetched = false;
                ss.routeNoticeSent = false;

                // Brain 模式下检测需要本地工具的意图 → 引导用户
                const LOCAL_OP_RE = /整理桌面|整理工作区|整理文件|改文件|移动文件|删除文件|重命名|新建文件夹|打开文件|读取文件|扫描目录|列出文件|清理桌面|organize.*desktop|move.*files?|rename.*files?|delete.*files?|scan.*folder|clean.*desktop/i;
                const SKILL_NEEDED_RE = /写小说|创作小说|写故事|写穿越|写言情|写科幻|小说工作台|继续写.*章|写下一章|装订成册/i;
                const _modelInfo = resolveCurrentModelInfo(engine);
                if (_modelInfo.isBrain && (LOCAL_OP_RE.test(promptText) || SKILL_NEEDED_RE.test(promptText))) {
                  const isZh = getLocale().startsWith("zh");
                  const isSkill = SKILL_NEEDED_RE.test(promptText);
                  broadcast({
                    type: "status",
                    isStreaming: true,
                    sessionPath: promptSessionPath,
                    noticeKey: "hint.localToolNeeded",
                    noticeText: isZh
                      ? isSkill
                        ? "💡 小说工作台需要本地工具支持（创建文件、管理章节）。请在模型选择器中切换到支持工具调用的模型（如 Kimi K2.5），即可自动执行完整创作流程。"
                        : "💡 此任务需要操作本地文件。默认模型无法直接操作，将为你生成操作方案。如需自动执行，请在设置中配置支持工具调用的供应商。"
                      : isSkill
                        ? "💡 Novel Workshop requires local tools. Switch to a model with tool support (e.g. Kimi K2.5) in the model selector for the full workflow."
                        : "💡 This task requires local file access. Configure a provider with tool support in Settings for auto-execution.",
                  });
                  appendHiddenRetryContext(engine, promptSessionPath,
                    isZh
                      ? isSkill
                        ? "【系统提示】用户想使用小说创作工作台，但当前默认模型无法调用本地工具（bash/write/read）。请告诉用户：1) 点击底部模型选择器，切换到 Kimi K2.5 或其他支持工具调用的模型；2) 切换后重新发送「写小说」即可启动完整的小说工作台流程（自动创建项目目录、大纲、分章节写作、装订成册）。当前你可以先帮用户构思故事大纲和人设。"
                        : "【系统提示】用户要求执行本地文件操作，但当前模型无法直接调用 bash/ls/write 等本地工具。请为用户生成具体的操作方案：列出需要执行的 shell 命令（带完整路径），让用户可以复制粘贴到终端执行。如果需要用户提供更多信息（如具体路径），直接询问。"
                      : isSkill
                        ? "[System] User wants the Novel Workshop but the default model cannot call local tools. Tell the user to switch to Kimi K2.5 or another model with tool support, then resend 'write a novel' to activate the full workflow. For now, help brainstorm the outline."
                        : "[System] User wants local file operations but current model cannot call bash/ls/write tools. Generate specific shell commands the user can copy-paste. Ask for paths if needed."
                  );
                }
                const recentConversationText = getRecentConversationText(engine, promptSessionPath);
                const reportPromptBasis = [recentConversationText, `user: ${promptText}`].filter(Boolean).join("\n\n");
                let reportResearchKind = "";
                let reportResearchContext = "";
                beginSessionStream(ss);
                broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
                const routeNoticeKey = getRouteIntentNoticeKey(ss.routeIntent);
                if (routeNoticeKey) {
                  broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath, noticeKey: routeNoticeKey });
                  ss.routeNoticeSent = true;
                }
                try {
                  reportResearchKind = inferReportResearchKind(reportPromptBasis);
                  const prefetchTool = reportResearchKind
                    ? resolveLocalPrefetchToolMeta(reportResearchKind, promptText)
                    : null;
                  if (prefetchTool) {
                    emitStreamEvent(promptSessionPath, ss, {
                      type: "tool_start",
                      name: prefetchTool.name,
                      args: prefetchTool.args,
                    });
                    recordToolCall({
                      phase: "start",
                      name: prefetchTool.name,
                      sessionPath: promptSessionPath,
                      args: prefetchTool.args,
                    });
                  }
                  reportResearchContext = await buildReportResearchContext(reportPromptBasis, {
                    userPrompt: promptText,
                    locale: getLocale(),
                  });
                  if (reportResearchContext) {
                    debugLog()?.log("ws", `attached report research context (${reportResearchContext.length} chars)`);
                    ss.localEvidencePrefetched = true;
                  }
                  if (prefetchTool) {
                    emitStreamEvent(promptSessionPath, ss, {
                      type: "tool_end",
                      name: prefetchTool.name,
                      success: !!reportResearchContext,
                      summary: buildLocalPrefetchToolSummary(reportResearchContext, reportResearchKind),
                      details: {
                        kind: reportResearchKind,
                        source: "local-prefetch",
                        chars: reportResearchContext.length,
                      },
                    });
                    recordToolCall({
                      phase: "end",
                      name: prefetchTool.name,
                      sessionPath: promptSessionPath,
                      args: prefetchTool.args,
                      success: !!reportResearchContext,
                      summary: buildLocalPrefetchToolSummary(reportResearchContext, reportResearchKind),
                    });
                  }
                } catch (err) {
                  debugLog()?.warn?.("ws", `report research prefetch failed: ${err?.message || err}`);
                  if (reportResearchKind) {
                    const prefetchTool = resolveLocalPrefetchToolMeta(reportResearchKind, promptText);
                    emitStreamEvent(promptSessionPath, ss, {
                      type: "tool_end",
                      name: prefetchTool.name,
                      success: false,
                      summary: {
                        outputPreview: `Local prefetch failed: ${err?.message || err}`,
                        matchCount: 0,
                        source: "local-prefetch",
                      },
                      details: {
                        kind: reportResearchKind,
                        source: "local-prefetch",
                        error: err?.message || String(err),
                      },
                    });
                    recordToolCall({
                      phase: "end",
                      name: prefetchTool.name,
                      sessionPath: promptSessionPath,
                      args: prefetchTool.args,
                      success: false,
                      error: err?.message || String(err),
                    });
                  }
                }
                let finalError = null;
                let localWorkspaceContextAttached = false;
                let reportResearchContextAttached = false;
                let reportStructureHintAttached = false;
                const maxRecoveryAttempts = ENABLE_LOCAL_TOOL_RECOVERY ? MAX_PSEUDO_TOOL_RECOVERY_ATTEMPTS : 1;
                for (let attemptIndex = 0; attemptIndex <= maxRecoveryAttempts; attemptIndex++) {
                  const currentModelInfo = resolveCurrentModelInfo(engine);
                  recordCurrentProvider({
                    provider: currentModelInfo.provider,
                    modelId: currentModelInfo.modelId,
                    modelName: currentModelInfo.modelName,
                    api: currentModelInfo.api,
                    routeIntent: ss.routeIntent,
                    sessionPath: promptSessionPath,
                    attemptIndex,
                  });
                  if (!reportResearchContextAttached) {
                    reportResearchContextAttached = appendHiddenRetryContext(
                      engine,
                      promptSessionPath,
                      reportResearchContext,
                    );
                  }
                  if (!reportStructureHintAttached) {
                    reportStructureHintAttached = appendHiddenRetryContext(
                      engine,
                      promptSessionPath,
                      buildReportStructureHint(reportPromptBasis, getLocale()),
                    );
                  }
                  if (
                    !localWorkspaceContextAttached
                    && shouldAttachLocalWorkspaceContext(promptText, ss.routeIntent)
                  ) {
                    const activeSession = engine.getSessionByPath?.(promptSessionPath);
                    const workspaceCwd = activeSession?.sessionManager?.getCwd?.()
                      || engine.homeCwd
                      || engine.cwd
                      || process.cwd();
                    const localContext = buildLocalWorkspaceContext({
                      promptText,
                      cwd: workspaceCwd,
                    });
                    localWorkspaceContextAttached = appendHiddenRetryContext(engine, promptSessionPath, localContext);
                  }
                  if (attemptIndex > 0) {
                    const retryContext = ss.installPrompt
                      ? buildInstallRetryPrompt("")
                      : (reportResearchContext
                        ? [
                            "【严格执行要求】上一轮错误地把工具调用写成了正文文本，没有真正执行工具。",
                            "本轮所需的搜索/行情/新闻/天气/资料已经由 Lynn 本地工具预取，并写在上文【系统已完成】资料块中。",
                            "这一次不要再调用工具，也不要输出 <execute>、web_search(...)、XML 或任何伪工具文本。请直接基于上文真实资料回答用户；资料不足时标注不足并说明需要补充什么来源。",
                          ].join("\n\n")
                      : ((ss.pendingToolExecutionDetected || ss.missingToolExecutionDetected)
                        ? [
                            ss.missingToolExecutionDetected
                              ? "【严格执行要求】上一轮在工具优先任务里没有及时发出真实工具调用。"
                              : "【严格执行要求】上一轮只输出了“我来查询/我来搜索/我来读取/我来查看”这类承诺文本，但没有真正调用工具。",
                            "这一次必须直接调用真实工具完成当前任务。文件和工作区任务优先调用 ls/read/grep/find/bash；实时信息任务优先调用 weather、stock_market、sports_score、live_news、web_search、web_fetch。",
                            "拿到工具结果后再回复用户，不要先输出计划、承诺句、Premise / Conduct / Reflection / Act 或伪工具文本。",
                            buildProviderToolCallHint({
                              routeIntent: ss.routeIntent,
                              provider: currentModelInfo.provider,
                              modelId: currentModelInfo.modelId,
                              locale: getLocale(),
                            }),
                          ].filter(Boolean).join("\n\n")
                        : buildPseudoToolRetryPrompt("")));
                    appendHiddenRetryContext(engine, promptSessionPath, retryContext);
                  }
                  const attemptText = promptText;
                  const attemptError = await sendPromptAttempt(attemptText, attemptIndex);
                  const needsRecovery = ENABLE_LOCAL_TOOL_RECOVERY && (!!ss.pseudoToolNeedsRetry || !!ss.installDeflectionDetected || !!ss.missingToolExecutionDetected || attemptError?.code === "INVALID_TOOL_SIMULATION");
                  const wasAborted = attemptError?.message?.includes("aborted");

                  if (attemptError && !wasAborted) {
                    recordProviderIssue({
                      provider: currentModelInfo.provider,
                      modelId: currentModelInfo.modelId,
                      modelName: currentModelInfo.modelName,
                      routeIntent: ss.routeIntent,
                      sessionPath: promptSessionPath,
                      code: attemptError.code || null,
                      message: attemptError.message || String(attemptError),
                    });
                  }

                  if (needsRecovery && attemptIndex < maxRecoveryAttempts) {
                    recordFallback({
                      reason: ss.installDeflectionDetected
                        ? "install-deflection"
                        : ss.missingToolExecutionDetected
                          ? "missing-tool-execution"
                        : ss.pendingToolExecutionDetected
                          ? "pending-tool-execution"
                          : "pseudo-tool-simulation",
                      provider: currentModelInfo.provider,
                      modelId: currentModelInfo.modelId,
                      routeIntent: ss.routeIntent,
                      sessionPath: promptSessionPath,
                    });
                    if (ss.installDeflectionDetected && engine.steerSession(promptSessionPath, buildInstallRecoverySteerText())) {
                      broadcast(buildPseudoToolRecoveryNotice(engine, promptSessionPath, ss.routeIntent));
                    }
                    broadcast({ type: "turn_retry", sessionPath: promptSessionPath });
                    continue;
                  }
                  if (needsRecovery) {
                    finalError = new Error(buildInvalidToolSimulationUserMessage(engine));
                    break;
                  }
                  if (attemptError && !wasAborted) {
                    finalError = attemptError;
                  }

                  // 工具调用后无文字输出恢复：追加隐藏提示让模型根据工具结果生成回复（仅重试一次）
                  if (!attemptError && ss.toolCallWithoutText && attemptIndex === 0) {
                    const hadToolCall = ss._recoveryHadToolCall;
                    ss.toolCallWithoutText = false;
                    const isZh = getLocale().startsWith("zh");
                    const retryHint = hadToolCall
                      ? (isZh
                        ? "工具已成功执行并返回结果。请根据以上工具返回的信息直接回答用户的问题，不要再次调用工具。"
                        : "Tools have been executed and returned results. Please answer the user's question based on the tool results above. Do not call tools again.")
                      : (isZh
                        ? "上一轮你只进行了内部思考/反思，但没有给用户任何回复文字。请直接回答用户的问题。如果无法完成用户的请求，请明确说明原因和替代建议。"
                        : "In the previous turn you only produced internal thinking/reflection but did not reply to the user. Please answer the user's question directly. If you cannot fulfill the request, explain why and suggest alternatives.");
                    appendHiddenRetryContext(engine, promptSessionPath, retryHint);
                    broadcast({ type: "turn_retry", sessionPath: promptSessionPath });
                    continue;
                  }

                  break;
                }

                if (finalError) {
                  wsSend(ws, {
                    type: "error",
                    message: finalError.message,
                    sessionPath: promptSessionPath,
                  });
                }
              } catch (err) {
                if (!err.message?.includes("aborted")) {
                  wsSend(ws, { type: "error", message: err.message, sessionPath: promptSessionPath });
                }
                broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
              }
            }
          })().catch((err) => {
            const appErr = AppError.wrap(err);
            errorBus.report(appErr, { context: { wsMessageType: msg.type } });
            if (!appErr.message?.includes('aborted')) {
              wsSend(ws, { type: 'error', message: appErr.message || 'Unknown error', error: appErr.toJSON() });
            }
          });
        },

        onError(event, ws) {
          const err = event.error || event;
          console.error("[ws] error:", err.message || err);
          debugLog()?.error("ws", err.message || String(err));
        },

        // 清理：WS 断开时只中断前台 session（后台 channel triage / cron 不受影响）
        onClose(event, ws) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          // 无活跃客户端时，清理非流式 session 状态（防止 Map 无限增长）
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute, broadcast, editRollbackStore };
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 * 只在 session 还没有自定义标题时执行
 */
async function generateSessionTitle(engine, notify, opts = {}) {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

    // 检查是否已有标题（避免重复生成）
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    if (!userText || !assistantText) return false;

    // 超时由 callText 内部的 AbortSignal 统一控制：超时即取消 Pi SDK 连接，无空跑
    let title = await engine.summarizeTitle(userText, assistantText, { timeoutMs: 15_000 });

    // API 失败时，用用户第一条消息截取作为 fallback 标题
    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    // 保存标题
    await engine.saveSessionTitle(sessionPath, title);

    // 通知前端更新
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", err.message);
    return false;
  }
}
