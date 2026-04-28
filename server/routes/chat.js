/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { MoodParser, XingParser, ThinkTagParser, LynnProgressParser } from "../../core/events.js";
import { containsPseudoToolCallSimulation } from "../../core/llm-utils.js";
import { stripPseudoToolCallMarkup } from "../../shared/pseudo-tool-call.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t, getLocale } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  buildDirectResearchAnswer,
  buildReportResearchContext,
  inferReportResearchKind,
} from "../chat/report-research-context.js";
import { buildLocalOfficeDirectAnswer } from "../chat/local-office-answer.js";
import {
  buildPseudoToolRecoveryNotice,
  buildPseudoToolRetryPrompt,
  resolveCurrentModelInfo,
} from "../chat/chat-recovery.js";
import {
  classifyRouteIntent,
  looksLikePendingToolExecutionText,
} from "../../shared/task-route-intent.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";

/** tool_start 事件只广播这些 arg 字段，避免传输完整文件内容（同步维护：chat-render-shim.ts extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "cmd", "shell", "script", "pattern", "url", "query", "key", "value", "action", "type", "schedule", "prompt", "label"];

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

function normalizeToolArgsForSummary(toolName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...rawArgs };
  if (toolName === "bash" && (typeof args.command !== "string" || !args.command.trim())) {
    for (const key of ["query", "cmd", "shell", "script"]) {
      if (typeof args[key] === "string" && args[key].trim()) {
        args.command = args[key];
        break;
      }
    }
  }
  return args;
}

const LOCAL_COMPLETION_TOOLS = new Set(["bash", "write", "edit", "edit-diff"]);
const STREAM_PSEUDO_XML_TOOLS = [
  // 真工具名(brain 转发的)
  "web_search",
  "web_fetch",
  "live_news",
  "weather",
  "stock_market",
  "sports_score",
  "bash",
  "read",
  "read_file",
  "write",
  "edit",
  "find",
  "grep",
  "glob",
  // [HOTPATCH 2026-04-27 night #2] 模型偶发把 markdown/HTML tag 当文本写出来,
  // 半截 `</code>` 可能在 streaming chunk 边界被切成 "_code>" 之类漏到 UI
  // 把常见 markdown / 假工具协议 tag 都纳入 strip 范围
  "code",
  "pre",
  "details",
  "summary",
  "think",
  "tool_call",
  "function",
  "parameter",
  "execute",
  "tool",
];

// [HOTPATCH 2026-04-27 night #2] 兜底:扫除任何 orphan 闭合标签
// 防御 STREAM_PSEUDO_XML_TOOLS 漏掉但仍是 `</xxx>` 形式的零散闭标签
// 只清纯字母/下划线/破折号 1-20 字符的 tag,避免误伤 `</a` 这种破残的 typo
const ORPHAN_CLOSE_TAG_RE = /<\/[a-zA-Z][a-zA-Z0-9_-]{0,20}\s*>/g;
const STREAM_PSEUDO_XML_TOOL_SOURCE = STREAM_PSEUDO_XML_TOOLS
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const STREAM_PSEUDO_XML_OPEN_RE = new RegExp(`<(${STREAM_PSEUDO_XML_TOOL_SOURCE})\\b[^>\\n]*(?:>|$)`, "iu");

function closePseudoXmlRe(toolName) {
  const escaped = String(toolName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`</\\s*${escaped}\\s*>`, "iu");
}

// [HOTPATCH 2026-04-28 v0.76.9] streaming chunk 边界 buffering
// 检测 text 末尾是否有半截 `</...` (open `<` 但无 `>` 收尾),buffer 等下一 chunk 拼接
// 防御 `</user>` 被 SSE 切成 `</us` + `er>` 两 chunk 各自漏 ORPHAN_CLOSE_TAG_RE 的死角
const PARTIAL_CLOSE_TAG_TAIL_RE = /<\/?[a-zA-Z][a-zA-Z0-9_-]{0,20}\s*$/;

function stripStreamingPseudoToolBlocks(ss, chunk) {
  // 拼上上一 chunk 末尾留下的半截 tag(若有)
  let rest = String((ss?.pseudoCloseTagBuffer || "") + (chunk || ""));
  if (ss) ss.pseudoCloseTagBuffer = "";
  let text = "";
  let suppressed = false;

  while (rest) {
    if (ss?.pseudoToolXmlBlock) {
      suppressed = true;
      const closeRe = closePseudoXmlRe(ss.pseudoToolXmlBlock);
      const closeMatch = rest.match(closeRe);
      if (!closeMatch) return { text, suppressed };
      rest = rest.slice((closeMatch.index || 0) + closeMatch[0].length);
      ss.pseudoToolXmlBlock = null;
      continue;
    }

    const openMatch = rest.match(STREAM_PSEUDO_XML_OPEN_RE);
    if (!openMatch) {
      text += rest;
      break;
    }

    const openIndex = openMatch.index || 0;
    text += rest.slice(0, openIndex);
    suppressed = true;

    const toolName = String(openMatch[1] || "").toLowerCase();
    const afterOpen = rest.slice(openIndex + openMatch[0].length);
    const closeMatch = afterOpen.match(closePseudoXmlRe(toolName));
    if (!closeMatch) {
      ss.pseudoToolXmlBlock = toolName;
      break;
    }
    rest = afterOpen.slice((closeMatch.index || 0) + closeMatch[0].length);
  }

  // [HOTPATCH 2026-04-27 night #2] 兜底扫除 orphan 闭合标签
  // 经过上面 open/close 配对处理后,如果仍残留 `</xxx>` 形式的零散闭标签
  // (例如 STREAM_PSEUDO_XML_TOOLS 没列到的 markdown tag,或 streaming chunk 边界
  // 切割造成漏过的半截),用通用 regex 干掉。仅作用于 sanitized 输出文本,
  // 不影响真工具调用流(那条路径走 tool_calls 协议,不经过这里)。
  if (text && ORPHAN_CLOSE_TAG_RE.test(text)) {
    ORPHAN_CLOSE_TAG_RE.lastIndex = 0; // reset regex state(g flag)
    text = text.replace(ORPHAN_CLOSE_TAG_RE, "");
    suppressed = true;
  }

  // [HOTPATCH 2026-04-28 v0.76.9] 末尾半截 `</...` 缓冲到下一 chunk
  // 防御 chunk 边界切割漏过 `</user>` `</assistant>` 等 chat-template role tag
  if (ss && text) {
    const tailMatch = text.match(PARTIAL_CLOSE_TAG_TAIL_RE);
    if (tailMatch) {
      ss.pseudoCloseTagBuffer = tailMatch[0];
      text = text.slice(0, text.length - tailMatch[0].length);
    }
  }

  return { text, suppressed };
}

function shouldPrefetchReportContext(reportKind, currentModelInfo) {
  if (!reportKind) return false;
  if (!currentModelInfo?.isBrain) return true;
  // 默认模型仍保留自主工具判断；但实时答案类问题必须有本地证据兜底。
  // 这可以防止远端搜索短暂失败时，用户只看到“未检索到明确证据”或伪工具文本。
  return new Set([
    "market_weather_brief",
    "weather",
    "sports",
    "market",
    "news",
  ]).has(reportKind);
}

function rememberSuccessfulTool(ss, toolName, toolSummary, rawArgs) {
  if (!ss || !toolName) return;
  ss.successfulToolCount = (ss.successfulToolCount || 0) + 1;
  const args = normalizeToolArgsForSummary(toolName, rawArgs) || {};
  const record = {
    name: toolName,
    command: typeof args.command === "string" ? args.command : "",
    filePath: typeof (args.file_path || args.path) === "string" ? (args.file_path || args.path) : "",
    outputPreview: typeof toolSummary?.outputPreview === "string" ? toolSummary.outputPreview : "",
  };
  ss.lastSuccessfulTools = [...(ss.lastSuccessfulTools || []), record].slice(-8);
}

function buildLocalToolSuccessFallback(ss) {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const localTools = tools.filter((tool) => LOCAL_COMPLETION_TOOLS.has(tool.name));
  if (!localTools.length) return "";

  const commandCount = localTools.filter((tool) => tool.name === "bash").length;
  const fileCount = localTools.filter((tool) => tool.filePath).length;
  const snippets = localTools
    .map((tool) => tool.command || tool.filePath || tool.outputPreview)
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3);

  const parts = ["已完成本轮本地操作。"];
  if (commandCount > 0) parts.push(`已成功执行 ${commandCount} 个命令`);
  if (fileCount > 0) parts.push(`处理了 ${fileCount} 个文件/路径`);
  let text = parts.join("，") + "。";
  if (snippets.length > 0) {
    text += "\n\n执行摘要：\n" + snippets.map((snippet) => `- ${snippet.slice(0, 160)}`).join("\n");
  }
  text += "\n\n你可以在目标文件夹里检查结果；如果需要，我也可以继续帮你核对整理后的文件列表。";
  return text;
}

function buildToolContinuationRetryPrompt(originalPrompt, visibleText) {
  const parts = [
    "【严格执行要求】你已经执行了部分真实工具，但随后只写了“开始/接下来/准备执行”等计划，没有继续调用真实工具完成任务。",
    "现在请基于刚才工具结果继续调用真实工具完成用户原始任务。",
    "不要只描述计划；不要输出 <bash>、web_search(...) 或任何伪工具文本；需要创建、移动、复制、读取或查询时，必须直接调用真实工具。",
    "完成后明确告诉用户实际执行了哪些动作、处理了几个文件/项目，以及目标位置。",
  ];

  const previous = String(visibleText || "").trim();
  if (previous) parts.push(`【上一段未完成回复】\n${previous.slice(-800)}`);

  const prompt = String(originalPrompt || "").trim();
  if (prompt) parts.push(`【用户原始问题】\n${prompt.slice(-1200)}`);

  return parts.join("\n\n");
}

function resolveEditSnapshotPath(session, engine, rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
  return path.resolve(cwd, trimmed);
}

function buildPseudoToolRecoverySteerText() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return [
      "你刚才把工具调用写成了普通文本，例如 web_search(...)，这不会真的执行。",
      "不要输出任何 tool_name(...)、XML 工具标签或伪 JSON 调用。",
      "如果需要搜索或读取，请直接调用真实工具；给用户只输出结果本身。",
    ].join(" ");
  }
  return [
    "You just printed a tool call like web_search(...), which does not execute anything.",
    "Do not output tool_name(...), XML tool tags, or pseudo JSON calls.",
    "If you need a tool, call the real tool and only show the user the result.",
  ].join(" ");
}

function prefetchToolNameForKind(kind) {
  if (kind === "market_weather_brief") return "market_weather_brief";
  if (kind === "weather") return "weather";
  if (kind === "sports") return "sports_score";
  if (kind === "market" || kind === "stock") return "stock_market";
  if (kind === "news") return "live_news";
  return "web_search";
}

function parseLooseAmount(value) {
  const n = Number(String(value || "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function buildBudgetCalculationContext(text) {
  const source = String(text || "");
  if (!/(?:月收入|收入)/.test(source) || !/(?:攒|存|储蓄|存款)/.test(source)) return "";

  const income = parseLooseAmount(source.match(/月收入\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const rent = parseLooseAmount(source.match(/房租\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const fixed = parseLooseAmount(source.match(/固定支出\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const months = parseLooseAmount(source.match(/(\d+)\s*个?\s*月/)?.[1]);
  const goal = parseLooseAmount(
    source.match(/(?:攒|存|储蓄|存款)\s*[¥￥]?\s*([\d,\s]+)/)?.[1]
      || source.match(/目标(?:金额|存款|储蓄)?\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1],
  );

  if (![income, rent, fixed, months, goal].every((n) => Number.isFinite(n) && n > 0)) return "";
  const fixedSpend = rent + fixed;
  const remainingBeforeSaving = income - fixedSpend;
  const monthlySaving = goal / months;
  const disposableAfterSaving = remainingBeforeSaving - monthlySaving;
  const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, "");

  return [
    "【系统已完成本地精确计算】",
    "请直接使用下面这些数字回答用户，不要重新心算，不要输出损坏的 Markdown 表格；如果要列表，优先用短句或要点。",
    `月收入：${fmt(income)}`,
    `房租：${fmt(rent)}`,
    `固定支出：${fmt(fixed)}`,
    `房租+固定支出：${fmt(fixedSpend)}`,
    `未储蓄前每月剩余：${fmt(remainingBeforeSaving)}`,
    `目标金额：${fmt(goal)}`,
    `目标周期：${fmt(months)} 个月`,
    `每月需要存：${fmt(monthlySaving)}`,
    `完成储蓄后每月可支配：${fmt(disposableAfterSaving)}`,
    "现实建议：若可支配金额偏紧，优先建议延长到 12 个月或降低月存款，不要建议全部压缩基本生活支出。",
  ].join("\n");
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
  const STALE_EMPTY_STREAM_MS = Number(process.env.LYNN_STALE_EMPTY_STREAM_MS || 90_000);
  const STALE_THINKING_STREAM_MS = Number(process.env.LYNN_STALE_THINKING_STREAM_MS || 120_000);

  function isStaleEmptySessionStream(ss, now = Date.now()) {
    if (!ss) return false;
    const elapsed = now - (ss.startedAt || 0);
    const hasUserVisibleProgress = !!(ss.hasOutput || ss.hasToolCall);
    if (hasUserVisibleProgress) return false;
    if (elapsed > STALE_THINKING_STREAM_MS) return true;
    return elapsed > STALE_EMPTY_STREAM_MS && !ss.hasThinking && !ss.hasError;
  }

  async function releaseStaleSessionStream(sessionPath, ss) {
    if (!sessionPath || !ss) return false;
    clearSilentBrainAbortTimer(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch {}
    if (ss.isStreaming) {
      closeStreamAfterError(sessionPath, ss);
    } else {
      finishSessionStream(ss);
      resetCompletedTurnState(ss);
      broadcast({ type: "status", isStreaming: false, sessionPath });
    }
    debugLog()?.warn("ws", `[STALE-STREAM-RELEASE v1] released stale stream · elapsed=${Date.now() - (ss.startedAt || Date.now())}ms · ${sessionPath}`);
    return true;
  }

  function buildEmptyReplyFallbackText(ss) {
    const isZh = getLocale().startsWith("zh");
    const kind = ss?.pseudoToolSteered ? "pseudo_tool_after_retry" : ss?.routeIntent || "empty_reply";
    return isZh
      ? `本轮模型没有生成可见答案，Lynn 已结束这次空转以免卡住会话。你可以直接重试一次，或把任务说得更具体一点。类型：${kind}`
      : `The model did not produce a visible answer. Lynn ended this empty turn to avoid locking the conversation. Please retry or make the task more specific. Kind: ${kind}`;
  }

  function buildEmptyReplyRetryPrompt(originalPromptText, routeIntent) {
    const userPrompt = String(originalPromptText || "").trim();
    return getLocale().startsWith("zh")
      ? [
          "[系统提示] 上一轮模型没有生成任何可见答案。本轮请不要调用工具，不要输出思考占位或准备语句，直接用纯文本完成用户任务。",
          `任务类型：${routeIntent || "chat"}`,
          "如果用户要求长文/研究/创作，请直接展开完整正文；如果信息不足，也要先给出可用的最小答案和缺口。",
          "【用户原始问题】",
          userPrompt,
        ].filter(Boolean).join("\n")
      : [
          "[System] The previous model turn produced no visible answer. Do not call tools; do not output planning placeholders. Complete the user's task directly in plain text.",
          `Route: ${routeIntent || "chat"}`,
          "If the user asked for long-form analysis or writing, produce the full answer now. If information is missing, provide the best minimal answer and state the gap.",
          "Original user request:",
          userPrompt,
        ].filter(Boolean).join("\n");
  }

  function buildShortLeadInRetryPrompt(originalPromptText, partialText) {
    return getLocale().startsWith("zh")
      ? [
          "[系统提示] 上一轮只输出了准备/开场句，没有完成用户任务。请不要再说“我先/接下来/准备”，也不要调用工具，直接完成最终内容。",
          "【上一轮可见文本】",
          String(partialText || "").trim(),
          "【用户原始问题】",
          String(originalPromptText || "").trim(),
        ].join("\n")
      : [
          "[System] The previous turn only produced a preparatory lead-in and did not complete the user task. Do not say you will do it; do not call tools. Produce the final content now.",
          "Previous visible text:",
          String(partialText || "").trim(),
          "Original user request:",
          String(originalPromptText || "").trim(),
        ].join("\n");
  }

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
        progressParser: new LynnProgressParser(),
        moodParser: new MoodParser(),
        xingParser: new XingParser(),
        isThinking: false,
        hasOutput: false,
        hasToolCall: false,
        hasThinking: false,
        hasError: false,
        titleRequested: false,
        titlePreview: "",
        visibleTextAcc: "",
        rawTextAcc: "",
        pseudoToolSteered: false,
        pseudoToolXmlBlock: null,
        routeIntent: "chat",
        originalPromptText: "",
        effectivePromptText: "",
        hasLocalPrefetchEvidence: false,
        pendingToolRetryAttempted: false,
        internalRetryCounts: {},
        successfulToolCount: 0,
        lastSuccessfulTools: [],
        // [TOOL-FINALIZE-RETRY v1 · 2026-04-21] 工具真调完但模型没给 final text
        //   (典型:GPT-5.4 / Kimi 在 T1 综合工具题) · 主动触发一次隐式 retry
        //   让模型基于工具结果产出最终答案 · 每轮最多 retry 1 次
        toolFinalizationRetryAttempted: false,
        silentBrainAbortTimer: null,
        activeStreamToken: null,
        degenerationAbortRequested: false,
        // [TURN-FENCE v1 · 2026-04-20] 上一轮因超时/错误 abort 且未产出内容 → 下一轮 prompt 前加
        // 【系统注意】提示,防 A3B 把上一个未答问题一起回答产生串轮(Round 7 T14→T15 观察)
        _lastTurnAborted: false,
        // [FAKE-PROGRESS-GUARD v2] 模型可能幻觉 <lynn_tool_progress> 标记
        //   v2 策略：永不 emit content-derived progress · 仅计数用于 steer 触发
        //   前端进度完全由结构化 tool_execution_start/end event 驱动
        progressMarkerCount: 0,
        // [TURN-END-SEMANTICS v1] tool_use 阶段 pi-sdk 发 turn_end 时 defer 一次 · 防 early broadcast
        _turnEndDeferred: false,
        lastActivity: Date.now(),
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

  function clearSilentBrainAbortTimer(ss) {
    if (ss?.silentBrainAbortTimer) {
      clearTimeout(ss.silentBrainAbortTimer);
      ss.silentBrainAbortTimer = null;
    }
  }

  function scheduleSilentBrainAbort(sessionPath, ss) {
    clearSilentBrainAbortTimer(ss);
    const info = resolveCurrentModelInfo(engine);
    // 本地预取只代表 Lynn 先做了一层浅证据抓取，不代表模型已经真正完成工具任务。
    // 因此它不能豁免 silent-turn recovery，否则长研究任务会在“我再查一下/我来读取”
    // 这类半截回复后静默结束。
    if (!info.isBrain) return;
    const timeoutMs = ss?.routeIntent === "reasoning" || ss?.routeIntent === "coding"
      ? 45_000
      : 25_000;
    ss.silentBrainAbortTimer = setTimeout(() => {
      ss.silentBrainAbortTimer = null;
      if (!ss.isStreaming || ss.hasOutput || ss.hasToolCall || ss.hasThinking || ss.hasError) return;
      // [TURN-FENCE v1] 标记上一轮 abort 无产出 · 下一轮 prompt 前加串轮隔离提示
      ss._lastTurnAborted = true;
      engine.abortSessionByPath?.(sessionPath).catch(() => {});
    }, timeoutMs);  // [2026-04-20] A3B fallback: utility 25s, reasoning/coding 45s
    if (ss.silentBrainAbortTimer.unref) ss.silentBrainAbortTimer.unref();
  }

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

  function resetCompletedTurnState(ss) {
    ss.activeStreamToken = null;
    ss.degenerationAbortRequested = false;
    ss.progressMarkerCount = 0;
    ss._turnEndDeferred = false;
    ss.hasOutput = false;
    ss.hasToolCall = false;
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
    if (ss.__slowToolTimers?.size) {
      for (const timer of ss.__slowToolTimers.values()) {
        try { clearTimeout(timer); } catch {}
      }
      ss.__slowToolTimers.clear();
    }
    // [TOOL-FINALIZE-RETRY v1] reset per-turn flag · 每轮都可以 retry 一次
    ss.toolFinalizationRetryAttempted = false;
  }

  function internalRetryCount(ss, reason) {
    if (!ss || !reason) return 0;
    const counts = ss.internalRetryCounts || {};
    return Number(counts[reason] || 0);
  }

  function canScheduleInternalRetry(ss, reason) {
    return !!ss && !!reason && internalRetryCount(ss, reason) < 1;
  }

  function markInternalRetry(ss, reason) {
    if (!ss || !reason) return false;
    if (!ss.internalRetryCounts || typeof ss.internalRetryCounts !== "object") {
      ss.internalRetryCounts = {};
    }
    ss.internalRetryCounts[reason] = internalRetryCount(ss, reason) + 1;
    return true;
  }

  function prepareInternalRetryStream(sessionPath, ss, reason) {
    clearSilentBrainAbortTimer(ss);
    ss.thinkTagParser.reset();
    ss.progressParser.reset();
    ss.moodParser.reset();
    ss.xingParser.reset();
    ss.titleRequested = true; // 避免内部 retry 反复重命名会话
    ss.titlePreview = "";
    ss.visibleTextAcc = "";
    ss.rawTextAcc = "";
    ss.hasOutput = false;
    ss.hasToolCall = false;
    ss.hasThinking = false;
    ss.hasError = false;
    ss.isThinking = false;
    ss.pseudoToolSteered = false;
    ss.pseudoToolXmlBlock = null;
    ss.successfulToolCount = 0;
    ss.lastSuccessfulTools = [];
    ss.progressMarkerCount = 0;
    ss.degenerationAbortRequested = false;
    ss._turnEndDeferred = false;
    const streamToken = beginSessionStream(ss);
    ss.activeStreamToken = streamToken;
    debugLog()?.log("ws", `[INTERNAL-RETRY v1] opened retry stream · reason=${reason} · session=${sessionPath}`);
    return streamToken;
  }

  function scheduleInternalRetry(sessionPath, reason, retryPrompt) {
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
        if (attempt < 20) {
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
      try {
        await hub.send(retryPrompt, { sessionPath, streamToken });
        clearSilentBrainAbortTimer(currentSs);
        if (!currentSs.isStreaming) {
          broadcast({ type: "status", isStreaming: false, sessionPath });
        }
      } catch (retryErr) {
        clearSilentBrainAbortTimer(currentSs);
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

  function closeStreamAfterError(sessionPath, ss) {
    if (!sessionPath || !ss?.isStreaming) return;
    clearSilentBrainAbortTimer(ss);
    // [TURN-FENCE v1] 本轮无产出被错误关闭 → 下一轮需要串轮隔离提示
    if (!ss.hasOutput && !ss.hasToolCall) ss._lastTurnAborted = true;
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `closed stream after model/tool error · ${sessionPath}`);
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

  function maybeSteerPseudoToolSimulation(sessionPath, ss, textOverride = null) {
    if (!sessionPath || !ss || ss.pseudoToolSteered) return false;
    // [FAKE-PROGRESS-GUARD v1] 两路伪造检测：
    //   1. pythonic 风格伪工具调用（老规则 · 基于 visibleTextAcc）
    //   2. <lynn_tool_progress> 幻觉标记（新规则 · 基于 progressMarkerCount）
    const inspectedText = textOverride != null ? String(textOverride || "") : (ss.visibleTextAcc || ss.rawTextAcc || "");
    const hasPseudoToolText = containsPseudoToolCallSimulation(inspectedText);
    const hasFakeProgress = ss.progressMarkerCount > 0 && !ss.hasToolCall;
    if (!hasPseudoToolText && !hasFakeProgress) return false;
    ss.pseudoToolSteered = true;
    const steered = engine.steerSession(sessionPath, buildPseudoToolRecoverySteerText());
    if (steered) {
      broadcast(buildPseudoToolRecoveryNotice(engine, sessionPath, ss.routeIntent));
    } else {
      debugLog()?.warn("ws", `pseudo tool/progress detected but steerSession unavailable · session=${sessionPath}`);
    }
    debugLog()?.warn("ws", `pseudo tool/progress detected (text=${hasPseudoToolText} fake_progress=${hasFakeProgress} count=${ss.progressMarkerCount}), suppressing leaked text · steered=${Boolean(steered)} · session=${sessionPath}`);
    return true;
  }

  function containsNonProgressPseudoToolSimulation(text) {
    const withoutProgressMarkers = String(text || "")
      .replace(/<lynn_tool_progress\b[\s\S]*?(?:<\/lynn_tool_progress>|$)/gi, "");
    return containsPseudoToolCallSimulation(withoutProgressMarkers);
  }

  function trimDegenerateTail(text) {
    let out = String(text || "");
    out = out.replace(/(?:\s*[—-]\s*[」]?\s*){8,}[\s\]\}】）」）]*$/g, "");
    out = out.replace(/(?:\s*[\]\}】）」）]){12,}\s*$/g, "");
    out = out.replace(/(.{1,6})\1{12,}\s*$/s, "");
    return out;
  }

  function emitVisibleTextDelta(sessionPath, ss, delta) {
    const rawNext = String(delta || "").replace(/\uFFFD+/g, "");
    let next = rawNext;
    if (!next) return;
    const strippedBlock = stripStreamingPseudoToolBlocks(ss, next);
    if (strippedBlock.suppressed) {
      maybeSteerPseudoToolSimulation(sessionPath, ss, rawNext);
      next = strippedBlock.text;
    }
    if (containsNonProgressPseudoToolSimulation(next)) {
      maybeSteerPseudoToolSimulation(sessionPath, ss, next);
      next = stripPseudoToolCallMarkup(next);
    }
    if (!next) return;
    const combined = ss.visibleTextAcc + next;
    const trimmed = trimDegenerateTail(combined);
    if (trimmed.length < combined.length) {
      next = trimmed.length > ss.visibleTextAcc.length ? trimmed.slice(ss.visibleTextAcc.length) : "";
      if (!ss.degenerationAbortRequested) {
        ss.degenerationAbortRequested = true;
        engine.abortSessionByPath?.(sessionPath).catch(() => {});
        debugLog()?.warn("ws", `suppressed degenerate tail and requested abort · session=${sessionPath}`);
      }
    }
    if (!next) return;
    if (containsNonProgressPseudoToolSimulation(ss.visibleTextAcc + next)) {
      maybeSteerPseudoToolSimulation(sessionPath, ss, ss.visibleTextAcc + next);
      return;
    }
    if (next.trim()) ss.hasOutput = true;
    ss.titlePreview += next;
    ss.visibleTextAcc += next;
    emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: next });
    maybeGenerateFirstTurnTitle(sessionPath, ss);
    maybeSteerPseudoToolSimulation(sessionPath, ss);
  }

  function isAssistantStreamScopedEvent(event) {
    return event?.type === "message_update"
      || event?.type === "tool_execution_start"
      || event?.type === "tool_execution_end"
      || event?.type === "turn_end";
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event, sessionPath) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? sessionState.get(sessionPath) : null;

    if (isAssistantStreamScopedEvent(event) && (!ss || !ss.isStreaming)) {
      debugLog()?.warn("ws", `ignored late stream event after turn close · type=${event?.type} · session=${sessionPath || "unknown"}`);
      return;
    }
    const eventStreamToken = event?._hubContext?.streamToken || null;
    if (isAssistantStreamScopedEvent(event) && eventStreamToken && ss?.activeStreamToken && eventStreamToken !== ss.activeStreamToken) {
      debugLog()?.warn("ws", `ignored stale stream event · type=${event?.type} · eventStream=${eventStreamToken} activeStream=${ss.activeStreamToken} · session=${sessionPath || "unknown"}`);
      return;
    }

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
        ss.rawTextAcc += delta || "";
        if (containsNonProgressPseudoToolSimulation(delta) || containsNonProgressPseudoToolSimulation(ss.rawTextAcc)) {
          if (maybeSteerPseudoToolSimulation(sessionPath, ss, ss.rawTextAcc)) return;
        }
        // ThinkTagParser（最外层）→ LynnProgressParser → MoodParser → XingParser
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
              // 非 think 内容先过 LynnProgressParser 抠掉 <lynn_tool_progress> 标记，
              // 再继续走 MoodParser → XingParser 链
              ss.progressParser.feed(tEvt.data, (pEvt) => {
                if (pEvt.type === "tool_progress") {
                  // [FAKE-PROGRESS-GUARD v2] 永不 emit content-derived tool_progress
                  //   v1 思路（buffer + flush on tool_execution_start）有缺陷：
                  //     tool_execution_start 触发时 flush 的事件可能本身是模型幻觉
                  //     (早先 buffered 的 marker 与稍后真实 tool 不是同一对)
                  //   v2 彻底方案：前端进度完全由结构化 tool_execution_start/end event 驱动
                  //     LynnProgressParser 的作用退化：
                  //       (a) 从 text 里剥离 <lynn_tool_progress> XML（避免原始标签泄露给用户）
                  //       (b) 计数用于 steer 触发（fake progress 说明模型在模拟工具调用）
                  ss.progressMarkerCount++;
                  maybeSteerPseudoToolSimulation(sessionPath, ss);
                  return; // 不 emit
                }
                // pEvt.type === "text" — 进入 mood/xing 解析链
                ss.moodParser.feed(pEvt.data, (evt) => {
                switch (evt.type) {
                  case "text":
                    ss.xingParser.feed(evt.data, (xEvt) => {
                      switch (xEvt.type) {
                        case "text":
                          emitVisibleTextDelta(sessionPath, ss, xEvt.data);
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
        closeStreamAfterError(sessionPath, ss);
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      // [FAKE-PROGRESS-GUARD v2] 不再 flush buffered progress · 移除 v1 的 flush 逻辑
      // 前端进度由此处结构化 tool_execution_start event 直接驱动（本函数下游会 emit）
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
      const rawArgs = normalizeToolArgsForSummary(event.toolName || "", event.args);
      let args;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgs[k] !== undefined) args[k] = rawArgs[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
      // [HOTPATCH 2026-04-28 v0.76.9 E] slow tool warning at 15s -- 给用户进度反馈,不再"卡死"感
      try {
        const __slowName = event.toolName || "";
        const __slowToolCallId = event.toolCallId || null;
        const __slowTimer = setTimeout(() => {
          try { emitStreamEvent(sessionPath, ss, { type: "tool_progress", name: __slowName, event: "slow_warning", elapsedMs: 15000, toolCallId: __slowToolCallId }); } catch (_) {}
        }, 15000);
        ss.__slowToolTimers = ss.__slowToolTimers || new Map();
        ss.__slowToolTimers.set(__slowToolCallId || __slowName, __slowTimer);
      } catch (_) {}
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      // [HOTPATCH 2026-04-28 v0.76.9 E] clear slow_warning timer for this tool
      try {
        const __key = event.toolCallId || event.toolName || "";
        const __t = ss.__slowToolTimers?.get(__key);
        if (__t) { clearTimeout(__t); ss.__slowToolTimers.delete(__key); }
      } catch (_) {}

      // 构建前端友好的工具结果摘要
      const rawDetails = event.result?.details || {};
      const toolSummary = {};
      const toolName = event.toolName || "";
      const normalizedArgs = normalizeToolArgsForSummary(toolName, event.args) || {};

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
          toolSummary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
        }
      } else if (toolName === "write") {
        toolSummary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
        // 从 result content 中提取写入的字节数信息
        const text = extractText(event.result?.content);
        const bytesMatch = text.match(/(\d+)\s*bytes/i);
        if (bytesMatch) toolSummary.bytesWritten = parseInt(bytesMatch[1], 10);
      } else if (toolName === "bash") {
        const text = extractText(event.result?.content);
        // 取输出的前 200 字符作为预览
        if (text) toolSummary.outputPreview = text.slice(0, 200);
        toolSummary.command = (normalizedArgs.command || "").slice(0, 80);
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
        toolSummary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
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

      if (!event.isError) {
        rememberSuccessfulTool(ss, toolName, toolSummary, normalizedArgs);
      }

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
      // [TURN-END-SEMANTICS v1] 2026-04-20 · V4 发现 · P0 修复
      // pi-sdk 在 tool_use 阶段结束也发 turn_end event
      // 但真正的 turn 还没结束（后面还有 assistant stream 输出 tool_result → final text）
      // 过早 broadcast turn_end → 客户端以为本轮结束 → 下一轮 prompt 进来 →
      // pi-sdk 的"迟到" text_delta 被路由到当前 UI buffer → 跨轮污染（T07 答案投递到 T08）
      //
      // Heuristic:
      //   有 tool_call + 没文本输出 + 没 error = tool_phase end · 不是真 turn_end
      //   此时保留 parser/状态 · 等后续 assistant stream 的 text_delta
      //   下一个 turn_end（final text 流结束）才触发真正的 broadcast + 清理
      //
      // Escape hatch: 一次 turn 最多 defer 1 次 · 避免死锁（如 tool 后模型不输出 text）
      if (ss.hasToolCall && !ss.hasError && !ss._turnEndDeferred) {
        ss._turnEndDeferred = true;
        debugLog()?.log("ws", `[TURN-END v2] defer tool-phase turn_end (awaiting final assistant text) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return; // 不 flush · 不 emit · 不清理 state
      }
      if (ss._turnEndDeferred) {
        debugLog()?.log("ws", `[TURN-END v1] resuming deferred turn_end · hasOutput=${ss.hasOutput} hasToolCall=${ss.hasToolCall} · ${sessionPath}`);
      }
      clearSilentBrainAbortTimer(ss);
      // 关闭结构化 thinking（如有）——必须在 flush 之前，否则前端收不到 thinking_end
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // flush 顺序：ThinkTag → LynnProgress → Mood → Xing（和 feed 顺序一致）
      // flush 内部的 progress → mood → xing 管线（thinkTag flush 和 mood flush 共用）
      const feedMoodPipeline = (text) => {
        ss.progressParser.feed(text, (pEvt) => {
          if (pEvt.type === "tool_progress") {
            ss.progressMarkerCount++;
            debugLog()?.warn("ws", `suppressed hallucinated <lynn_tool_progress> during flush · ${sessionPath}`);
            return;
          }
          // pEvt.type === "text"
          feedMoodOnly(pEvt.data);
        });
      };
      const feedMoodOnly = (text) => {
        ss.moodParser.feed(text, (evt) => {
          if (evt.type === "text") {
            ss.xingParser.feed(evt.data, (xEvt) => {
              switch (xEvt.type) {
                case "text":
                  emitVisibleTextDelta(sessionPath, ss, xEvt.data);
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
      ss.progressParser.flush((pEvt) => {
        if (pEvt.type === "text") {
          feedMoodOnly(pEvt.data);
        } else if (pEvt.type === "tool_progress") {
          ss.progressMarkerCount++;
          debugLog()?.warn("ws", `suppressed hallucinated <lynn_tool_progress> during progress flush · ${sessionPath}`);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          ss.xingParser.feed(evt.data, (xEvt) => {
            switch (xEvt.type) {
              case "text":
                emitVisibleTextDelta(sessionPath, ss, xEvt.data);
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
          emitVisibleTextDelta(sessionPath, ss, xEvt.data);
        } else if (xEvt.type === "xing_text") {
          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        }
      });

      const visibleTextBeforeReset = ss.visibleTextAcc || "";
      const visibleTrimmed = visibleTextBeforeReset.trim();
      const visibleLen = visibleTrimmed.length;
      let internalRetry = null;
      const shouldRetryPendingToolText =
        ss.hasLocalPrefetchEvidence &&
        !ss.pendingToolRetryAttempted &&
        canScheduleInternalRetry(ss, "pending_tool_text") &&
        !ss.hasToolCall &&
        looksLikePendingToolExecutionText(visibleTextBeforeReset, ss.routeIntent);

      // 空回复检测：本轮没有文本输出也没有工具调用时，不再只弹 toast。
      // 伪工具二次失败 / provider 空答如果没有可见文本，会让用户以为任务还在卡住；
      // 这里写入一条明确的可见兜底，并释放会话。
      if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError && isActive) {
        if (canScheduleInternalRetry(ss, "empty_reply")) {
          internalRetry = {
            reason: "empty_reply",
            prompt: buildEmptyReplyRetryPrompt(ss.effectivePromptText || ss.originalPromptText, ss.routeIntent),
          };
          debugLog()?.warn("ws", `[EMPTY-REPLY-RETRY v1] scheduled · session=${sessionPath}`);
        } else {
          const fallbackMsg = buildEmptyReplyFallbackText(ss);
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: fallbackMsg });
          ss.visibleTextAcc += fallbackMsg;
          ss.hasOutput = true;
          debugLog()?.warn("ws", `[EMPTY-REPLY-FALLBACK v2] emitted visible fallback · session=${sessionPath}`);
        }
      }

      // [EMPTY-REPLY-FALLBACK v1 + TOOL-FINALIZE-RETRY v1] 2026-04-20/21 · P1→P0 升级
      //   3 个场景静默结束会让用户困惑：
      //     (a) 工具调用成功但文本为空（T07 stock_market / T1 综合工具收尾 · "tool_no_final_text"）
      //     (b) 工具调完但文本只是"我再抓取一下"（S02 单轮财经 · 未完成语气）
      //     (c) 只有长 thinking 没有可见文本（S03 单轮新闻 · 41s thinking 空白）
      //
      //   v1 兜底：emit 一条明确的"未能完成"文案 · 不静默结束(仅限 b/c 场景)
      //   v2 升级(TOOL-FINALIZE-RETRY v1)：a 场景主动触发一次隐式 retry · 让模型
      //     基于已有工具结果给出最终答案 · 而不是让用户重问
      //     · 条件: hasToolCall && 文本几乎空 && 本轮未 retry 过
      //     · 实现: emit turn_end 后 · 发一条"基于工具结果给最终答案"的隐式 prompt
      //     · 限制: 每轮最多 retry 1 次 · 防止无限循环
      const PENDING_LANGUAGE_RE = /(?:再抓取|进一步|尚未提取|还需|稍后|still fetching|incomplete|unable to extract|let me (?:try|check|fetch|search) again)/i;
      const SHORT_LEADIN_RE = /(?:先读一下|先看一下|先检查|先确认|接下来|我将|我会|我来|让我先|准备|ensure|make sure)/i;
      const isIncompletePending = visibleLen > 0 && visibleLen < 80 && PENDING_LANGUAGE_RE.test(visibleTrimmed);
      const isShortLeadInOnly = visibleLen > 0 && visibleLen < 120 && !ss.hasToolCall && SHORT_LEADIN_RE.test(visibleTrimmed);
      const isToolDidNotProduceText = ss.hasToolCall && visibleLen < 5;
      const isThinkingOnlyNoOutput = ss.hasThinking && !ss.hasOutput && !ss.hasError;
      const hasSuccessfulLocalTool = (ss.lastSuccessfulTools || [])
        .some((tool) => LOCAL_COMPLETION_TOOLS.has(tool.name));
      const localToolSuccessFallback = hasSuccessfulLocalTool && isToolDidNotProduceText
        ? buildLocalToolSuccessFallback(ss)
        : "";

      // [TOOL-FINALIZE-RETRY v1] 工具真调完但无 final text · 主动 retry
      // 其他两个场景(incomplete_pending / thinking_only)仍走原 fallback msg 路径
      const shouldRetryToolFinalize =
        isActive &&
        !ss.hasError &&
        isToolDidNotProduceText &&
        !localToolSuccessFallback &&
        !ss.toolFinalizationRetryAttempted &&
        canScheduleInternalRetry(ss, "tool_finalization");
      const shouldRetryToolContinuation =
        isActive &&
        !ss.hasError &&
        ss.hasToolCall &&
        !ss.pendingToolRetryAttempted &&
        canScheduleInternalRetry(ss, "tool_continuation") &&
        looksLikePendingToolExecutionText(visibleTextBeforeReset, ss.routeIntent);

      if (localToolSuccessFallback && isActive && !ss.hasError) {
        emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: localToolSuccessFallback });
        ss.visibleTextAcc += localToolSuccessFallback;
        ss.hasOutput = true;
        debugLog()?.warn("ws", `[LOCAL-TOOL-SUCCESS-FALLBACK v1] emitted · tools=${(ss.lastSuccessfulTools || []).map(t => t.name).join(",")} · ${sessionPath}`);
      } else if (shouldRetryToolFinalize) {
        // 不 emit fallback msg · 让 retry 产生的 turn 承担最终答案
        ss.toolFinalizationRetryAttempted = true;
        debugLog()?.log("ws", `[TOOL-FINALIZE-RETRY v1] will retry · session=${sessionPath}`);
      } else if (!internalRetry && isActive && !ss.hasError && isShortLeadInOnly && canScheduleInternalRetry(ss, "short_leadin")) {
        internalRetry = {
          reason: "short_leadin",
          prompt: buildShortLeadInRetryPrompt(ss.effectivePromptText || ss.originalPromptText, visibleTextBeforeReset),
        };
        debugLog()?.warn("ws", `[SHORT-LEADIN-RETRY v1] scheduled · visibleLen=${visibleLen} · session=${sessionPath}`);
      } else if (isActive && !ss.hasError && (isIncompletePending || isThinkingOnlyNoOutput || (isToolDidNotProduceText && ss.toolFinalizationRetryAttempted))) {
        // 其他两场景 · 或已 retry 过一次仍无 final text → emit fallback msg
        const kind = isToolDidNotProduceText ? "tool_no_final_text_after_retry"
          : isIncompletePending ? "incomplete_pending"
          : "thinking_only";
        const fallbackMsg = getLocale().startsWith("zh")
          ? "本轮工具已执行，但未能整合出明确答案（原因：流程提前结束）。建议重新提问或换个说法 · 类型：" + kind
          : "Tools executed but the final answer could not be assembled (flow ended early). Please rephrase or try again · kind: " + kind;
        emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: fallbackMsg });
        ss.visibleTextAcc += fallbackMsg;
        ss.hasOutput = true;
        debugLog()?.warn("ws", `[EMPTY-REPLY-FALLBACK v1] emitted (${kind}) · visibleLen=${visibleLen} hasToolCall=${ss.hasToolCall} hasThinking=${ss.hasThinking} · ${sessionPath}`);
      }

      // [PROVIDER-BADGE v2] Emit turn_end synchronously; then fire-and-forget tail the session
      // JSONL for the last assistant message's model and emit a follow-up "model_hint" event.
      // Subscribe callback is sync — cannot await here.
      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      broadcast({ type: "status", isStreaming: false, sessionPath });
      if (!internalRetry && shouldRetryPendingToolText) {
        ss.pendingToolRetryAttempted = true;
        internalRetry = {
          reason: "pending_tool_text",
          prompt: buildPseudoToolRetryPrompt(ss.effectivePromptText || ss.originalPromptText),
        };
      }
      // [TOOL-CONTINUATION-RETRY v1] 2026-04-27 · 工具跑了一半后只说“开始/接下来”
      //   典型例子: ls 成功后正文写“找到 2 个 PDF，开始创建文件夹并移动”，但没有继续 mkdir/mv。
      //   这不是最终答案，也不是空答；必须再给模型一次机会继续调用真实工具完成原任务。
      if (!internalRetry && shouldRetryToolContinuation) {
        ss.pendingToolRetryAttempted = true;
        internalRetry = {
          reason: "tool_continuation",
          prompt: buildToolContinuationRetryPrompt(
            ss.effectivePromptText || ss.originalPromptText,
            visibleTextBeforeReset,
          ),
        };
        debugLog()?.warn("ws", `[TOOL-CONTINUATION-RETRY v1] triggered · visibleLen=${visibleLen} · session=${sessionPath}`);
      }
      // [TOOL-FINALIZE-RETRY v1] 2026-04-21 · 工具调完但无 final text 的主动 retry
      //   所有 provider 在 T1 综合工具收尾题都踩这条 · GPT-5.4/Kimi = tool_no_final_text
      //   默认模型/DeepSeek/MiniMax = empty response · 这里统一 retry
      //   retry prompt 明确告知: 工具结果已在对话历史 · 不要再调工具 · 直接综合给答案
      if (!internalRetry && shouldRetryToolFinalize) {
        const retryPrompt = getLocale().startsWith("zh")
          ? "[系统提示] 上面工具已经执行成功并拿到真实结果(在本次对话历史中)。请基于这些工具结果直接给用户最终答案 · 综合推理和结论。不要再调用任何工具 · 不要重复工具 raw output 的数据 · 直接给简洁可读的最终回答。"
          : "[System] The tools above executed successfully and returned real results (in this conversation history). Use those results to give the user the final answer directly — synthesize and conclude. Do not call any more tools. Do not restate raw tool output; produce a concise, readable final answer.";
        internalRetry = {
          reason: "tool_finalization",
          prompt: retryPrompt,
        };
        debugLog()?.log("ws", `[TOOL-FINALIZE-RETRY v1] triggered · session=${sessionPath}`);
      }
      (async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(sessionPath, "utf-8").catch(() => "");
          if (!raw) return;
          const lines = raw.split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              const mm = entry?.message;
              if (mm?.role === "assistant" && mm.model) {
                emitStreamEvent(sessionPath, ss, { type: "model_hint", model: String(mm.model) });
                return;
              }
            } catch { /* skip */ }
          }
        } catch { /* non-fatal */ }
      })();
      finishSessionStream(ss);
      // [FAKE-PROGRESS-GUARD v2] turn_end 时若模型输出过 fake progress 但没真实工具 → 记录
      if (ss.progressMarkerCount > 0 && !ss.hasToolCall) {
        debugLog()?.warn("ws", `observed ${ss.progressMarkerCount} hallucinated <lynn_tool_progress> markers (no real tool_call) · session=${sessionPath}`);
      }
      resetCompletedTurnState(ss);
      if (internalRetry) {
        scheduleInternalRetry(sessionPath, internalRetry.reason, internalRetry.prompt);
      }

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
              let promptSessionPath = msg.sessionPath || engine.currentSessionPath;
              if (!promptSessionPath) {
                const createdSession = await engine.createSession(null, engine.homeCwd || process.cwd());
                promptSessionPath = createdSession?.sessionManager?.getSessionFile?.() || engine.currentSessionPath || "";
              }
              const ss = getState(promptSessionPath);
              if (!ss) {
                wsSend(ws, { type: "error", message: t("error.noActiveSession") });
                return;
              }
              const engineStreaming = engine.isSessionStreaming(promptSessionPath);
              if (engineStreaming || ss?.isStreaming) {
                const shouldReleaseStale = isStaleEmptySessionStream(ss) || (engineStreaming && !ss?.isStreaming);
                const releasedStale = shouldReleaseStale
                  ? await releaseStaleSessionStream(promptSessionPath, ss)
                  : false;
                if (!releasedStale) {
                  wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
                  return;
                }
              }
              try {
                ss.thinkTagParser.reset();
                ss.progressParser.reset();
                ss.moodParser.reset();
                ss.xingParser.reset();
                ss.titleRequested = false;
                ss.titlePreview = "";
                ss.visibleTextAcc = "";
                ss.rawTextAcc = "";
                ss.routeIntent = classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 });
                ss.originalPromptText = promptText;
                ss.effectivePromptText = promptText;
                ss.hasLocalPrefetchEvidence = false;
                ss.pendingToolRetryAttempted = false;
                ss.internalRetryCounts = {};
                ss.pseudoToolSteered = false;
                ss.pseudoToolXmlBlock = null;
                ss.hasOutput = false;
                ss.hasToolCall = false;
                ss.hasThinking = false;
                ss.hasError = false;
                const streamToken = beginSessionStream(ss);
                ss.activeStreamToken = streamToken;
                broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
                const localOfficeAnswer = buildLocalOfficeDirectAnswer(promptText);
                if (localOfficeAnswer) {
                  emitVisibleTextDelta(promptSessionPath, ss, localOfficeAnswer);
                  emitStreamEvent(promptSessionPath, ss, { type: "turn_end" });
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                  finishSessionStream(ss);
                  resetCompletedTurnState(ss);
                  return;
                }
                const reportKind = inferReportResearchKind(promptText);
                let effectivePromptText = promptText;
                const budgetContext = buildBudgetCalculationContext(promptText);
                if (budgetContext) {
                  effectivePromptText = `${budgetContext}\n\n【用户原始问题】\n${promptText}`;
                }
                let directResearchAnswer = "";
                const currentModelInfo = resolveCurrentModelInfo(engine);
                // Brain/default model now owns tool routing on the server side.
                // Do not inject local prefetch evidence or scenario contracts into the
                // user prompt, otherwise the user-visible transcript can leak internal
                // guidance and the Brain router loses its chance to choose tools itself.
                if (shouldPrefetchReportContext(reportKind, currentModelInfo)) {
                  const toolName = prefetchToolNameForKind(reportKind);
                  emitStreamEvent(promptSessionPath, ss, { type: "tool_start", name: toolName, args: { query: promptText } });
                  try {
                    const reportContext = await buildReportResearchContext(promptText, { userPrompt: promptText });
                    if (reportContext && reportContext.trim()) {
                      ss.hasLocalPrefetchEvidence = true;
                      directResearchAnswer = buildDirectResearchAnswer(reportKind, reportContext, promptText);
                      effectivePromptText = [
                        reportContext.trim(),
                        budgetContext,
                        `【用户原始问题】\n${promptText}`,
                      ].filter(Boolean).join("\n\n");
                      emitStreamEvent(promptSessionPath, ss, { type: "tool_end", name: toolName, success: true });
                    } else {
                      emitStreamEvent(promptSessionPath, ss, { type: "tool_end", name: toolName, success: false, error: "no evidence returned" });
                    }
                  } catch (prefetchErr) {
                    emitStreamEvent(promptSessionPath, ss, {
                      type: "tool_end",
                      name: toolName,
                      success: false,
                      error: prefetchErr?.message || "prefetch failed",
                    });
                  }
                }
                if (directResearchAnswer) {
                  emitVisibleTextDelta(promptSessionPath, ss, directResearchAnswer);
                  emitStreamEvent(promptSessionPath, ss, { type: "turn_end" });
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                  finishSessionStream(ss);
                  resetCompletedTurnState(ss);
                  return;
                }
                // [TURN-FENCE v1 · 2026-04-20] 上一轮超时 abort 且无产出 → 加系统提示防串轮
                // Round 7 观察:T14 超时后 T15 preview 以 T14 的答案(## T14 韦伯的官僚制)开头
                // 根因是 pi-sdk session 历史里 T14 user 有但 assistant 为空,A3B 看到两个未答问题会一起回答
                if (ss._lastTurnAborted) {
                  effectivePromptText = `【系统注意】上一个问题因超时未能回答。本轮只回答下面这个当前问题,不要再回答之前未答复的任何问题。\n\n${effectivePromptText}`;
                  ss._lastTurnAborted = false;
                }
                ss.effectivePromptText = effectivePromptText;
                scheduleSilentBrainAbort(promptSessionPath, ss);
                await hub.send(effectivePromptText, msg.images
                  ? { images: msg.images, sessionPath: promptSessionPath, streamToken }
                  : { sessionPath: promptSessionPath, streamToken });
                clearSilentBrainAbortTimer(ss);
                if (!ss.isStreaming) {
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                } else {
                  debugLog()?.log("ws", `hub.send returned while server stream remains open · ${promptSessionPath}`);
                }
              } catch (err) {
                clearSilentBrainAbortTimer(ss);
                const aborted = err.message?.includes("aborted");
                if (!aborted) {
                  wsSend(ws, { type: "error", message: err.message, sessionPath: promptSessionPath });
                  if (ss) ss.hasError = true;
                } else if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError) {
                  wsSend(ws, { type: "error", message: t("error.modelNoResponse"), sessionPath: promptSessionPath });
                }
                if (ss.isStreaming) {
                  closeStreamAfterError(promptSessionPath, ss);
                } else {
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                }
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
