/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import fs from "fs";
import path from "path";
import os from "os";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { containsPseudoToolCallSimulation } from "../../core/llm-utils.js";
import { stripPseudoToolCallMarkup } from "../../shared/pseudo-tool-call.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t, getLocale } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  buildDirectResearchAnswer,
  buildReportResearchContext,
} from "../chat/report-research-context.js";
import {
  resolveCurrentModelInfo,
} from "../chat/chat-recovery.js";
import { createLifecycleHooks } from "../chat/lifecycle-hooks.js";
import { classifyRouteIntent } from "../../shared/task-route-intent.js";
import {
  buildVisionUnsupportedMessage,
  normalizeVisionPromptText,
} from "../../shared/vision-prompt.js";
import {
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import {
  createTurnQualitySnapshot,
  evaluateForcedTurnFallback,
  evaluatePostTurnEndQuality,
  evaluatePreTurnEndQuality,
} from "../chat/turn-quality-gate.js";
import {
  stripStreamingPseudoToolBlocks,
  containsNonProgressPseudoToolSimulation,
} from "../chat/stream-sanitizer.js";
import {
  createSessionStateStore,
  isStaleEmptySessionStream,
  resetCompletedTurnState,
} from "../chat/stream-state.js";
import {
  scheduleInternalRetry,
} from "../chat/internal-retry.js";
import {
  TOOL_USE_BEHAVIOR,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
} from "../chat/tool-use-behavior.js";
import {
  artifactPreviewDedupeKey,
  artifactPreviewFromToolCall,
} from "../chat/artifact-recovery.js";
import {
  buildLocalToolSuccessFallback,
  buildFailedToolFallbackText,
  buildSuccessfulToolNoTextFallback,
  buildPostRehydrateEscalationPrompt,
  classifyRequestedLocalMutation,
  clearPendingMutationOnSuccessfulDelete,
  commandLooksLikeDelete,
  consumeMutationConfirmation,
  recordPendingDeleteRequest,
  shouldRetryUnverifiedLocalMutation,
  stripRouteMetadataLeaks,
} from "../chat/turn-retry-policy.js";

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

function looksLikeCodingDiagnosticPrompt(text = "") {
  return /(?:traceback|importerror|cannot import|main\.py|python|comfyui|代码|报错|导入失败|修复)/i.test(String(text || ""));
}

function looksLikeEarlyStoppedToolFailure(text = "") {
  return /(?:命令被提前停止|broad\s+home|home-root|Command aborted|timeout|timed out|NOT_FOUND|not found|No such file|no such file|permission denied|EACCES|EPERM)/i.test(String(text || ""));
}

function stripHiddenReflectionBlocks(text) {
  return String(text || "")
    .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\s*/gi, "")
    .replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/gi, "")
    .trim();
}

function normalizePersistedAssistantText(text) {
  const trimmed = stripHiddenReflectionBlocks(text);
  if (!trimmed) return "";
  if (containsPseudoToolCallSimulation(trimmed) || containsNonProgressPseudoToolSimulation(trimmed)) {
    return "";
  }
  return trimmed;
}

function readPersistedAssistantVisibleTexts(session, sessionPath = "") {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const fromMessages = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const text = normalizePersistedAssistantText(extractText(msg.content));
    if (!text) continue;
    fromMessages.push(text);
  }
  if (sessionPath) {
    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const fromFile = [];
      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]);
        const msg = entry?.message;
        if (msg?.role !== "assistant") continue;
        const text = normalizePersistedAssistantText(extractText(msg.content));
        if (text) fromFile.push(text);
      }
      if (fromFile.length > 0) return fromFile;
    } catch {
      // Best-effort recovery for SDK paths that persist answers without streaming them.
    }
  }
  return fromMessages;
}

function countPersistedAssistantVisibleTexts(session, sessionPath = "") {
  return readPersistedAssistantVisibleTexts(session, sessionPath).length;
}

function extractLatestAssistantVisibleTextAfter(session, sessionPath = "", baselineCount = 0) {
  const texts = readPersistedAssistantVisibleTexts(session, sessionPath);
  if (texts.length <= Math.max(0, baselineCount || 0)) return "";
  return stripRouteMetadataLeaks(texts[texts.length - 1] || "");
}

function extractLatestAssistantVisibleText(session, sessionPath = "") {
  return extractLatestAssistantVisibleTextAfter(session, sessionPath, 0);
}

function hasStreamEvent(ss, type) {
  return Array.isArray(ss?.events) && ss.events.some((entry) => entry?.event?.type === type);
}

function hasScheduledInternalRetry(ss) {
  return !!(ss?.internalRetryPending || ss?.internalRetryInFlight);
}

function hasToolExecutionInFlight(ss) {
  return !!(ss?.recoveredBashInFlight || Number(ss?.activeToolCallCount || 0) > 0);
}

function hasDifferentActiveStreamToken(ss, streamToken) {
  return Boolean(streamToken && ss?.activeStreamToken && ss.activeStreamToken !== streamToken);
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

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function isMeaningfulRecoveredBashCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (/^[<>/\\\s]+$/.test(trimmed)) return false;
  if (/^<\/?[a-zA-Z0-9_.:-]+\s*\/?>$/.test(trimmed)) return false;
  if (/^```(?:bash|sh|shell)?$/i.test(trimmed)) return false;
  return /[A-Za-z0-9_$~/'"`.-]/.test(trimmed);
}

function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function extractPseudoBashCommand(text) {
  const raw = String(text || "");
  const patterns = [
    /<\|tool_code_begin\|>\s*bash\s*([\s\S]*?)(?:<\|tool_code_end\|>|$)/i,
    /<tool_call>\s*<bash[^>]*>([\s\S]*?)(?:<\/bash>|$)/i,
    /<bash[^>]*>([\s\S]*?)<\/bash>/i,
    /<tool_call>\s*bash\s*\n([\s\S]*?)(?:<\/tool_call>|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const command = String(match?.[1] || "").replace(/<\/?[^>]+>/g, "").trim();
    if (isMeaningfulRecoveredBashCommand(command)) return command;
  }
  return "";
}

function extractPseudoRemovePath(text) {
  const raw = String(text || "");
  const patterns = [
    /<remove[^>]*>\s*\(([^)]+)\)\s*<\/remove>/i,
    /<(?:remove|remove_file|delete|delete_file)[^>]*>\s*(?:<path>)?\s*([^<\n]+?)\s*(?:<\/path>)?\s*<\/(?:remove|remove_file|delete|delete_file)>/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const target = String(match?.[1] || "").trim();
    if (target && target.length <= 1000) return target;
  }
  return "";
}

function extractExplicitDeleteTargetFromPrompt(prompt) {
  const text = String(prompt || "");
  const match = text.match(/(?:删除|删掉|移除|delete|remove)\s*(?:当前目录下|当前目录中|当前文件夹下|current directory|current folder)?\s*[`"“”']?([A-Za-z0-9][A-Za-z0-9._ -]{0,180}\.[A-Za-z0-9]{1,16})[`"“”']?/i);
  const target = String(match?.[1] || "").trim();
  if (!target || target.includes("/") || target.includes("\\") || /[*?[\]{}$`;&|<>]/.test(target)) return "";
  return target;
}

function extractPromptDeleteExtensionRequest(prompt) {
  const text = String(prompt || "");
  if (!/(?:删除|删掉|清理|移除|delete|remove)/i.test(text)) return null;
  const wantsDownloads = /(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(text);
  if (!wantsDownloads) return null;
  const extMatch = text.match(/(?:后缀(?:是|为)?|扩展名(?:是|为)?|extension\s*)[：:\s.'"]*([A-Za-z0-9]{1,32})\b/i)
    || text.match(/(?:所有|全部|all)[\s\S]{0,24}\.([A-Za-z0-9]{1,32})\b/i)
    || text.match(/\.([A-Za-z0-9]{1,32})\s*(?:文件|files?)/i)
    || text.match(/\b(zip|rar|7z|xlsx?|csv|pdf|docx?|pptx?)\b/i);
  const extension = String(extMatch?.[1] || "").toLowerCase();
  if (!extension || /[^a-z0-9]/i.test(extension)) return null;
  return {
    folder: path.join(os.homedir(), "Downloads"),
    extension,
  };
}

function buildDeleteExtensionCommand(request) {
  if (!request?.folder || !request?.extension) return "";
  const quotedFolder = shellQuote(request.folder);
  const pattern = `*.${request.extension}`;
  return [
    `dir=${quotedFolder}`,
    `matches=$(find "$dir" -maxdepth 1 -type f -iname ${shellQuote(pattern)} -print)`,
    `if [ -z "$matches" ]; then echo '下载文件夹中没有 ${request.extension} 文件。'`,
    `else printf '%s\\n' "$matches"; printf '%s\\n' "$matches" | while IFS= read -r file; do rm -f "$file"; done; echo '=== 删除完成 ==='`,
    `fi`,
  ].join("; ");
}

function normalizeMoveExtensionToken(token = "") {
  const raw = String(token || "").trim().toLowerCase();
  if (!raw) return [];
  if (/^(?:html?|网页)$/.test(raw)) return ["html", "htm"];
  if (/^(?:excel|表格|xlsx?|xlsm|csv)$/.test(raw)) return ["xlsx", "xls", "xlsm", "csv"];
  if (/^(?:pdf)$/.test(raw)) return ["pdf"];
  if (/^(?:图片|image|images?|照片|photo|photos?)$/.test(raw)) {
    return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff", "svg"];
  }
  if (/^[a-z0-9]{1,32}$/i.test(raw)) return [raw];
  return [];
}

function resolveKnownFolderFromText(text = "", fallback = "") {
  const raw = String(text || "");
  if (/(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(raw)) return path.join(os.homedir(), "Downloads");
  if (/(?:桌面|Desktop)/i.test(raw)) return path.join(os.homedir(), "Desktop");
  if (/(?:文稿|文档|Documents?)/i.test(raw)) return path.join(os.homedir(), "Documents");
  return fallback || "";
}

function sanitizeFolderName(name = "") {
  return String(name || "")
    .replace(/["“”'`]/g, "")
    .replace(/(?:的)?(?:文件夹|目录|folder)$/i, "")
    .replace(/^(?:到|至|进|进入|放进|放到|移动到|移到|挪到|拷贝到|复制到)\s*/i, "")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "")
    .slice(0, 80);
}

function extractTargetFolderName(text = "") {
  const raw = String(text || "");
  const patterns = [
    /(?:移动到|移到|挪到|放到|放进|放入|归档到|整理到|复制到|拷贝到)\s*([^\n，。；;,.!?！？]{1,80})/i,
    /(?:都|全部|所有)[\s\S]{0,30}(?:放进|放到|移动到|移到|挪到)\s*([^\n，。；;,.!?！？]{1,80})/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const name = sanitizeFolderName(match?.[1] || "");
    if (name) return name;
  }
  return "";
}

function extractPromptMoveExtensionRequest(prompt) {
  const text = String(prompt || "");
  const requirement = classifyRequestedLocalMutation(text);
  if (!requirement?.requiresMove) return null;

  const sourceFolder = resolveKnownFolderFromText(text);
  if (!sourceFolder) return null;

  const extMatch = text.match(/(?:后缀(?:是|为)?|扩展名(?:是|为)?|extension\s*)[：:\s.'"]*([A-Za-z0-9]{1,32})\b/i)
    || text.match(/(?:所有|全部|all)[\s\S]{0,28}\.([A-Za-z0-9]{1,32})\b/i)
    || text.match(/\b(html?|xlsx?|xlsm|csv|pdf|png|jpe?g|gif|webp|bmp|heic|svg)\b/i)
    || text.match(/(HTML?|Excel|表格|PDF|图片|照片)/i);
  const extensions = normalizeMoveExtensionToken(extMatch?.[1] || "");
  if (!extensions.length) return null;

  let targetName = extractTargetFolderName(text);
  if (!targetName) {
    targetName = extensions[0] === "pdf" ? "pdf"
      : extensions.includes("xlsx") ? "表格"
      : extensions.includes("html") ? "HTML"
      : extensions.includes("png") ? "图片"
      : `${extensions[0]}文件`;
  }

  let targetBase = sourceFolder;
  if (/^(?:桌面|Desktop)/i.test(targetName)) {
    targetBase = path.join(os.homedir(), "Desktop");
    targetName = sanitizeFolderName(targetName.replace(/^(?:桌面|Desktop)\s*/i, ""));
  } else if (/^(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(targetName)) {
    targetBase = path.join(os.homedir(), "Downloads");
    targetName = sanitizeFolderName(targetName.replace(/^(?:下载文件夹|下载目录|Downloads?|download folder)\s*/i, ""));
  }
  if (!targetName) return null;

  return {
    sourceFolder,
    targetFolder: path.join(targetBase, targetName),
    extensions,
  };
}

function buildMoveExtensionCommand(request) {
  if (!request?.sourceFolder || !request?.targetFolder || !Array.isArray(request.extensions) || !request.extensions.length) {
    return "";
  }
  const quotedSource = shellQuote(request.sourceFolder);
  const quotedTarget = shellQuote(request.targetFolder);
  const findPatterns = request.extensions
    .map((ext) => `-iname ${shellQuote(`*.${ext}`)}`)
    .join(" -o ");
  const label = request.extensions.join("/");
  return [
    `src=${quotedSource}`,
    `dst=${quotedTarget}`,
    `mkdir -p "$dst"`,
    `matches=$(find "$src" -maxdepth 1 -type f \\( ${findPatterns} \\) -print)`,
    `if [ -z "$matches" ]; then echo '源文件夹中没有 ${label} 文件。'; else printf '%s\\n' "$matches"; printf '%s\\n' "$matches" | while IFS= read -r file; do [ -n "$file" ] || continue; mv -n "$file" "$dst/"; done; echo '=== 移动命令已执行 ==='; find "$dst" -maxdepth 1 -type f \\( ${findPatterns} \\) -print`,
    `fi`,
  ].join("; ");
}

function extractRecoverablePseudoBashCommand(text, ss, session, engine) {
  const requirement = classifyRequestedLocalMutation(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!requirement) return "";

  // For local mutation requests, the model often leaks a fake probe such as
  // "find matching files" while the user asked us to actually move/delete.
  // Prefer the deterministic command derived from the original user prompt so
  // pseudo-tool recovery still completes the task instead of only inspecting.
  const explicitPromptCommand = buildExplicitPromptMutationCommand(ss, session, engine);
  if (explicitPromptCommand) return explicitPromptCommand;

  const bashCommand = extractPseudoBashCommand(text);
  if (isMeaningfulRecoveredBashCommand(bashCommand)) return bashCommand;

  if (!requirement.requiresDelete) return "";
  const removePath = extractPseudoRemovePath(text);
  if (!removePath) return "";

  const cwd = session?.sessionManager?.getCwd?.() || engine?.cwd || process.cwd();
  const resolved = path.resolve(cwd, removePath);
  if (!isInsidePath(resolved, cwd)) return "";
  return `rm -f ${shellQuote(resolved)} && ls -la ${shellQuote(path.dirname(resolved))}`;
}

function buildExplicitPromptDeleteCommand(ss, session, engine) {
  const requirement = classifyRequestedLocalMutation(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!requirement?.requiresDelete) return "";
  const prompt = ss?.originalPromptText || ss?.effectivePromptText || "";
  const extensionRequest = extractPromptDeleteExtensionRequest(prompt);
  if (extensionRequest) return buildDeleteExtensionCommand(extensionRequest);
  const target = extractExplicitDeleteTargetFromPrompt(prompt);
  if (!target) return "";
  const cwd = session?.sessionManager?.getCwd?.() || engine?.cwd || process.cwd();
  const resolved = path.resolve(cwd, target);
  if (!isInsidePath(resolved, cwd)) return "";
  const command = `rm -f ${shellQuote(resolved)} && ls -la ${shellQuote(cwd)}`;
  return isMeaningfulRecoveredBashCommand(command) ? command : "";
}

function buildExplicitPromptMoveCommand(ss) {
  const prompt = ss?.originalPromptText || ss?.effectivePromptText || "";
  const request = extractPromptMoveExtensionRequest(prompt);
  if (!request) return "";
  return buildMoveExtensionCommand(request);
}

function buildExplicitPromptMutationCommand(ss, session, engine) {
  return buildExplicitPromptDeleteCommand(ss, session, engine)
    || buildExplicitPromptMoveCommand(ss, session, engine);
}

function looksLikeIncompleteLocalMutationProbe(toolName, args, resultText = "") {
  const name = String(toolName || "");
  if (name !== "bash" && name !== "find" && name !== "ls") return false;
  const command = String(args?.command || args?.query || args?.cmd || "").trim();
  if (!command) return true;
  if (/^(?:find|ls|pwd)\s*$/i.test(command)) return true;
  if (/^[<>/\\\s]+$/.test(command)) return true;
  const output = String(resultText || "");
  return /(?:usage:|illegal option|missing argument|unknown primary|No such file or directory|参数缺失)/i.test(output)
    && !/(?:\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\b-delete\b)/i.test(command);
}

function looksLikeLocalMutationProbeCommand(toolRecord) {
  const name = String(toolRecord?.name || "");
  const command = String(toolRecord?.command || "").trim();
  if (name !== "bash" && name !== "find" && name !== "ls") return false;
  if (!command) return true;
  if (/\b(?:rm|mv|cp|trash|unlink|rmdir)\b|(?:^|\s)-delete(?:\s|$)/i.test(command)) return false;
  return /^(?:find|ls|pwd|mkdir\b)/i.test(command);
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
  if (toolName === "bash" && record.command) {
    clearPendingMutationOnSuccessfulDelete(ss, record.command);
  }
}

function rememberFailedTool(ss, toolName) {
  if (!ss || !toolName) return;
  ss.hasFailedTool = true;
  ss.lastFailedTools = [...(ss.lastFailedTools || []), toolName].slice(-8);
}

function buildPrefetchToolSummary(context) {
  const lines = String(context || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^【系统已完成/.test(line))
    .filter((line) => !/^(?:下面是|请直接|如果资料不足|来源[:：]?)/.test(line));
  const outputPreview = lines.slice(0, 6).join("\n").slice(0, 200);
  return outputPreview ? { outputPreview } : {};
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
  const TURN_HARD_ABORT_MS = Number(process.env.LYNN_TURN_HARD_ABORT_MS || 120_000);
  const TOOL_FINALIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_FINALIZATION_GRACE_MS || 8_000);
  const TOOL_AUTHORIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_AUTHORIZATION_GRACE_MS || 45_000);
  const RETURNED_TURN_FINALIZATION_GRACE_MS = Number(process.env.LYNN_RETURNED_TURN_FINALIZATION_GRACE_MS || 3_000);

  const { sessionState, getState } = createSessionStateStore();
  const lifecycleHooks = createLifecycleHooks({
    onError: (err, meta) => {
      debugLog()?.warn("ws", `lifecycle hook failed · event=${meta?.eventName || "unknown"} · ${err?.message || err}`);
    },
  });
  lifecycleHooks.tap("prompt_start", ({ sessionPath, routeIntent, streamToken }) => {
    debugLog()?.span("prompt_start", { sessionPath, routeIntent, streamToken }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_start", ({ sessionPath, toolName }) => {
    debugLog()?.span("tool_start", { sessionPath, toolName }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_end", ({ sessionPath, toolName, success }) => {
    debugLog()?.span("tool_end", { sessionPath, toolName, success }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_end", ({ sessionPath, hasOutput, hasToolCall }) => {
    debugLog()?.span("turn_end", { sessionPath, hasOutput, hasToolCall }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_close", ({ sessionPath, reason }) => {
    debugLog()?.span("turn_close", { sessionPath, reason }, { module: "ws", level: "INFO" });
  });

  // ── Per-client rate limiting (token bucket) ──
  const _wsRateLimits = new WeakMap();
  const RATE_TOKENS = 5;
  const RATE_REFILL_MS = 10000;

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
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  async function releaseStaleSessionStream(sessionPath, ss) {
    if (!sessionPath || !ss) return false;
    const isInternalRetryStream = ss.streamSource === "internal_retry";
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err) {
      console.warn("[chat] failed to abort stale session stream:", err?.message || err);
    }
    if (ss.isStreaming) {
      if (isInternalRetryStream) {
        editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
        ss.internalRetryPending = false;
        ss.internalRetryInFlight = false;
        ss.internalRetryReason = "";
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }
        if (!hasStreamEvent(ss, "turn_end")) {
          emitStreamEvent(sessionPath, ss, { type: "turn_end" });
        }
        finishSessionStream(ss);
        resetCompletedTurnState(ss);
        broadcast({ type: "status", isStreaming: false, sessionPath });
      } else {
        closeStreamAfterError(sessionPath, ss);
      }
    } else {
      editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
      finishSessionStream(ss);
      resetCompletedTurnState(ss);
      broadcast({ type: "status", isStreaming: false, sessionPath });
    }
    debugLog()?.warn("ws", `[STALE-STREAM-RELEASE v1] released stale stream · elapsed=${Date.now() - (ss.startedAt || Date.now())}ms · ${sessionPath}`);
    return true;
  }

  async function forceResetSessionStream(sessionPath, ss, reason = "unknown") {
    if (!sessionPath || !ss) return false;
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err) {
      console.warn("[chat] failed to abort hidden-busy session stream:", err?.message || err);
    }
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    broadcast({ type: "status", isStreaming: false, sessionPath });
    debugLog()?.warn("ws", `[HIDDEN-BUSY-RESET v1] force-reset session stream · reason=${reason} · ${sessionPath}`);
    return true;
  }

  function clearSilentBrainAbortTimer(ss) {
    if (ss?.silentBrainAbortTimer) {
      clearTimeout(ss.silentBrainAbortTimer);
      ss.silentBrainAbortTimer = null;
    }
  }

  function clearTurnHardAbortTimer(ss) {
    if (ss?.turnHardAbortTimer) {
      clearTimeout(ss.turnHardAbortTimer);
      ss.turnHardAbortTimer = null;
    }
  }

  function clearToolFinalizationTimer(ss) {
    if (ss?.toolFinalizationTimer) {
      clearTimeout(ss.toolFinalizationTimer);
      ss.toolFinalizationTimer = null;
    }
  }

  function clearToolAuthorizationTimer(ss) {
    if (ss?.toolAuthorizationTimer) {
      clearTimeout(ss.toolAuthorizationTimer);
      ss.toolAuthorizationTimer = null;
    }
  }

  function clearToolAuthorizationPollTimer(ss) {
    if (ss?.toolAuthorizationPollTimer) {
      clearInterval(ss.toolAuthorizationPollTimer);
      ss.toolAuthorizationPollTimer = null;
    }
  }

  function clearReturnedTurnFinalizationTimer(ss) {
    if (ss?.returnedTurnFinalizationTimer) {
      clearTimeout(ss.returnedTurnFinalizationTimer);
      ss.returnedTurnFinalizationTimer = null;
    }
  }

  function clearPersistedFinalAnswerPollTimer(ss) {
    if (ss?.persistedFinalAnswerPollTimer) {
      clearInterval(ss.persistedFinalAnswerPollTimer);
      ss.persistedFinalAnswerPollTimer = null;
    }
  }

  function clearTurnTimers(ss) {
    clearSilentBrainAbortTimer(ss);
    clearTurnHardAbortTimer(ss);
    clearToolFinalizationTimer(ss);
    clearToolAuthorizationTimer(ss);
    clearToolAuthorizationPollTimer(ss);
    clearReturnedTurnFinalizationTimer(ss);
    clearPersistedFinalAnswerPollTimer(ss);
  }

  function isGenericEmptyFallbackText(text) {
    const value = String(text || "");
    return /本轮模型没有生成可[见用]回复|本轮模型没有生成可见答案|本轮补写回答没有稳定完成|空转以免卡住会话|The model did not produce (?:a )?visible answer|The model did not produce visible text/i.test(value);
  }

  function shouldSuppressGenericEmptyFallback(ss, text) {
    if (!isGenericEmptyFallbackText(text)) return false;
    if (ss?.routeIntent === "vision") return false;
    return true;
  }

  function applyVisibleFallbackDecision(sessionPath, ss, decision) {
    if (!decision || decision.type !== "fallback" || !decision.text || ss.hasOutput) return false;
    if (shouldSuppressGenericEmptyFallback(ss, decision.text)) {
      debugLog()?.warn("ws", `[EMPTY-FALLBACK-SUPPRESS v1] suppressed generic fallback · route=${ss?.routeIntent || "unknown"} · session=${sessionPath}`);
      return false;
    }
    emitVisibleTextDelta(sessionPath, ss, decision.text);
    if (decision.logMessage) {
      const logger = debugLog();
      const level = decision.logLevel === "log" ? "log" : "warn";
      const logFn = logger?.[level];
      if (typeof logFn === "function") logFn.call(logger, "ws", decision.logMessage);
    }
    return true;
  }

  function hasSuccessfulDeleteFromHistory(ss) {
    const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
    return tools.some((tool) => tool?.name === "bash" && commandLooksLikeDelete(String(tool?.command || "")));
  }

  function maybePostRehydrateRecover(sessionPath, ss) {
    if (!sessionPath || !ss || !ss.rehydratedThisTurn) return false;
    if (hasSuccessfulDeleteFromHistory(ss)) return false;
    const originalPrompt = ss.originalPromptText || ss.effectivePromptText || "";
    if (!originalPrompt) return false;

    if (!ss.postRehydrateEscalationAttempted) {
      ss.postRehydrateEscalationAttempted = true;
      const retryPrompt = buildPostRehydrateEscalationPrompt(originalPrompt);
      // Finish the current stream so the internal retry can start a fresh one
      // (scheduleInternalRetry's startRetry waits while ss.isStreaming is true).
      clearTurnTimers(ss);
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      finishSessionStream(ss);
      const ok = doScheduleInternalRetry(sessionPath, "post_rehydrate_escalate", retryPrompt);
      if (ok) {
        debugLog()?.warn("ws", `[POST-REHYDRATE-ESCALATE v1] scheduled escalation retry · session=${sessionPath}`);
        return true;
      }
      return false;
    }

    if (!ss.postRehydrateDeterministicAttempted) {
      const session = engine.getSessionByPath(sessionPath);
      const command = buildExplicitPromptMutationCommand(ss, session, engine);
      if (!command) return false;
      ss.postRehydrateDeterministicAttempted = true;
      const ok = executeRecoveredBashCommand(sessionPath, ss, session, command, "post_rehydrate_deterministic");
      if (ok) {
        debugLog()?.warn("ws", `[POST-REHYDRATE-DETERMINISTIC v1] forced deterministic delete · cmd=${command.slice(0, 80)} · session=${sessionPath}`);
        return true;
      }
      return false;
    }
    return false;
  }

  function closeStreamWithVisibleFallback(sessionPath, ss, text, reason, opts = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    if (!opts.skipPostRehydrateRecover && maybePostRehydrateRecover(sessionPath, ss)) {
      debugLog()?.warn("ws", `[POST-REHYDRATE-INTERCEPT v1] deferred close · reason=${reason} · session=${sessionPath}`);
      return true;
    }
    ss._turnClosed = true;
    ss.internalRetryPending = false;
    ss.internalRetryInFlight = false;
    ss.internalRetryReason = "";
    clearTurnTimers(ss);
    editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (text && shouldSuppressGenericEmptyFallback(ss, text)) {
      debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK-SUPPRESS v1] suppressed generic fallback · reason=${reason} · route=${ss?.routeIntent || "unknown"} · session=${sessionPath}`);
    } else if (text && (!ss.hasOutput || opts.appendEvenIfHasOutput)) {
      const prefix = ss.hasOutput && opts.appendEvenIfHasOutput ? "\n\n" : "";
      if (opts.trustedFallback) {
        emitTrustedVisibleTextDelta(sessionPath, ss, prefix + text);
      } else {
        emitVisibleTextDelta(sessionPath, ss, prefix + text);
      }
    } else if (!ss.hasOutput) {
      const snapshot = createTurnQualitySnapshot(ss, ss.visibleTextAcc || "");
      applyVisibleFallbackDecision(sessionPath, ss, evaluateForcedTurnFallback(ss, snapshot, { sessionPath }));
    }
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    lifecycleHooks.run("turn_close", { sessionPath, ss, reason, forced: true });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK v1] closed stream · reason=${reason} · session=${sessionPath}`);
    return true;
  }

  function normalizeVisibleForCompare(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isMeaningfulPersistedFinalText(finalText, ss) {
    const final = normalizeVisibleForCompare(finalText);
    if (!final) return false;
    const visible = normalizeVisibleForCompare(ss?.visibleTextAcc || "");
    if (!visible) return true;
    if (final === visible) return false;
    if (final.length <= visible.length + 20 && (final.includes(visible) || visible.includes(final))) return false;
    return true;
  }

  function visibleTextLooksLikeLocalCompletion(text) {
    return /(?:已完成|已成功|成功执行|移动完成|删除完成|整理完成|处理了\s*\d+|已删除|已移动|已复制|已创建|目标文件夹|执行摘要)/i.test(String(text || ""));
  }

  function maybeEmitLocalToolCompletionFallback(sessionPath, ss, opts = {}) {
    if (!sessionPath || !ss) return false;
    const text = buildLocalToolSuccessFallback(ss);
    if (!text) return false;
    const requirement = classifyRequestedLocalMutation(ss.originalPromptText || ss.effectivePromptText || "");
    if (!opts.force && ss.hasOutput && (!requirement || visibleTextLooksLikeLocalCompletion(ss.visibleTextAcc))) {
      return false;
    }
    const delta = ss.hasOutput ? `\n\n${text}` : text;
    emitTrustedVisibleTextDelta(sessionPath, ss, delta);
    debugLog()?.warn("ws", `[LOCAL-TOOL-COMPLETION-FALLBACK v1] emitted · hasOutput=${ss.hasOutput} · session=${sessionPath}`);
    return true;
  }

  function finalizeReturnedTurnWithoutStream(sessionPath, ss, reason, opts = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    if (hasToolExecutionInFlight(ss)) return false;
    if (!opts.ignoreInternalRetry && hasScheduledInternalRetry(ss)) return false;
    const finalText = !ss.hasOutput
      ? extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath)
      : "";
    if (opts.requirePersistedText && !ss.hasOutput && !finalText) return false;
    if (finalText && shouldRetryUnverifiedLocalMutation(ss, finalText)) {
      if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, finalText)) return true;
    }
    return closeStreamWithVisibleFallback(sessionPath, ss, finalText, reason);
  }

  function scheduleReturnedTurnFinalizationFallback(sessionPath, ss, reason) {
    clearReturnedTurnFinalizationTimer(ss);
    if (!sessionPath || !ss || !RETURNED_TURN_FINALIZATION_GRACE_MS) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.returnedTurnFinalizationTimer = setTimeout(() => {
      ss.returnedTurnFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasToolExecutionInFlight(ss) ||
        hasScheduledInternalRetry(ss)
      ) {
        return;
      }
      finalizeReturnedTurnWithoutStream(sessionPath, ss, reason);
    }, RETURNED_TURN_FINALIZATION_GRACE_MS);
    if (ss.returnedTurnFinalizationTimer.unref) ss.returnedTurnFinalizationTimer.unref();
    return true;
  }

  function schedulePersistedFinalAnswerPoll(sessionPath, ss) {
    clearPersistedFinalAnswerPollTimer(ss);
    if (!sessionPath || !ss) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.persistedFinalAnswerPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss.hasOutput ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasScheduledInternalRetry(ss)
      ) {
        clearPersistedFinalAnswerPollTimer(ss);
        return;
      }
      if (hasToolExecutionInFlight(ss)) return;
      const finalText = extractLatestAssistantVisibleTextAfter(
        engine.getSessionByPath(sessionPath),
        sessionPath,
        ss.persistedAssistantTextBaseline || 0,
      );
      if (finalText) {
        if (shouldRetryUnverifiedLocalMutation(ss, finalText)) {
          clearPersistedFinalAnswerPollTimer(ss);
          if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, finalText)) return;
        }
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "persisted_final_answer_poll");
      }
    }, 1000);
    if (ss.persistedFinalAnswerPollTimer.unref) ss.persistedFinalAnswerPollTimer.unref();
    return true;
  }

  function scheduleTurnHardAbort(sessionPath, ss) {
    clearTurnHardAbortTimer(ss);
    if (!sessionPath || !ss || !TURN_HARD_ABORT_MS) return;
    const streamToken = ss.activeStreamToken || null;
    ss.turnHardAbortTimer = setTimeout(() => {
      ss.turnHardAbortTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      ss._lastTurnAborted = true;
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      const isZh = getLocale().startsWith("zh");
      const text = isZh
        ? "本轮模型长时间没有生成可见答案，Lynn 已结束这次空转以免卡住会话。你可以直接重试一次，或把任务说得更具体一点。"
        : "The model did not produce visible text in time, so Lynn closed this turn to avoid blocking the session. Please retry or make the task more specific.";
      closeStreamWithVisibleFallback(sessionPath, ss, text, "hard_turn_timeout");
    }, TURN_HARD_ABORT_MS);
    if (ss.turnHardAbortTimer.unref) ss.turnHardAbortTimer.unref();
  }

  function scheduleToolFinalizationFallback(sessionPath, ss) {
    clearToolFinalizationTimer(ss);
    if (!sessionPath || !ss || !TOOL_FINALIZATION_GRACE_MS) return;
    const streamToken = ss.activeStreamToken || null;
    ss.toolFinalizationTimer = setTimeout(() => {
      ss.toolFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        return;
      }
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolFinalizationFallback(sessionPath, ss);
        return;
      }
      if (shouldRetryUnverifiedLocalMutation(ss, ss.visibleTextAcc || "")) {
        if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, ss.visibleTextAcc || "")) return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      const localToolFallback = buildLocalToolSuccessFallback(ss);
      const snapshot = createTurnQualitySnapshot(ss, ss.visibleTextAcc || "");
      const successfulToolFallback =
        snapshot.toolSuccessFallback ||
        ((snapshot.isToolSuccessLeadInOnly || snapshot.isToolDidNotProduceText)
          ? buildSuccessfulToolNoTextFallback(ss)
          : "");
      const fallback = localToolFallback || successfulToolFallback || (ss.hasOutput ? "" : (evaluateForcedTurnFallback(ss, snapshot, { sessionPath })?.text || (getLocale().startsWith("zh")
        ? "工具已执行，但模型没有生成最终回复。Lynn 已结束这轮会话；你可以检查上方工具结果，或让我继续核对。"
        : "The tool ran, but the model did not produce a final reply. Lynn closed this turn; you can inspect the tool result above or ask me to verify it.")));
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        fallback,
        "tool_finalization_timeout",
        {
          appendEvenIfHasOutput: Boolean(fallback && ss.hasOutput),
          trustedFallback: Boolean(localToolFallback || successfulToolFallback),
        },
      );
    }, TOOL_FINALIZATION_GRACE_MS);
    if (ss.toolFinalizationTimer.unref) ss.toolFinalizationTimer.unref();
  }

  function scheduleToolAuthorizationFallback(sessionPath, ss) {
    clearToolAuthorizationTimer(ss);
    clearToolAuthorizationPollTimer(ss);
    if (!sessionPath || !ss || !TOOL_AUTHORIZATION_GRACE_MS || !ss.isStreaming || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return;
    clearSilentBrainAbortTimer(ss);
    const streamToken = ss.activeStreamToken || null;
    ss.toolAuthorizationPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        clearToolAuthorizationPollTimer(ss);
        return;
      }
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      if (isMeaningfulPersistedFinalText(finalText, ss)) {
        if (hasToolExecutionInFlight(ss)) return;
        if (shouldRetryUnverifiedLocalMutation(ss, finalText)) {
          clearToolAuthorizationPollTimer(ss);
          if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, finalText)) return;
        }
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "tool_authorization_persisted_final");
      }
    }, 1000);
    if (ss.toolAuthorizationPollTimer.unref) ss.toolAuthorizationPollTimer.unref();
    ss.toolAuthorizationTimer = setTimeout(() => {
      ss.toolAuthorizationTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolAuthorizationFallback(sessionPath, ss);
        return;
      }
      if (shouldRetryUnverifiedLocalMutation(ss, ss.visibleTextAcc || "")) {
        if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, ss.visibleTextAcc || "")) return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      const localToolFallback = buildLocalToolSuccessFallback(ss);
      const meaningfulFinalText = isMeaningfulPersistedFinalText(finalText, ss) ? finalText : "";
      const fallback = getLocale().startsWith("zh")
        ? "工具授权后没有收到最终回复，Lynn 已结束这轮会话以免卡住。请检查目标目录或上方工具状态；如果需要，我可以继续核对结果。"
        : "The tool authorization did not produce a final reply, so Lynn closed this turn to avoid blocking the session. Please inspect the target path or ask me to verify the result.";
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        meaningfulFinalText || localToolFallback || fallback,
        "tool_authorization_timeout",
        {
          appendEvenIfHasOutput: Boolean(localToolFallback && !meaningfulFinalText),
          trustedFallback: Boolean(localToolFallback && !meaningfulFinalText),
        },
      );
    }, TOOL_AUTHORIZATION_GRACE_MS);
    if (ss.toolAuthorizationTimer.unref) ss.toolAuthorizationTimer.unref();
  }

  function scheduleSilentBrainAbort(sessionPath, ss) {
    clearSilentBrainAbortTimer(ss);
    const info = resolveCurrentModelInfo(engine);
    if (!info.isBrain) return;
    const timeoutMs = ss?.routeIntent === "reasoning" || ss?.routeIntent === "coding"
      ? 45_000
      : 25_000;
    const streamToken = ss?.activeStreamToken || null;
    ss.silentBrainAbortTimer = setTimeout(() => {
      ss.silentBrainAbortTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken)) return;
      if (ss.hasOutput || ss.hasToolCall || ss.hasThinking || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, ss.visibleTextAcc || "")) {
        Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
        return;
      }
      ss._lastTurnAborted = true;
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      if (
        !hasDifferentActiveStreamToken(ss, streamToken) &&
        !ss.hasOutput &&
        !ss.hasToolCall &&
        !ss.hasThinking &&
        !ss.hasError &&
        !hasStreamEvent(ss, "turn_end")
      ) {
        closeStreamAfterError(sessionPath, ss);
      }
    }, timeoutMs);
    if (ss.silentBrainAbortTimer.unref) ss.silentBrainAbortTimer.unref();
  }

  const clients = new Set();

  const pendingEditSnapshots = new Map();
  const rollbackSnapshots = new Map();
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
    discardPendingForSession(sessionPath, streamToken = null) {
      if (!sessionPath) return 0;
      let count = 0;
      for (const [toolCallId, snapshot] of pendingEditSnapshots) {
        if (snapshot?.sessionPath !== sessionPath) continue;
        if (streamToken && snapshot?.streamToken && snapshot.streamToken !== streamToken) continue;
        pendingEditSnapshots.delete(toolCallId);
        count += 1;
      }
      return count;
    },
    pendingCount() {
      return pendingEditSnapshots.size;
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

  // 浏览器缩略图 30s 定时刷新
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
    broadcast({
      ...event,
      sessionPath,
      streamId: entry.streamId,
      seq: entry.seq,
    });
    return entry;
  }

  function emitRecoveredArtifact(sessionPath, ss, artifact, source = "toolcall") {
    if (!ss || !artifact?.content) return false;
    ss.recoveredArtifactKeys = ss.recoveredArtifactKeys || new Set();
    const key = artifactPreviewDedupeKey(artifact);
    if (ss.recoveredArtifactKeys.has(key)) return false;
    ss.recoveredArtifactKeys.add(key);
    ss.hasOutput = true;
    emitStreamEvent(sessionPath, ss, artifact);
    debugLog()?.info("ws", `recovered artifact from ${source} · tool=${artifact.recoveredFromTool || "unknown"} · title=${artifact.title || ""} · session=${sessionPath || "unknown"}`);
    return true;
  }

  function maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, source = "message_update") {
    const sub = event?.assistantMessageEvent;
    const preview = artifactPreviewFromToolCall(sub?.toolCall);
    return preview ? emitRecoveredArtifact(sessionPath, ss, preview, source) : false;
  }

  // ── scheduleInternalRetry 的闭包适配器 ──
  function doScheduleInternalRetry(sessionPath, reason, retryPrompt) {
    return scheduleInternalRetry({
      sessionPath, reason, retryPrompt,
      getState, broadcast, hub, engine,
      scheduleSilentBrainAbort,
      clearSilentBrainAbort: clearSilentBrainAbortTimer,
      closeStreamAfterError,
      emitStreamEvent,
      finalizeReturnedTurnWithoutStream,
      cleanupPendingEdits: (sp, streamToken = null) => editRollbackStore.discardPendingForSession(sp, streamToken),
    });
  }

  function closeStreamAfterError(sessionPath, ss) {
    if (!sessionPath || !ss || hasStreamEvent(ss, "turn_end")) return;
    if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, ss.visibleTextAcc || "", { ignoreError: true })) {
      return;
    }
    if (!ss.hasOutput && !ss.hasToolCall) ss._lastTurnAborted = true;
    closeStreamWithVisibleFallback(sessionPath, ss, "", "model_tool_error");
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

  function maybeRecoverPseudoToolCommand(sessionPath, ss, inspectedText) {
    if (
      !sessionPath ||
      !ss ||
      ss.pseudoToolCommandRecoveryAttempted ||
      ss.hasToolCall ||
      ss._turnClosed ||
      hasStreamEvent(ss, "turn_end") ||
      typeof engine.buildTools !== "function"
    ) {
      return false;
    }
    const session = engine.getSessionByPath(sessionPath);
    const command = extractRecoverablePseudoBashCommand(inspectedText, ss, session, engine)
      || buildExplicitPromptMutationCommand(ss, session, engine);
    if (!command) return false;

    ss.pseudoToolCommandRecoveryAttempted = true;
    ss.pseudoToolRecoveryHandled = true;
    ss.hasToolCall = true;
    ss.recoveredBashInFlight = true;
    const toolCallId = `recovered_pseudo_bash_${Date.now().toString(36)}`;
    emitStreamEvent(sessionPath, ss, { type: "tool_start", name: "bash", args: { command } });

    Promise.resolve().then(async () => {
      try {
        const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
        const built = engine.buildTools(cwd, null, {
          workspace: cwd,
          getSessionPath: () => sessionPath,
        });
        const bashTool = [...(built?.tools || []), ...(built?.customTools || [])].find((tool) => tool?.name === "bash");
        if (!bashTool?.execute) throw new Error("bash tool unavailable");
        const result = await bashTool.execute(toolCallId, { command });
        const resultText = extractText(result?.content);
        const toolSummary = {
          command: command.slice(0, 160),
          outputPreview: resultText ? resultText.slice(0, 200) : "",
        };
        emitStreamEvent(sessionPath, ss, {
          type: "tool_end",
          name: "bash",
          success: !result?.isError,
          summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
        });
        if (result?.isError) {
          rememberFailedTool(ss, "bash");
          ss.recoveredBashInFlight = false;
          closeStreamWithVisibleFallback(sessionPath, ss, "", "recovered_pseudo_bash_failed");
          return;
        }
        rememberSuccessfulTool(ss, "bash", toolSummary, { command });
        ss.recoveredBashInFlight = false;
        closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          buildLocalToolSuccessFallback(ss),
          "recovered_pseudo_bash",
          { appendEvenIfHasOutput: true, trustedFallback: true },
        );
      } catch (err) {
        ss.recoveredBashInFlight = false;
        emitStreamEvent(sessionPath, ss, {
          type: "tool_end",
          name: "bash",
          success: false,
          error: err?.message || String(err),
        });
        rememberFailedTool(ss, "bash");
        closeStreamWithVisibleFallback(sessionPath, ss, "", "recovered_pseudo_bash_error");
      }
    });

    debugLog()?.warn("ws", `recovering pseudo bash command through real tool · session=${sessionPath}`);
    return true;
  }

  function executeRecoveredBashCommand(sessionPath, ss, session, command, reason) {
    if (!sessionPath || !ss || !isMeaningfulRecoveredBashCommand(command) || typeof engine.buildTools !== "function") {
      return false;
    }
    ss.hasToolCall = true;
    ss.recoveredBashInFlight = true;
    const toolCallId = `recovered_bash_${Date.now().toString(36)}`;
    emitStreamEvent(sessionPath, ss, { type: "tool_start", name: "bash", args: { command } });

    Promise.resolve().then(async () => {
      try {
        const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
        const built = engine.buildTools(cwd, null, {
          workspace: cwd,
          getSessionPath: () => sessionPath,
        });
        const bashTool = [...(built?.tools || []), ...(built?.customTools || [])].find((tool) => tool?.name === "bash");
        if (!bashTool?.execute) throw new Error("bash tool unavailable");
        const result = await bashTool.execute(toolCallId, { command });
        const resultText = extractText(result?.content);
        const toolSummary = {
          command: command.slice(0, 160),
          outputPreview: resultText ? resultText.slice(0, 200) : "",
        };
        emitStreamEvent(sessionPath, ss, {
          type: "tool_end",
          name: "bash",
          success: !result?.isError,
          summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
        });
        if (result?.isError) {
          rememberFailedTool(ss, "bash");
          ss.recoveredBashInFlight = false;
          closeStreamWithVisibleFallback(sessionPath, ss, "", `${reason || "recovered_bash"}_failed`);
          return;
        }
        rememberSuccessfulTool(ss, "bash", toolSummary, { command });
        ss.recoveredBashInFlight = false;
        closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          buildLocalToolSuccessFallback(ss),
          reason || "recovered_bash",
          { appendEvenIfHasOutput: true, trustedFallback: true },
        );
      } catch (err) {
        ss.recoveredBashInFlight = false;
        emitStreamEvent(sessionPath, ss, {
          type: "tool_end",
          name: "bash",
          success: false,
          error: err?.message || String(err),
        });
        rememberFailedTool(ss, "bash");
        closeStreamWithVisibleFallback(sessionPath, ss, "", `${reason || "recovered_bash"}_error`);
      }
    });
    debugLog()?.warn("ws", `recovering failed local mutation with real bash · reason=${reason || "unknown"} · session=${sessionPath}`);
    return true;
  }

  function maybeRecoverFailedLocalMutationCommand(sessionPath, ss, failedToolName, failedArgs, failedResultText) {
    if (
      !sessionPath ||
      !ss ||
      ss.failedLocalMutationRecoveryAttempted ||
      ss._turnClosed ||
      hasStreamEvent(ss, "turn_end") ||
      !looksLikeIncompleteLocalMutationProbe(failedToolName, failedArgs, failedResultText)
    ) {
      return false;
    }
    const session = engine.getSessionByPath(sessionPath);
    const command = buildExplicitPromptMutationCommand(ss, session, engine);
    if (!command) return false;
    const failedCommand = String(failedArgs?.command || failedArgs?.query || failedArgs?.cmd || "").trim();
    if (failedCommand && failedCommand === command.trim()) return false;
    ss.failedLocalMutationRecoveryAttempted = true;
    return executeRecoveredBashCommand(sessionPath, ss, session, command, "failed_local_mutation_recovery");
  }

  function shouldEmitFailedCodingToolFallback(ss, toolName, failedText = "") {
    if (!ss) return false;
    const name = String(toolName || "");
    if (!["bash", "read", "grep", "glob", "find"].includes(name)) return false;
    const prompt = ss.originalPromptText || ss.effectivePromptText || "";
    if (!looksLikeCodingDiagnosticPrompt(prompt)) return false;
    const visible = String(ss.visibleTextAcc || "").trim();
    if (visible.length > 120) return false;
    return looksLikeEarlyStoppedToolFailure(failedText) || ss.hasFailedTool;
  }

  function emitFailedCodingToolFallback(sessionPath, ss, reason = "coding_tool_failed_fallback") {
    if (!sessionPath || !ss || ss.__failedCodingToolFallbackEmitted) return false;
    const text = buildFailedToolFallbackText(ss);
    if (!text) return false;
    ss.__failedCodingToolFallbackEmitted = true;
    clearToolFinalizationTimer(ss);
    const closed = closeStreamWithVisibleFallback(sessionPath, ss, text, reason, {
      appendEvenIfHasOutput: true,
      trustedFallback: true,
      skipPostRehydrateRecover: true,
    });
    if (!closed && !hasDifferentActiveStreamToken(ss, ss.activeStreamToken)) {
      const prefix = ss.hasOutput ? "\n\n" : "";
      emitTrustedVisibleTextDelta(sessionPath, ss, prefix + text);
      if (!hasStreamEvent(ss, "turn_end")) {
        emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      }
      broadcast({ type: "status", isStreaming: false, sessionPath });
      finishSessionStream(ss);
      resetCompletedTurnState(ss);
      debugLog()?.warn("ws", `[FAILED-CODING-TOOL-FALLBACK v1] emitted after close refusal · reason=${reason} · session=${sessionPath}`);
      return true;
    }
    if (closed) {
      debugLog()?.warn("ws", `[FAILED-CODING-TOOL-FALLBACK v1] closed stream · reason=${reason} · session=${sessionPath}`);
    }
    return closed;
  }

  function maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, visibleTextBeforeReset = "", opts = {}) {
    const successfulTools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
    const hasOnlyLocalProbeTools =
      successfulTools.length > 0 &&
      successfulTools.every((tool) => looksLikeLocalMutationProbeCommand(tool));
    if (
      !sessionPath ||
      !ss ||
      ss.unexecutedLocalMutationRecoveryAttempted ||
      (ss.hasToolCall && !hasOnlyLocalProbeTools) ||
      (ss.hasError && !opts.ignoreError) ||
      ss._turnClosed ||
      hasStreamEvent(ss, "turn_end")
    ) {
      return false;
    }
    const requirement = classifyRequestedLocalMutation(ss.originalPromptText || ss.effectivePromptText || "");
    if (!requirement) return false;
    const session = engine.getSessionByPath(sessionPath);
    const command = buildExplicitPromptMutationCommand(ss, session, engine);
    if (!command) return false;
    ss.unexecutedLocalMutationRecoveryAttempted = true;
    debugLog()?.warn("ws", `recovering unexecuted local mutation with deterministic bash · visibleLen=${String(visibleTextBeforeReset || "").trim().length} · session=${sessionPath}`);
    return executeRecoveredBashCommand(sessionPath, ss, session, command, "unexecuted_local_mutation_recovery");
  }

  function maybeSteerPseudoToolSimulation(sessionPath, ss, textOverride = null) {
    if (!sessionPath || !ss) return false;
    const inspectedText = textOverride != null ? String(textOverride || "") : (ss.visibleTextAcc || ss.rawTextAcc || "");
    const hasPseudoToolText = containsPseudoToolCallSimulation(inspectedText);
    const hasFakeProgress = ss.progressMarkerCount > 0 && !ss.hasToolCall;
    if (!hasPseudoToolText && !hasFakeProgress) return false;

    // P0/P1: 不抢模型是否调用工具的决策，只在模型已经把伪工具泄漏给用户时兜底。
    // 本地文件任务可从原始用户意图构造确定性 bash，则真实执行；否则只标记并剥离泄漏文本，
    // 后续 turn-quality gate 会给一次受限 retry 或可见 fallback。这里不再 steerSession，
    // 避免“你刚才输出了伪工具调用...”提示造成循环。
    const recovered = maybeRecoverPseudoToolCommand(sessionPath, ss, inspectedText);
    if (recovered) {
      debugLog()?.warn("ws", `pseudo tool text recovered through real tool; suppressing leaked text without steer · session=${sessionPath}`);
      return true;
    }

    if (!ss.pseudoToolRecoveryHandled) {
      ss.pseudoToolSteered = true;
      ss.pseudoToolRecoveryHandled = true;
      debugLog()?.warn("ws", `pseudo tool/progress detected; suppressing leaked text without model steer · text=${hasPseudoToolText} fake_progress=${hasFakeProgress} count=${ss.progressMarkerCount} · session=${sessionPath}`);
    }
    return true;
  }

  function trimDegenerateTail(text) {
    let out = String(text || "");
    out = out.replace(/(?:\s*[—-]\s*[」]?\s*){8,}[\s\]\}】）」）]*$/g, "");
    out = out.replace(/(?:\s*[\]\}】）」）]){12,}\s*$/g, "");
    out = out.replace(/(.{1,6})\1{12,}\s*$/s, "");
    return out;
  }

  function emitTrustedVisibleTextDelta(sessionPath, ss, delta) {
    const next = trimDegenerateTail(String(delta || "")
      .replace(/�+/g, "")
      .replace(/<\|mask_(?:start|end)\|>/gi, ""));
    if (!next || !next.trim()) return false;
    ss.hasOutput = true;
    ss.titlePreview += next;
    ss.visibleTextAcc += next;
    emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: next });
    maybeGenerateFirstTurnTitle(sessionPath, ss);
    return true;
  }

  function emitVisibleTextDelta(sessionPath, ss, delta) {
    const rawNext = String(delta || "")
      .replace(/�+/g, "")
      .replace(/<\|mask_(?:start|end)\|>/gi, "");
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
    if (next.trim()) {
      ss.hasOutput = true;
      if (ss.hasToolCall && !ss.hasError && !hasStreamEvent(ss, "turn_end")) {
        scheduleToolFinalizationFallback(sessionPath, ss);
      } else {
        clearToolFinalizationTimer(ss);
      }
    }
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
      if (event?.type === "message_update" && ss) {
        maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, "late_message_update");
      }
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
        const deltaHasPseudoTool = containsNonProgressPseudoToolSimulation(delta);
        const accumulatedHasPseudoTool = !deltaHasPseudoTool && containsNonProgressPseudoToolSimulation(ss.rawTextAcc);
        if (deltaHasPseudoTool || accumulatedHasPseudoTool) {
          maybeSteerPseudoToolSimulation(sessionPath, ss, ss.rawTextAcc);
        }
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
              ss.progressParser.feed(tEvt.data, (pEvt) => {
                if (pEvt.type === "tool_progress") {
                  ss.progressMarkerCount++;
                  maybeSteerPseudoToolSimulation(sessionPath, ss);
                  return;
                }
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
      } else if (sub === "toolcall_end") {
        maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, "toolcall_end");
      } else if (sub === "error") {
        ss.hasError = true;
        if (isActive) broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error" });
        closeStreamAfterError(sessionPath, ss);
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0)) + 1;
      ss.lastToolExecutionActivity = Date.now();
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
              streamToken: ss.activeStreamToken || null,
              cwd: session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd(),
              filePath: resolvedPath,
              originalContent,
            });
          } catch {
            editRollbackStore.discardPending(event.toolCallId);
          }
        }
      }

      const rawArgs = normalizeToolArgsForSummary(event.toolName || "", event.args);
      let args;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgs[k] !== undefined) args[k] = rawArgs[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
      lifecycleHooks.run("tool_start", {
        event,
        ss,
        sessionPath,
        toolName: event.toolName || "",
        args,
      });
      try {
        const __slowName = event.toolName || "";
        const __slowToolCallId = event.toolCallId || null;
        const __slowTimer = setTimeout(() => {
          try { emitStreamEvent(sessionPath, ss, { type: "tool_progress", name: __slowName, event: "slow_warning", elapsedMs: 15000, toolCallId: __slowToolCallId }); } catch (_) { /* stream may have closed */ }
        }, 15000);
        ss.__slowToolTimers = ss.__slowToolTimers || new Map();
        ss.__slowToolTimers.set(__slowToolCallId || __slowName, __slowTimer);
      } catch (_) {
        // Slow-tool warnings are best-effort progress hints.
      }
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0) - 1);
      ss.lastToolExecutionActivity = Date.now();
      try {
        const __key = event.toolCallId || event.toolName || "";
        const __t = ss.__slowToolTimers?.get(__key);
        if (__t) { clearTimeout(__t); ss.__slowToolTimers.delete(__key); }
      } catch (_) {
        // Timer cleanup should never fail the tool result path.
      }

      const rawDetails = event.result?.details || {};
      const toolSummary = {};
      const toolName = event.toolName || "";
      const normalizedArgs = normalizeToolArgsForSummary(toolName, event.args) || {};
      const toolIsError = Boolean(event.isError || event.result?.isError);

      if (toolName === "edit" || toolName === "edit-diff") {
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
        const text = extractText(event.result?.content);
        const bytesMatch = text.match(/(\d+)\s*bytes/i);
        if (bytesMatch) toolSummary.bytesWritten = parseInt(bytesMatch[1], 10);
      } else if (toolName === "bash") {
        const text = extractText(event.result?.content);
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
      } else {
        const text = extractText(event.result?.content);
        if (text) toolSummary.outputPreview = text.slice(0, 200);
      }

      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: toolName,
        success: !toolIsError,
        details: rawDetails,
        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
      });
      lifecycleHooks.run("tool_end", {
        event,
        ss,
        sessionPath,
        toolName,
        success: !toolIsError,
        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
      });

      if (!toolIsError) {
        rememberSuccessfulTool(ss, toolName, toolSummary, normalizedArgs);
      } else {
        rememberFailedTool(ss, toolName);
        const failedText = extractText(event.result?.content);
        if (maybeRecoverFailedLocalMutationCommand(sessionPath, ss, toolName, normalizedArgs, failedText)) {
          clearToolAuthorizationTimer(ss);
          return;
        }
        if (shouldEmitFailedCodingToolFallback(ss, toolName, failedText)) {
          clearToolAuthorizationTimer(ss);
          emitFailedCodingToolFallback(sessionPath, ss);
          return;
        }
      }
      clearToolAuthorizationTimer(ss);
      scheduleToolFinalizationFallback(sessionPath, ss);

      if ((toolName === "edit" || toolName === "edit-diff") && event.toolCallId) {
        if (toolIsError || !rawDetails.diff) {
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

      if ((event.toolName === "edit" || event.toolName === "edit-diff") && rawDetails.diff && !toolIsError) {
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

      if (event.toolName === "create_artifact" || event.toolName === "create_report") {
        const d = event.result?.details || {};
        if (d.artifactId && d.type && d.content) {
          emitStreamEvent(sessionPath, ss, {
            type: "artifact",
            artifactId: d.artifactId,
            artifactType: d.type,
            title: d.title,
            content: d.content,
            language: d.language || (d.type === "html" ? "html" : undefined),
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
      scheduleToolAuthorizationFallback(sessionPath, ss);
    } else if (event.type === "skill_activated") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "skill_activated",
        skillName: event.skillName,
        skillFilePath: event.skillFilePath,
      });
    } else if (event.type === "confirmation_resolved") {
      if (sessionPath && ss && ss.isStreaming && !ss._turnClosed && !hasStreamEvent(ss, "turn_end")) {
        scheduleToolAuthorizationFallback(sessionPath, ss);
      }
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
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[TURN-END v4] defer turn_end (tool still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return;
      }
      if (ss.hasToolCall && !ss.hasError && !ss._turnEndDeferred) {
        ss._turnEndDeferred = true;
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[TURN-END v2] defer tool-phase turn_end (awaiting final assistant text) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return;
      }
      if (ss._turnEndDeferred) {
        debugLog()?.log("ws", `[TURN-END v1] resuming deferred turn_end · hasOutput=${ss.hasOutput} hasToolCall=${ss.hasToolCall} · ${sessionPath}`);
      }
      lifecycleHooks.run("turn_end", {
        event,
        ss,
        sessionPath,
        hasOutput: ss.hasOutput,
        hasToolCall: ss.hasToolCall,
      });
      clearTurnTimers(ss);
      if (ss.streamSource === "internal_retry") {
        ss.internalRetryPending = false;
        ss.internalRetryInFlight = false;
        ss.internalRetryReason = "";
      }
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // flush 顺序：ThinkTag → LynnProgress → Mood → Xing
      const feedMoodPipeline = (text) => {
        ss.progressParser.feed(text, (pEvt) => {
          if (pEvt.type === "tool_progress") {
            ss.progressMarkerCount++;
            debugLog()?.warn("ws", `suppressed hallucinated <lynn_tool_progress> during flush · ${sessionPath}`);
            return;
          }
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
      if (maybeRecoverUnexecutedLocalMutationCommand(sessionPath, ss, visibleTextBeforeReset)) {
        clearTurnTimers(ss);
        finishSessionStream(ss);
        return;
      }
      let internalRetry = null;
      const qualitySnapshot = createTurnQualitySnapshot(ss, visibleTextBeforeReset);
      const applyTurnQualityDecision = (decision) => {
        if (!decision) return null;
        if (decision.markPendingToolRetryAttempted) ss.pendingToolRetryAttempted = true;
        if (decision.markToolFailedFallbackRetryAttempted) ss.toolFailedFallbackRetryAttempted = true;
        if (decision.flag === "toolFinalizationRetryAttempted") ss.toolFinalizationRetryAttempted = true;
        if (decision.type === "fallback") {
          if (decision.text && shouldSuppressGenericEmptyFallback(ss, decision.text)) {
            debugLog()?.warn("ws", `[TURN-QUALITY-FALLBACK-SUPPRESS v1] suppressed generic fallback · route=${ss?.routeIntent || "unknown"} · session=${sessionPath}`);
          } else if (decision.text) {
            emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: decision.text });
            ss.visibleTextAcc += decision.text;
            ss.hasOutput = true;
          }
        }
        if (decision.logMessage) {
          const logger = debugLog();
          const level = decision.logLevel === "log" ? "log" : "warn";
          const logFn = logger?.[level];
          if (typeof logFn === "function") logFn.call(logger, "ws", decision.logMessage);
        }
        if (decision.type === "retry") {
          return { reason: decision.reason, prompt: decision.prompt };
        }
        return null;
      };

      internalRetry = applyTurnQualityDecision(evaluatePreTurnEndQuality(ss, qualitySnapshot, {
        isActive,
        sessionPath,
        visibleTextBeforeReset,
      }));

      if (internalRetry) {
        // Keep the user-visible turn open while the internal retry runs. Emitting
        // turn_end here makes the UI/test harness treat the failed draft as final
        // and can drop the repaired answer that follows.
        clearTurnTimers(ss);
        finishSessionStream(ss);
        if (ss.progressMarkerCount > 0 && !ss.hasToolCall) {
          debugLog()?.warn("ws", `observed ${ss.progressMarkerCount} hallucinated <lynn_tool_progress> markers before internal retry · session=${sessionPath}`);
        }
        doScheduleInternalRetry(sessionPath, internalRetry.reason, internalRetry.prompt);
        if (isActive) debugLog()?.log("ws", `assistant reply deferred for internal retry · reason=${internalRetry.reason}`);
        return;
      }

      maybeEmitLocalToolCompletionFallback(sessionPath, ss);

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      broadcast({ type: "status", isStreaming: false, sessionPath });
      internalRetry = internalRetry || applyTurnQualityDecision(evaluatePostTurnEndQuality(ss, qualitySnapshot, {
        internalRetry,
        sessionPath,
        visibleTextBeforeReset,
      }));
      (async () => {
        try {
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
      if (ss.progressMarkerCount > 0 && !ss.hasToolCall) {
        debugLog()?.warn("ws", `observed ${ss.progressMarkerCount} hallucinated <lynn_tool_progress> markers (no real tool_call) · session=${sessionPath}`);
      }
      resetCompletedTurnState(ss);
      if (internalRetry) {
        doScheduleInternalRetry(sessionPath, internalRetry.reason, internalRetry.prompt);
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

  // ── WebSocket 路由 ──

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
          const msg = wsParse(event.data);
          if (!msg) return;

          (async () => {
            if (msg.type === "abort") {
              const abortPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.isSessionStreaming(abortPath)) {
                try { await hub.abort(abortPath); } catch (err) { console.warn("[chat] abort failed:", err?.message || err); }
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
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

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
              if (!checkRateLimit(ws)) {
                wsSend(ws, { type: "error", message: "Rate limit exceeded. Please wait before sending another message." });
                return;
              }
              if (msg.images?.length) {
                const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
                const MAX_IMAGES = 10;
                const MAX_BYTES = 20 * 1024 * 1024;
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
              const _resolved = engine.resolveModelOverrides(engine.currentModel);
              if (msg.images?.length && _resolved?.vision === false) {
                wsSend(ws, { type: "error", message: buildVisionUnsupportedMessage({ locale: getLocale() }) });
                return;
              }
              const promptText = normalizeVisionPromptText(msg.text || "", msg.images, { locale: getLocale() });
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
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
                const isInternalRetryStream = ss?.streamSource === "internal_retry";
                const shouldReleaseStale = isStaleEmptySessionStream(ss)
                  || (engineStreaming && !ss?.isStreaming)
                  || isInternalRetryStream;
                const releasedStale = shouldReleaseStale
                  ? await releaseStaleSessionStream(promptSessionPath, ss)
                  : false;
                if (releasedStale && isInternalRetryStream) {
                  debugLog()?.warn("ws", `[INTERNAL-RETRY-FENCE v1] aborted stale internal retry on new user prompt · session=${promptSessionPath}`);
                }
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
                ss.internalRetryPending = false;
                ss.internalRetryInFlight = false;
                ss.internalRetryReason = "";
                ss.pseudoToolSteered = false;
                ss.pseudoToolRecoveryHandled = false;
                ss.pseudoToolCommandRecoveryAttempted = false;
                ss.pseudoToolXmlBlock = null;
                ss.rehydratedThisTurn = false;
                ss.postRehydrateEscalationAttempted = false;
                ss.postRehydrateDeterministicAttempted = false;
                ss.hasOutput = false;
                ss.hasToolCall = false;
                ss.hasThinking = false;
                ss.hasError = false;
                ss.persistedAssistantTextBaseline = countPersistedAssistantVisibleTexts(
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
                const currentModelInfo = resolveCurrentModelInfo(engine);
                const initialToolUse = resolveInitialToolUseBehavior(promptText, { modelInfo: currentModelInfo });
                if (initialToolUse.behavior === TOOL_USE_BEHAVIOR.STOP_WITH_DIRECT_ANSWER) {
                  emitVisibleTextDelta(promptSessionPath, ss, initialToolUse.directAnswer);
                  emitStreamEvent(promptSessionPath, ss, { type: "turn_end" });
                  lifecycleHooks.run("turn_end", {
                    ss,
                    sessionPath: promptSessionPath,
                    hasOutput: ss.hasOutput,
                    hasToolCall: ss.hasToolCall,
                    direct: true,
                  });
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                  finishSessionStream(ss);
                  resetCompletedTurnState(ss);
                  return;
                }
                const reportKind = initialToolUse.reportKind;
                const budgetContext = initialToolUse.budgetContext || "";
                let effectivePromptText = initialToolUse.effectivePromptText || promptText;
                if (ss._rehydratedEffectivePrompt) {
                  effectivePromptText = ss._rehydratedEffectivePrompt;
                  ss._rehydratedEffectivePrompt = null;
                }
                let directResearchAnswer = "";
                if (!rehydratedMutation && initialToolUse.behavior === TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP) {
                  const toolName = initialToolUse.toolName;
                  ss.hasPrefetchToolCall = true;
                  emitStreamEvent(promptSessionPath, ss, { type: "tool_start", name: toolName, args: { query: promptText } });
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
                      directResearchAnswer = buildDirectResearchAnswer(reportKind, reportContext, promptText);
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
                  } catch (prefetchErr) {
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
                  }
                }
                if (directResearchAnswer) {
                  emitVisibleTextDelta(promptSessionPath, ss, directResearchAnswer);
                  emitStreamEvent(promptSessionPath, ss, { type: "turn_end" });
                  lifecycleHooks.run("turn_end", {
                    ss,
                    sessionPath: promptSessionPath,
                    hasOutput: ss.hasOutput,
                    hasToolCall: ss.hasToolCall,
                    direct: true,
                  });
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                  finishSessionStream(ss);
                  resetCompletedTurnState(ss);
                  return;
                }
                if (ss._lastTurnAborted) {
                  effectivePromptText = `【系统注意】上一个问题因超时未能回答。本轮只回答下面这个当前问题,不要再回答之前未答复的任何问题。\n\n${effectivePromptText}`;
                  ss._lastTurnAborted = false;
                }
                ss.effectivePromptText = effectivePromptText;
                let activeStreamToken = streamToken;
                let sendAttempt = 0;
                while (sendAttempt < 2) {
                  sendAttempt += 1;
                  scheduleSilentBrainAbort(promptSessionPath, ss);
                  try {
                    await hub.send(
                      effectivePromptText,
                      msg.images
                        ? { images: msg.images, sessionPath: promptSessionPath, streamToken: activeStreamToken }
                        : { sessionPath: promptSessionPath, streamToken: activeStreamToken },
                    );
                    if (!ss.isStreaming) {
                      if (hasToolExecutionInFlight(ss)) {
                        scheduleToolFinalizationFallback(promptSessionPath, ss);
                        debugLog()?.log("ws", `[HUB-SEND v2] returned while tool is still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}; defer close · ${promptSessionPath}`);
                        break;
                      }
                      clearTurnTimers(ss);
                      if (!finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_closed_without_turn_end")) {
                        broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                      }
                    } else if (!hasToolExecutionInFlight(ss) && finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_open_without_turn_end", { requirePersistedText: true })) {
                      // finalized from the persisted non-streaming assistant message
                    } else {
                      scheduleReturnedTurnFinalizationFallback(promptSessionPath, ss, "hub_send_returned_open_safety_timeout");
                      debugLog()?.log("ws", `hub.send returned while server stream remains open · ${promptSessionPath}`);
                    }
                    break;
                  } catch (sendErr) {
                    clearTurnTimers(ss);
                    const busyMessage = String(sendErr?.message || sendErr || "");
                    const isHiddenBusy = /already processing a prompt/i.test(busyMessage);
                    if (isHiddenBusy && sendAttempt < 2 && !ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError) {
                      await forceResetSessionStream(promptSessionPath, ss, "agent_hidden_busy");
                      const retryToken = beginSessionStream(ss);
                      ss.activeStreamToken = retryToken;
                      ss.streamSource = "user";
                      scheduleTurnHardAbort(promptSessionPath, ss);
                      schedulePersistedFinalAnswerPoll(promptSessionPath, ss);
                      broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
                      activeStreamToken = retryToken;
                      debugLog()?.warn("ws", `[HIDDEN-BUSY-RETRY v1] retrying same prompt after forced reset · session=${promptSessionPath}`);
                      continue;
                    }
                    throw sendErr;
                  }
                }
              } catch (err) {
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

        onClose(event, ws) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute, broadcast, editRollbackStore, lifecycleHooks };
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 */
async function generateSessionTitle(engine, notify, opts = {}) {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

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

    let title = await engine.summarizeTitle(userText, assistantText, { timeoutMs: 15_000 });

    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return;
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    await engine.saveSessionTitle(sessionPath, title);

    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", err.message);
    return false;
  }
}
