/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { t, getLocale } from "../server/i18n.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { findModel } from "../shared/model-ref.js";
import { lookupToolTier } from "../shared/known-models.js";
import { detectPromptInjection, formatInjectionWarning } from "../lib/sandbox/prompt-injection-detector.js";
import {
  SecurityMode,
  DEFAULT_SECURITY_MODE,
  normalizeSecurityMode,
  SECURITY_MODE_CONFIG,
} from "../shared/security-mode.js";
import {
  buildClientAgentMetadata,
  readClientAgentKeyFromPreferencesFile,
  readSignedClientAgentHeaders,
} from "./client-agent-identity.js";
import { resolveCompactionSettings, resolveModelContextWindow } from "./compaction-settings.js";
import { formatProjectInstructions } from "../lib/project-instructions.js";
import { getBrainDisplayName, isBrainModelRef } from "../shared/brain-provider.js";
import { getUserFacingModelAlias, getUserFacingRoleModelLabel, resolveRoleDefaultModel } from "../shared/assistant-role-models.js";
import {
  buildProviderToolCallHint,
  buildRouteIntentSystemHint,
  classifyRouteIntent,
  ROUTE_INTENTS,
} from "../shared/task-route-intent.js";
import { buildScenarioContractHintForText } from "../shared/scenario-contracts.js";
import {
  isNativeToolCallingDisabled,
  routeIntentRequiresNativeTools,
} from "../shared/model-tool-capabilities.js";
import { stripPseudoToolCallMarkup } from "../shared/pseudo-tool-call.js";
import { containsPseudoToolCallSimulation } from "./llm-utils.js";

const log = createModuleLogger("session");

function shouldExposeVerboseModelRouting() {
  const flag = String(process?.env?.LYNN_DEBUG_MODELS || process?.env?.DEBUG_MODEL_ROUTING || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || process?.env?.NODE_ENV === "development";
}

/** 巡检/定时任务默认工具白名单 */
export const PATROL_TOOLS_DEFAULT = [
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "web_search", "web_fetch",
  "todo", "notify",
  "present_files", "message_agent",
];

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}

function buildRouteAndScenarioHint(text, routeIntent, opts = {}) {
  const locale = opts.locale || getLocale();
  return [
    buildRouteIntentSystemHint(routeIntent, locale),
    buildScenarioContractHintForText(text, {
      locale,
      imagesCount: opts.imagesCount || 0,
      attachmentsCount: opts.attachmentsCount || 0,
      audioCount: opts.audioCount || 0,
    }),
  ].filter(Boolean).join("\n");
}

function shouldInjectLocalRoutePromptHints() {
  const flag = String(process?.env?.LYNN_LOCAL_ROUTE_PROMPT_HINTS || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function toSessionPromptOptions(images) {
  if (!images?.length) return undefined;
  return {
    images: images.map((img) => ({
      type: "image",
      // pi-coding-agent 的 SDK 文档已切到 source.base64，
      // 但底层 pi-ai 目前仍按顶层 data/mimeType 读取图片。
      // 两套字段都带上，兼容当前链路上的版本差异。
      data: img.data,
      mimeType: img.mimeType || "image/png",
      source: {
        type: "base64",
        mediaType: img.mimeType || "image/png",
        data: img.data,
      },
    })),
  };
}

// ── Tool Tiering（P0：按模型能力裁剪自定义工具集） ──

const MINIMAL_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market", "weather", "live_news", "sports_score",
  "knowledge_query", // v0.77 rag-core: 小模型也支持轻量知识库查询
]);

const STANDARD_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market", "weather", "live_news", "sports_score", "todo", "present_files", "notify",
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  // v0.77 插件工具（standard 档开放）
  "knowledge_index", "knowledge_query", // rag-core
  "tts_speak",                         // tts-bridge
  "generate_image",                    // flux-studio
]);

/**
 * 按 toolTier 裁剪自定义工具列表
 * @param {Array} customTools
 * @param {"full"|"standard"|"minimal"|null} tier - null/undefined = full
 * @returns {Array}
 */
function filterCustomToolsByTier(customTools, tier) {
  if (!tier || tier === "full") return customTools;
  if (tier === "none") return [];
  const allowed = tier === "minimal" ? MINIMAL_CUSTOM_TOOLS : STANDARD_CUSTOM_TOOLS;
  return customTools.filter(t => allowed.has(t.name));
}

/**
 * 推断模型的 toolTier
 * 优先使用 known-models.json 标注，fallback 按 context window 推断
 */
function resolveToolTier(model) {
  if (!model) return null;
  if (isNativeToolCallingDisabled(model)) return "none";
  const tier = lookupToolTier(model.provider, model.id);
  if (tier) return tier;
  // fallback: context < 32K → minimal
  const cw = model.contextWindow;
  if (cw && cw < 32_000) return "minimal";
  return null;
}

function findToolCapableFallbackModel(models, agentRole = null, currentModel = null) {
  const available = models?.availableModels || [];
  const candidates = [
    resolveRoleDefaultModel(available, agentRole),
    models?.defaultModel,
    findModel(available, "lynn-brain-router", "brain"),
    ...available.filter((model) => model?.provider === "brain"),
  ].filter(Boolean);

  const currentKey = currentModel ? `${currentModel.provider || ""}/${currentModel.id || ""}` : "";
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.provider || ""}/${candidate.id || ""}`;
    if (!candidate?.id || seen.has(key) || key === currentKey) continue;
    seen.add(key);
    if (!isNativeToolCallingDisabled(candidate)) return candidate;
  }
  return null;
}
const MAX_CACHED_SESSIONS = 20;
const SESSION_RELAY_SUMMARY_MAX_CHARS = 4000;
const DEFAULT_SESSION_RELAY = {
  enabled: true,
  compactionThreshold: 3,
  summaryMaxTokens: 800,
};
const DRY_RUN_COPY_IGNORES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

function createReplyIntegrityTracker() {
  return {
    replyText: "",
    sawToolCall: false,
    handle(event) {
      if (event?.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") {
          this.replyText += sub.delta || "";
        } else if (sub?.type === "toolcall_start" || sub?.type === "toolcall_end") {
          this.sawToolCall = true;
        }
        return;
      }

      if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
        this.sawToolCall = true;
      }
    },
  };
}

function pseudoToolSimulationMessage() {
  const localized = t("error.invalidToolSimulation");
  return localized && localized !== "error.invalidToolSimulation"
    ? localized
    : "Model emitted an invalid tool-call simulation instead of executing the tool.";
}

function createPseudoToolSimulationError(replyText = "") {
  const err = new Error(pseudoToolSimulationMessage());
  err.code = "INVALID_TOOL_SIMULATION";
  err.replyText = replyText;
  return err;
}

function ensureValidReplyExecution(tracker) {
  if (!tracker || tracker.sawToolCall) return;
  if (!containsPseudoToolCallSimulation(tracker.replyText)) return;
  throw createPseudoToolSimulationError(tracker.replyText);
}

function buildPseudoToolRetryPrompt(prompt) {
  const isZh = getLocale().startsWith("zh");
  return [
    isZh
      ? "【严格执行要求】上一轮把工具调用写成了正文文本，没有真正执行工具。"
      : "[Strict execution requirement] The previous attempt simulated tool calls in plain text instead of actually executing them.",
    isZh
      ? "这一次不要输出任何 <tool_call>、XML、shell、web_search(...) 之类的伪工具文本。请直接调用真实工具完成当前任务，拿到结果后再回复。"
      : "Do not output any pseudo tool text such as <tool_call>, XML, shell commands, or web_search(...). Use the real tool interface, finish the task, and only then reply.",
    String(prompt || ""),
  ].filter(Boolean).join("\n\n");
}

function getBuiltinToolNames(tools) {
  return tools.map((tool) => tool.name);
}

function buildSkillToolCompatibilityHint(skillName) {
  const isZh = getLocale().startsWith("zh");
  const toolNames = "read, write, edit, bash, grep, find, ls";
  if (isZh) {
    return [
      "【Lynn 技能执行兼容说明】",
      `- 这是已启用技能「${skillName || "unknown"}」的执行指令，不是普通参考资料。`,
      `- 如果技能正文或 frontmatter 提到 Read / Write / Edit / Bash，请映射为当前 Lynn 工具名：${toolNames}。`,
      "- 需要读写文件、运行脚本、整理项目时，必须调用真实工具；不要把工具调用写成正文，也不要只口头说“我会去做”。",
      "- 如果当前模型或执行模式没有对应工具，先明确说明缺少哪个工具或权限，再给用户下一步选择。",
    ].join("\n");
  }
  return [
    "[Lynn skill execution compatibility]",
    `- These are executable instructions for the enabled skill "${skillName || "unknown"}", not just reference text.`,
    `- If the skill body or frontmatter mentions Read / Write / Edit / Bash, map them to the current Lynn tool names: ${toolNames}.`,
    "- When the task requires reading/writing files, running scripts, or organizing a project, use real tool calls. Do not print pseudo tool calls as plain text.",
    "- If the current model or execution mode lacks a required tool, say which tool/permission is missing and ask for the next step.",
  ].join("\n");
}

function buildSkillHintContext(suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return "";
  const isZh = getLocale().startsWith("zh");

  // 尝试直接注入最佳匹配 skill 的内容（Brain 模式下模型无法自己 read 文件）
  const bestSkill = suggestions[0];
  let skillContent = "";
  if (bestSkill?.filePath) {
    try {
      skillContent = fs.readFileSync(bestSkill.filePath, "utf-8").trim();
      // 截断过长的 skill 内容（保留前 3000 字符，避免撑爆 GPU 16K 上下文）
      if (skillContent.length > 3000) skillContent = skillContent.slice(0, 3000) + "\n...(truncated)";
    } catch {}
  }

  if (skillContent) {
    return [
      isZh
        ? `【技能已加载】当前请求匹配技能「${bestSkill.name}」，以下是完整指令，请严格按照指令执行：`
        : `[Skill Loaded] Request matches skill "${bestSkill.name}". Follow these instructions:`,
      "",
      buildSkillToolCompatibilityHint(bestSkill.name),
      "",
      skillContent,
    ].join("\n");
  }

  // Fallback：提示模型自己去读
  if (isZh) {
    return [
      "【技能候选提示】当前请求很可能匹配以下已启用技能：",
      ...suggestions.map((skill) => {
        const matches = skill.matchedTokens?.length ? `（命中：${skill.matchedTokens.join("、")}）` : "";
        return `- ${skill.name}${skill.description ? `：${skill.description}` : ""}${matches}`;
      }),
      "请先用 read 工具打开最相关技能的 SKILL.md，再按里面的步骤执行。",
    ].join("\n");
  }

  return [
    "[Skill Hint] This request likely matches these enabled skills:",
    ...suggestions.map((skill) => {
      const matches = skill.matchedTokens?.length ? ` (matched: ${skill.matchedTokens.join(", ")})` : "";
      return `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}${matches}`;
    }),
    "Read the most relevant skill's SKILL.md first, then follow its workflow.",
  ].join("\n");
}

function shouldAttachSkillHint(routeIntent) {
  return normalizeRouteIntent(routeIntent) !== ROUTE_INTENTS.UTILITY;
}

const FILE_MENTION_PATTERN = /\b([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh))\b/gi;

function buildAtInjectionPromptHint(text) {
  if (!text || /@\S+/.test(text)) return "";
  if (/\[(附件|目录|参考文档|Git 上下文)\]/.test(text)) return "";

  const files = [...new Set(Array.from(text.matchAll(FILE_MENTION_PATTERN)).map((match) => match[1]).filter(Boolean))].slice(0, 3);
  if (files.length === 0) return "";

  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return [
      "【上下文引导】如果用户提到了具体文件，但你还没看到文件内容，请先用一句很短的人话提醒用户把文件给你看，再继续分析。",
      `优先引导格式：输入 ${files.map((file) => `@${file}`).join("、")}，或直接把文件拖到输入框。`,
      "只在确实缺文件内容时提示一次，不要重复说教。",
    ].join("\n");
  }

  return [
    "[Context Guidance] If the user mentions a specific file but you have not seen its contents yet, first give one short, natural sentence asking them to share it before you continue.",
    `Prefer guidance like: type ${files.map((file) => `@${file}`).join(", ")} or drag the file into the composer.`,
    "Only do this when file contents are genuinely missing, and do not over-explain.",
  ].join("\n");
}

export class SessionCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {() => object} deps.getConfirmStore
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   */
  constructor(deps) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessRefCount = 0;
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
    this._pendingPlanMode = false;
    this._pendingSecurityMode = DEFAULT_SECURITY_MODE;
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr, cwd, memoryEnabled = true, model = null) {
    const t0 = Date.now();
    const effectiveCwd = cwd || this._d.getHomeCwd() || process.cwd();
    const agent = this._d.getAgent();
    const models = this._d.getModels();
    const effectiveModel = model || this._pendingModel || models.currentModel;
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} (传入: ${cwd || "未指定"})`);

    if (!effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }

    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }

    // 必须在 createAgentSession 前切换 session 级记忆状态，
    // 否则首轮 prompt 会沿用上一个 session 的 system prompt。
    const creatingAgent = agent;
    creatingAgent.setMemoryEnabled(memoryEnabled);

    const baseResourceLoader = this._d.getResourceLoader();
    const sessionEntry = {}; // populated after session creation; resourceLoader proxy references this

    // Wrap resourceLoader to dynamically inject security mode context and proactive recall into system prompt
    const resourceLoader = Object.create(baseResourceLoader, {
      getAppendSystemPrompt: {
        value: () => {
          const base = baseResourceLoader.getAppendSystemPrompt();
          const extras = [...base];

          // Phase 1: 注入主动召回上下文（一次性消费）
          if (sessionEntry._lastRecallContext) {
            extras.push(sessionEntry._lastRecallContext);
          }
          if (sessionEntry._lastSkillHintContext) {
            extras.push(sessionEntry._lastSkillHintContext);
          }
          if (sessionEntry._atInjectionHintContext) {
            extras.push(sessionEntry._atInjectionHintContext);
          }
          if (shouldInjectLocalRoutePromptHints() && sessionEntry._routeIntentHintContext) {
            extras.push(sessionEntry._routeIntentHintContext);
          }
          const providerToolCallHint = buildProviderToolCallHint({
            routeIntent: sessionEntry._routeIntentValue,
            provider: sessionEntry.modelProvider || effectiveModel?.provider || sessionEntry.session?.model?.provider,
            modelId: sessionEntry.modelId || effectiveModel?.id || sessionEntry.session?.model?.id,
            locale: getLocale(),
          });
          if (providerToolCallHint) {
            extras.push(providerToolCallHint);
          }
          if (sessionEntry._relaySummaryContext) {
            extras.push(sessionEntry._relaySummaryContext);
          }

          const secMode = sessionEntry.securityMode || DEFAULT_SECURITY_MODE;
          const isZh = String(this._d.getAgent().config?.locale || "").startsWith("zh");

          if (secMode === SecurityMode.PLAN) {
            const planModePrompt = isZh
              ? "【系统通知】当前处于「规划模式」，用户在设置中选择了只读规划。你只能使用只读工具（read、grep、find、ls）和自定义工具。不能执行写入、编辑、删除等操作。如果用户要求你做这些操作，请告知当前处于规划模式，需要先在输入框左下角切换到「执行模式」。"
              : "[System Notice] Currently in PLAN MODE. You can only use read-only tools (read, grep, find, ls) and custom tools. You cannot write, edit, or delete. If the user asks for these operations, inform them to switch to 'Execute Mode' via the selector at the bottom-left of the input area.";
            extras.push(planModePrompt);
          } else if (secMode === SecurityMode.SAFE) {
            const safeModePrompt = isZh
              ? "【系统通知】当前处于「安全模式」，所有危险操作（sudo、chmod 等）和受保护路径的写入都会被直接拒绝，不会弹出确认。如果用户确实需要执行这些操作，请告知先在输入框左下角切换到「执行模式」。"
              : "[System Notice] Currently in SAFE MODE. Dangerous operations (sudo, chmod, etc.) and writes to protected paths are directly rejected with no approval prompt. If the user truly needs them, ask them to switch to 'Execute Mode' via the selector at the bottom-left of the input area.";
            extras.push(safeModePrompt);
          }
          else {
            const executeModePrompt = isZh
              ? [
                  "【系统通知】当前处于「执行模式」，你可以使用真实工具执行命令、读写文件和完成安装类操作。",
                  "当用户要求你安装软件、安装依赖、执行终端命令、检查命令是否成功时，不要说自己没有 shell/命令工具，也不要让用户手动复制命令去终端运行。",
                  "在这类场景下，应优先使用真实 bash 工具执行，并基于执行结果继续完成任务。",
                  "如果命令涉及安装软件、提升权限、写入系统路径或执行远程安装脚本，系统会自动弹出确认卡片；你只需要正常发起真实工具调用。",
                ].join(" ")
              : [
                  "[System Notice] You are currently in EXECUTE MODE and may use real tools to run commands, read/write files, and carry out installation tasks.",
                  "When the user asks you to install software, install dependencies, run terminal commands, or verify whether a command succeeded, do not claim that you lack shell or command tools and do not tell the user to copy commands into a terminal manually.",
                  "In these cases, prefer the real bash tool and continue the task based on the execution result.",
                  "If a command installs software, elevates privileges, writes to system paths, or runs a remote install script, the system will automatically show a confirmation card; you should still initiate the real tool call normally.",
                ].join(" ");
            extras.push(executeModePrompt);
          }

          // 项目级指令注入（AGENTS.md / CLAUDE.md 等）
          const sessionCwd = sessionEntry.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd() || "";
          const preferredDeskPath = this._d.getHomeCwd() || "";
          if (preferredDeskPath) {
            const deskHint = isZh
              ? (sessionCwd && sessionCwd !== preferredDeskPath
                  ? `【书桌工作区】用户提到「书桌」「当前工作区」时，默认优先指 ${preferredDeskPath}。只有用户明确说当前代码仓库、当前源码目录或当前 cwd 时，才使用 ${sessionCwd}。`
                  : `【书桌工作区】用户提到「书桌」「当前工作区」时，默认就是 ${preferredDeskPath}。`)
              : (sessionCwd && sessionCwd !== preferredDeskPath
                  ? `[Desk workspace] When the user says "desk" or "current workspace", prefer ${preferredDeskPath} by default. Only switch to ${sessionCwd} when they explicitly mean the current repo/cwd.`
                  : `[Desk workspace] When the user says "desk" or "current workspace", it refers to ${preferredDeskPath}.`);
            extras.push(deskHint);
          }
          if (sessionCwd) {
            try {
              const projectCtx = formatProjectInstructions(sessionCwd, isZh);
              if (projectCtx) extras.push(projectCtx);
            } catch { /* non-fatal */ }
          }

          try {
            const mcpCtx = this._d.getMcpPromptContext?.();
            if (mcpCtx) extras.push(mcpCtx);
          } catch { /* non-fatal */ }

          // Context importance: guide compaction to preserve critical information
          // 小模型精简版：只保留核心指令，省略详细说明
          const modelCw = resolveModelContextWindow(sessionEntry.session?.model);
          const isSmallModel = modelCw && modelCw < 32_000;
          if (isSmallModel) {
            const compactPrompt = isZh
              ? "【重要】回复末尾用 <!-- KEY: 结论 --> 标注本轮关键结论，压缩时优先保留。回复控制在 500 字以内。"
              : "[IMPORTANT] End replies with <!-- KEY: conclusion --> to mark key conclusions for retention. Keep replies under 500 words.";
            extras.push(compactPrompt);

            // P1: 弱模型工具调用规则引导
            extras.push(isZh
              ? [
                  "【工具调用规则】",
                  "1. 每次只调用一个工具，等结果回来再决定下一步",
                  "2. 调用工具前先用一句话说清楚你要做什么",
                  "3. 不要编造不存在的工具名",
                  "4. 参数中的文件路径必须使用绝对路径",
                  "5. 如果不确定该用哪个工具，先用 bash 执行简单命令",
                  "6. 不要在正文中模拟工具调用（如写出 JSON、<tool_call>、<tool>、<toolcode>、<function=...> 这类文本但不通过工具接口发送）",
                ].join("\n")
              : [
                  "[Tool Call Rules]",
                  "1. Call only one tool at a time; wait for the result before deciding the next step",
                  "2. Before calling a tool, briefly state what you intend to do",
                  "3. Do not invent tool names that do not exist",
                  "4. Always use absolute paths for file parameters",
                  "5. When unsure which tool to use, try bash with a simple command first",
                  "6. Do not simulate tool calls in text (for example JSON, <tool_call>, <tool>, <toolcode>, or <function=...> markup without actually invoking a tool)",
                ].join("\n")
            );

            // P1: 工具分组摘要
            extras.push(isZh
              ? "可用工具概览：文件操作（read/write/edit/bash）、搜索（grep/find/web_search）。先想清楚要做什么，再选工具。"
              : "Tool overview: File ops (read/write/edit/bash), Search (grep/find/web_search). Think first, then pick."
            );

            // P3: 计划模式引导
            extras.push(isZh
              ? "对于用户已经明确要求的本地整理、移动、创建、读取、安装等任务，在执行模式下应继续使用真实工具完成到可验证结果，不要只列计划或停在第一步。只有路径不明确、可能删除/覆盖重要数据、需要 sudo/系统目录/远程脚本等高风险操作时，才先向用户确认。"
              : "For clearly requested local organize/move/create/read/install tasks, continue using real tools in execute mode until there is a verifiable result; do not stop after planning or the first step. Ask for confirmation first only when paths are ambiguous, important data may be deleted/overwritten, or the action needs sudo/system paths/remote scripts."
            );
          } else {
            const importancePrompt = isZh
              ? "【上下文保留策略】当对话很长时，系统会自动压缩旧消息。为确保关键信息不丢失：在输出重要决策、计划步骤、验证结论或用户明确要求记住的内容时，请用简洁的要点重申核心结论，这样即使旧消息被压缩，关键信息也会在最近的消息中保留。"
              : "[Context Retention] When conversations are long, the system auto-compacts old messages. To ensure critical info survives: when outputting important decisions, plan steps, verification conclusions, or things the user explicitly asked to remember, briefly restate the core conclusions so they remain in recent messages even after compaction.";
            extras.push(importancePrompt);
          }

          extras.push(isZh
            ? "【工具调用底线】绝不要在正文中伪造工具调用（例如输出 <tool_call>、<invoke>、<toolcode>、XML/JSON 工具参数等文本）。需要用工具时必须调用真实工具接口，而不是把工具格式打印给用户看。"
            : "[Tool Call Hard Rule] Never fake tool calls in plain text (for example <tool_call>, <invoke>, <toolcode>, or XML/JSON tool arguments). When a tool is needed, you must invoke the real tool interface instead of printing tool-call markup to the user."
          );

          // 笺引导：首次 session 的前几轮对话中，提醒用户使用笺
          const turnCount = sessionEntry.session?.turnCount ?? sessionEntry.session?.sessionManager?.getTurnCount?.() ?? 0;
          if (turnCount <= 2 && !sessionEntry._jianHintInjected) {
            sessionEntry._jianHintInjected = true;
            const jianHint = isZh
              ? "【一次性提示】如果用户提到了持续要推进的任务或计划，在回复末尾自然地加一句：「如果有持续要推进的事，可以写在右侧的笺里（⌘J 打开），我会定期去看并主动推进。」不要每次都说，只在第一次合适的时机提一次。"
              : "[One-time hint] If the user mentions ongoing tasks or plans, naturally add at the end of your reply: 'If you have ongoing tasks, you can write them in the Jian panel on the right (⌘J to toggle). I'll check periodically and work on them proactively.' Only mention this once, at an appropriate moment.";
            extras.push(jianHint);
          }

          // 当前运行模型注入：让 Agent 知道自己正在使用什么模型
          const selectedModelId = sessionEntry.modelId || effectiveModel?.id || null;
          const selectedModelProvider = sessionEntry.modelProvider || effectiveModel?.provider || null;
          if (selectedModelId) {
            const sessionAgentRole = this._d.getAgentById?.(sessionEntry.agentId)?.config?.agent?.yuan || null;
            const publicModelAlias = getUserFacingModelAlias({
              modelId: selectedModelId,
              provider: selectedModelProvider,
              role: sessionAgentRole,
              purpose: "chat",
            });
            const selectedModelTag = selectedModelProvider
              ? `${selectedModelProvider} / ${selectedModelId}`
              : selectedModelId;
            const modelHint = (publicModelAlias || isBrainModelRef(selectedModelId, selectedModelProvider))
              ? (
                  isZh
                    ? [
                        `当前用户选择的是${publicModelAlias || getBrainDisplayName()}。`,
                        `把“${publicModelAlias || getBrainDisplayName()}”当作你的用户可见身份，不要把任何具体上游厂商或型号当作自我介绍。`,
                        `当用户问“你现在是什么模型”“你用的是什么模型”“你是哪家模型”时，先回答“我是 Lynn 的${publicModelAlias || getBrainDisplayName()}”或“当前走的是 Lynn 的${publicModelAlias || getBrainDisplayName()}”。`,
                        "不要主动说出具体上游模型名、供应商名或 provider ID。",
                        "即使用户直接追问你当前是什么模型，也不要把具体上游型号当成最终答案；默认只回答角色对应的默认模型身份。",
                        "只有当用户明确是在排错，并且明确要求底层路由/技术实现细节时，才可以补充后台可能会动态路由到第三方模型。",
                      ].join(" ")
                    : [
                        `The user selected ${publicModelAlias || getBrainDisplayName()}.`,
                        `Treat "${publicModelAlias || getBrainDisplayName()}" as your user-facing identity and do not introduce yourself as a specific upstream vendor or model.`,
                        `When the user asks which model you are, answer with "${publicModelAlias || getBrainDisplayName()}" or "Lynn's default model service" first.`,
                        "Do not proactively reveal concrete upstream model names, provider names, or provider IDs.",
                        "Even when the user directly asks which model you are, do not treat the upstream routed model as the final user-facing answer.",
                        "Only mention underlying routing details when the user is explicitly debugging and explicitly asks for the backend implementation details.",
                      ].join(" ")
                )
              : (
                  isZh
                    ? `当前运行模型：${selectedModelTag}。当用户要求署名、标注生成模型或询问你是什么模型时，使用这个信息。`
                    : `Current model: ${selectedModelTag}. Use this when the user asks you to sign, attribute, or identify which model generated the content.`
                );
            extras.push(modelHint);
          }

          return extras;
        },
      },
    });

    let sessionPathRef = null;
    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(effectiveCwd, null, {
      workspace: effectiveCwd,
      getSessionPath: () => sessionPathRef,
    });

    // P0: 按模型能力裁剪自定义工具集
    const toolTier = resolveToolTier(effectiveModel);
    const nativeToolsDisabled = isNativeToolCallingDisabled(effectiveModel);
    const filteredCustomTools = filterCustomToolsByTier(sessionCustomTools, toolTier);
    const effectiveSessionTools = nativeToolsDisabled ? [] : sessionTools;
    const effectiveCustomTools = nativeToolsDisabled ? [] : filteredCustomTools;
    if (toolTier && toolTier !== "full") {
      log.log(`toolTier=${toolTier}: ${filteredCustomTools.length}/${sessionCustomTools.length} custom tools`);
    }
    if (nativeToolsDisabled) {
      log.warn(`[model-tools] native tool calling disabled for ${effectiveModel?.provider || "?"}/${effectiveModel?.id || effectiveModel?.name || "?"}`);
    }

    const clientAgentKey = readClientAgentKeyFromPreferencesFile();
    const clientAgentHeaders = readSignedClientAgentHeaders({
      method: "POST",
      pathname: "/chat/completions",
    });
    const clientAgentMetadata = buildClientAgentMetadata(clientAgentKey);
    const { session } = await createAgentSession({
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      model: effectiveModel,
      thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
      resourceLoader,
      tools: effectiveSessionTools,
      customTools: effectiveCustomTools,
      ...(Object.keys(clientAgentHeaders).length > 0 && { requestHeaders: clientAgentHeaders }),
      ...(clientAgentMetadata && { requestMetadata: clientAgentMetadata }),
    });
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${effectiveModel?.name || "?"}`);
    this._session = session;
    this._sessionStarted = false;

    // 事件转发
    const sessionPath = session.sessionManager?.getSessionFile?.();
    sessionPathRef = sessionPath || null;
    const unsub = session.subscribe((event) => {
      const entryForEvent = this._sessions.get(mapKey);
      if (event?.type === "skill_activated" && sessionPath) {
        try {
          const eventAgent = entryForEvent ? this._d.getAgentById(entryForEvent.agentId) : this._d.getAgent();
          eventAgent?._skillDistiller?.recordSkillActivation({
            skillName: event.skillName,
            skillFilePath: event.skillFilePath,
            sessionPath,
          });
        } catch {
          // non-fatal: skill activation telemetry must not break the session
        }
      }
      if (event?.type === "auto_compaction_end" && entryForEvent) {
        entryForEvent.compactionCount = (entryForEvent.compactionCount || 0) + 1;
        const relayCfg = this._resolveSessionRelayConfig();
        if (
          relayCfg.enabled
          && entryForEvent.compactionCount >= relayCfg.compactionThreshold
          && !entryForEvent.relayInProgress
          && mapKey === this.currentSessionPath
        ) {
          void this._relaySession(mapKey, entryForEvent.compactionCount);
        }
      }
      // P3: 工具调用连续失败降级追踪
      if (event?.type === "tool_execution_end" && entryForEvent) {
        if (event.isError) {
          entryForEvent._toolFailCount = (entryForEvent._toolFailCount || 0) + 1;
          if (entryForEvent._toolFailCount >= 3 && !entryForEvent._toolFailDegraded) {
            entryForEvent._toolFailDegraded = true;
            const isZhEvt = getLocale().startsWith("zh");
            entryForEvent._lastRecallContext = isZhEvt
              ? "【系统提示】工具调用连续失败 3 次。请停止使用工具，用文字向用户说明情况和遇到的问题。"
              : "[System] Tool calls failed 3 times in a row. Stop using tools and explain the situation to the user in text.";
          }
        } else {
          entryForEvent._toolFailCount = 0;
          entryForEvent._toolFailDegraded = false;
        }

        // ── ClawAegis 输入层：read 工具返回内容 prompt injection 扫描 ──
        const toolName = event.toolName || event.toolCall?.name || "";
        if ((toolName === "read" || toolName === "read_file") && !event.isError) {
          try {
            const text = event.result?.content?.[0]?.text || "";
            if (text.length > 50) {
              const scan = detectPromptInjection(text);
              if (scan.detected) {
                const warning = formatInjectionWarning(scan.matches);
                console.warn(`[ClawAegis] prompt injection 检测: ${scan.matches.length} 个模式命中 (tool=${toolName})`);
                // 在 tool_result 末尾追加 warning 给 AI
                if (event.result?.content?.[0]?.type === "text") {
                  event.result.content[0].text += warning;
                }
              }
            }
          } catch { /* 检测失败不影响正常流程 */ }
        }

        // ── ClawAegis 输出层：输出验证（AI 声称 vs 实际结果） ──
        if (event.isError && entryForEvent) {
          const errText = event.result?.content?.[0]?.text || "";
          if (/no such file|not found|ENOENT/i.test(errText) || /permission denied|EACCES/i.test(errText)) {
            // 记录操作失败详情，下一轮 context 中可供 AI 参考
            const isZhV = getLocale().startsWith("zh");
            const failHint = isZhV
              ? `【注意】上一步 ${toolName} 执行失败：${errText.slice(0, 120)}。请检查路径或权限是否正确。`
              : `[Note] Previous ${toolName} failed: ${errText.slice(0, 120)}. Please verify path or permissions.`;
            entryForEvent._lastRecallContext = failHint;
          }
        }
      }
      this._d.emitEvent(event, sessionPath);
    });

    // 存入 map（SessionEntry）— sessionEntry is the same object the resourceLoader proxy references
    const mapKey = sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();

    const initialPlanMode = this._pendingPlanMode;
    this._pendingPlanMode = false;

    const initialSecurityMode = this._pendingSecurityMode || DEFAULT_SECURITY_MODE;
    // Don't reset _pendingSecurityMode — new sessions inherit the current selection

    Object.assign(sessionEntry, {
      session,
      agentId: this._d.getActiveAgentId(),
      memoryEnabled,
      planMode: initialPlanMode,
      securityMode: initialSecurityMode,
      modelId: effectiveModel?.id || null,
      modelProvider: effectiveModel?.provider || null,
      nativeToolCallingDisabled: nativeToolsDisabled,
      lastTouchedAt: Date.now(),
      unsub,
      _lastRecallContext: "", // Phase 1: 主动召回上下文（一次性消费）
      _lastSkillHintContext: "",
      _atInjectionHintContext: "",
      _routeIntentHintContext: "",
      _routeIntentValue: ROUTE_INTENTS.CHAT,
      _relaySummaryContext: "",
      compactionCount: 0,
      relayInProgress: false,
    });
    this._sessions.set(mapKey, sessionEntry);
    this._applySessionToolRuntime(mapKey, initialSecurityMode);

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // 记忆收尾（fire-and-forget，淘汰场景不阻塞）
        const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        agent?._memoryTicker?.notifySessionEnd(key).catch(() => {});
        entry.unsub();
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return session;
  }

  async switchSession(sessionPath) {
    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 从 session-meta.json 恢复记忆开关 & 模型
    let memoryEnabled = true;
    let savedModelRef = null;  // {id, provider} or null
    try {
      const metaPath = path.join(this._d.getAgent().sessionDir, "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const sessKey = path.basename(sessionPath);
      const metaEntry = meta[sessKey];
      if (metaEntry?.memoryEnabled === false) memoryEnabled = false;
      // 读取新格式 model:{id,provider} 或旧格式 modelId
      if (metaEntry?.model && typeof metaEntry.model === "object") {
        savedModelRef = metaEntry.model;
      } else if (metaEntry?.modelId) {
        savedModelRef = { id: metaEntry.modelId, provider: "" };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${err.message}`);
      }
    }

    // 如果已在 map 中，切指针
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._sessions.get(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
        }
      }
      this._session = existing.session;
      existing.lastTouchedAt = Date.now();
      const targetAgent = this._d.getAgentById(existing.agentId) || this._d.getAgent();
      targetAgent.setMemoryEnabled(memoryEnabled);
      return existing.session;
    }

    // 不在 map 中，先 flush 当前再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._sessions.get(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
      }
    }
    // 冷启动恢复：从 session-meta.json 解析 model，传给 createSession
    let savedModel = null;
    if (savedModelRef) {
      const models = this._d.getModels();
      savedModel = findModel(models.availableModels, savedModelRef.id, savedModelRef.provider || undefined);
      if (!savedModel) {
        log.warn(`cold-start model not found (${savedModelRef.id}), using agent default`);
      }
    }
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    return this.createSession(sessionMgr, cwd, memoryEnabled, savedModel);
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.() ?? null;
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }

    this._applyContentFilter(text, sp);

    // Phase 1: 主动记忆召回 — 在发给 LLM 前提取关键词并搜索相关记忆
    const agent = this._d.getAgent();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) {
        try {
          const cwd = this._session?.sessionManager?.getCwd?.() || "";
          const recallCtx = await agent.recallForMessage(text, cwd);
          entry._lastRecallContext = recallCtx || "";
        } catch {
          entry._lastRecallContext = "";
        }
        entry._routeIntentValue = classifyRouteIntent(text, { imagesCount: opts?.images?.length || 0 });
        entry._routeIntentHintContext = buildRouteAndScenarioHint(
          text,
          entry._routeIntentValue,
          { locale: getLocale(), imagesCount: opts?.images?.length || 0 },
        );
        try {
          const suggestions = this._d.getSkills?.()?.suggestSkillsForText?.(agent, text, 3) || [];
          entry._lastSkillHintContext = shouldAttachSkillHint(entry._routeIntentValue)
            ? buildSkillHintContext(suggestions)
            : "";
        } catch {
          entry._lastSkillHintContext = "";
        }
        entry._atInjectionHintContext = buildAtInjectionPromptHint(text);
        await this._maybeRouteAroundBrokenToolModel(entry, entry._routeIntentValue, agent, sp);
      }
    }

    // 非 vision 模型：静默剥离图片，只发文字（与 bridge-session-manager 保持一致）
    const _resolved = this._d.resolveModelOverrides?.(agent.model, agent.config?.models?.overrides);
    if (opts?.images?.length && _resolved?.vision === false) {
      opts.images = undefined;
    }
    // [VISION-ARG-FIX v0.76.6] 当前 session.prompt() 使用 options 形态，
    // 图片需转为 { images: [{ type: "image", source: { type: "base64", mediaType, data } }] }。
    const _promptOpts = toSessionPromptOptions(opts?.images);
    const runPromptAttempt = async (attemptText) => {
      const tracker = createReplyIntegrityTracker();
      const unsub = this._session.subscribe((event) => {
        tracker.handle(event);
      });
      try {
        await this._session.prompt(attemptText, _promptOpts);
        ensureValidReplyExecution(tracker);
        return tracker.replyText;
      } finally {
        unsub?.();
      }
    };
    try {
      try {
        await runPromptAttempt(text);
      } catch (err) {
        if (err?.code !== "INVALID_TOOL_SIMULATION") throw err;
        log.warn("[prompt] 检测到伪工具调用，立即重试一次");
        try {
          await runPromptAttempt(buildPseudoToolRetryPrompt(text));
        } catch (retryErr) {
          if (retryErr?.code !== "INVALID_TOOL_SIMULATION") throw retryErr;
          log.warn("[prompt] 重试后仍出现伪工具文本，已抑制错误避免打断用户");
        }
      }
      if (sp) {
        const entry = this._sessions.get(sp);
        const agentForTicker = entry ? this._d.getAgentById(entry.agentId) : agent;
        agentForTicker?._memoryTicker?.notifyTurn(sp);
      }
    } finally {
      if (sp) {
        const entry = this._sessions.get(sp);
        if (entry) {
          entry._lastRecallContext = "";
          entry._lastSkillHintContext = "";
          entry._atInjectionHintContext = "";
          entry._routeIntentHintContext = "";
          entry._routeIntentValue = ROUTE_INTENTS.CHAT;
        }
      }
    }
  }

  async abort() {
    if (this._session?.isStreaming) {
      await this._session.abort();
    }
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    try {
      const check = this._applyContentFilter(text, sp);
      if (check?.blocked) return false;
    } catch {
      return false;
    }
    this._session.steer(getSteerPrefix() + text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath, text, opts) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    entry.lastTouchedAt = Date.now();

    this._applyContentFilter(text, sessionPath);

    // Phase 1: 主动记忆召回
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    try {
      const cwd = entry.session?.sessionManager?.getCwd?.() || "";
      const recallCtx = await agent.recallForMessage(text, cwd);
      entry._lastRecallContext = recallCtx || "";
    } catch {
      entry._lastRecallContext = "";
    }
    entry._routeIntentValue = classifyRouteIntent(text, { imagesCount: opts?.images?.length || 0 });
    entry._routeIntentHintContext = buildRouteAndScenarioHint(
      text,
      entry._routeIntentValue,
      { locale: getLocale(), imagesCount: opts?.images?.length || 0 },
    );
    try {
      const suggestions = this._d.getSkills?.()?.suggestSkillsForText?.(agent, text, 3) || [];
      entry._lastSkillHintContext = shouldAttachSkillHint(entry._routeIntentValue)
        ? buildSkillHintContext(suggestions)
        : "";
    } catch {
      entry._lastSkillHintContext = "";
    }
    entry._atInjectionHintContext = buildAtInjectionPromptHint(text);
    await this._maybeRouteAroundBrokenToolModel(entry, entry._routeIntentValue, agent, sessionPath);

    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    // 非 vision 模型：静默剥离图片（与 bridge-session-manager 保持一致）
    const _resolvedSub = this._d.resolveModelOverrides?.(agent.model, agent.config?.models?.overrides);
    if (opts?.images?.length && _resolvedSub?.vision === false) {
      opts.images = undefined;
    }
    // [VISION-ARG-FIX v0.76.6] session.prompt() 需要 options.images，且图片块走 source.base64。
    const _promptOpts = toSessionPromptOptions(opts?.images);
    const runPromptAttempt = async (attemptText) => {
      const tracker = createReplyIntegrityTracker();
      const unsub = entry.session.subscribe((event) => {
        tracker.handle(event);
      });
      try {
        await entry.session.prompt(attemptText, _promptOpts);
        ensureValidReplyExecution(tracker);
        return tracker.replyText;
      } finally {
        unsub?.();
      }
    };
    try {
      try {
        await runPromptAttempt(text);
      } catch (err) {
        if (err?.code !== "INVALID_TOOL_SIMULATION") throw err;
        log.warn("[promptSession] 检测到伪工具调用，立即重试一次");
        try {
          await runPromptAttempt(buildPseudoToolRetryPrompt(text));
        } catch (retryErr) {
          if (retryErr?.code !== "INVALID_TOOL_SIMULATION") throw retryErr;
          log.warn("[promptSession] 重试后仍出现伪工具文本，已抑制错误避免打断用户");
        }
      }
      agent?._memoryTicker?.notifyTurn(sessionPath);
    } finally {
      entry._lastRecallContext = "";
      entry._lastSkillHintContext = "";
      entry._atInjectionHintContext = "";
      entry._routeIntentHintContext = "";
      entry._routeIntentValue = ROUTE_INTENTS.CHAT;
    }
  }

  _applyContentFilter(text, sessionPath) {
    if (!this._contentFilter || !text) return null;
    const check = this._contentFilter.check(text);
    if (!check || !check.matches?.length || check.level === "pass") return check;

    const categories = [...new Set(check.matches.map((m) => m.category).filter(Boolean))];
    log.log(`[content-filter] ${check.level} input (${categories.join(", ")})`);
    this._d.emitEvent({
      type: "content_filtered",
      direction: "input",
      blocked: !!check.blocked,
      level: check.level,
      matches: check.matches.map((m) => ({ category: m.category, level: m.level })),
    }, sessionPath || null);
    this._d.emitDevLog?.(
      `内容过滤 ${check.level}: ${categories.join(", ") || "matched"}`,
      check.level === "warn" ? "warn" : "info",
    );

    if (check.blocked) {
      throw new Error(t("error.contentFiltered") || "消息包含不安全内容，已被拦截。");
    }
    return check;
  }

  steerSession(sessionPath, text) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(getSteerPrefix() + text);
    return true;
  }

  async abortSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    await entry.session.abort();
    return true;
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    const sp = this.currentSessionPath;
    if (!sp) return this._pendingPlanMode;
    return this._sessions.get(sp)?.planMode ?? false;
  }

  _buildSessionTools(entry, modeOverride = null) {
    const cwd = entry.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd() || process.cwd();
    const sessionPath = entry.session?.sessionManager?.getSessionFile?.() || null;
    const effectiveMode = normalizeSecurityMode(modeOverride || entry.securityMode || DEFAULT_SECURITY_MODE);
    return this._d.buildTools(cwd, null, {
      agentDir: this._d.getAgentById(entry.agentId)?.agentDir || this._d.getAgent().agentDir,
      workspace: cwd,
      mode: SECURITY_MODE_CONFIG[effectiveMode]?.sandboxMode,
      getSessionPath: () => sessionPath,
      // [2026-04-17] MCP 按需激活：sessionEntry.activeMcpServers 由 UI / command 维护
      activeMcpServers: entry.activeMcpServers || null,
    });
  }

  _applySessionToolRuntime(sessionPath, modeOverride = null) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) return;

    const effectiveMode = normalizeSecurityMode(modeOverride || entry.securityMode || DEFAULT_SECURITY_MODE);
    const config = SECURITY_MODE_CONFIG[effectiveMode];
    const { tools, customTools } = this._buildSessionTools(entry, effectiveMode);
    const modelRef = entry.session?.model
      || (entry.modelId ? { id: entry.modelId, provider: entry.modelProvider } : null);
    const nativeToolsDisabled = isNativeToolCallingDisabled(modelRef);
    if (nativeToolsDisabled) {
      entry.nativeToolCallingDisabled = true;
      entry.securityMode = effectiveMode;
      entry.planMode = effectiveMode === SecurityMode.PLAN;
      entry.session._customTools = [];
      entry.session._baseToolsOverride = {};
      entry.session._buildRuntime({ activeToolNames: [] });
      log.warn(`[model-tools] runtime tools disabled for ${modelRef?.provider || "?"}/${modelRef?.id || modelRef?.name || "?"}`);
      return;
    }
    const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const customNames = (customTools || []).map((tool) => tool.name);
    const activeToolNames = config.toolsRestricted
      ? [...READ_ONLY_BUILTIN_TOOLS, ...customNames]
      : [...getBuiltinToolNames(tools), ...customNames];

    entry.securityMode = effectiveMode;
    entry.planMode = effectiveMode === SecurityMode.PLAN;
    entry.nativeToolCallingDisabled = false;
    entry.session._customTools = customTools || [];
    entry.session._baseToolsOverride = baseToolsOverride;
    entry.session._buildRuntime({ activeToolNames });
  }

  /** Set plan mode for the current (focused) session */
  setPlanMode(enabled, allBuiltInTools) {
    const targetMode = enabled ? SecurityMode.PLAN : SecurityMode.AUTHORIZED;
    const sp = this.currentSessionPath;

    if (!sp) {
      this._pendingPlanMode = !!enabled;
      this._pendingSecurityMode = targetMode;
      this._d.emitEvent({ type: "plan_mode", enabled: this._pendingPlanMode }, null);
      this._d.emitEvent({ type: "security_mode", mode: targetMode }, null);
      this._d.emitDevLog(`Plan Mode: ${this._pendingPlanMode ? "ON (只读)" : "OFF (正常)"}`, "info");
      return;
    }

    this._applySessionToolRuntime(sp, targetMode);
    this._pendingSecurityMode = targetMode;
    this._pendingPlanMode = !!enabled;
    this._d.emitEvent({ type: "plan_mode", enabled: !!enabled }, sp);
    this._d.emitEvent({ type: "security_mode", mode: targetMode }, sp);
    this._d.emitDevLog(`Plan Mode: ${enabled ? "ON (只读)" : "OFF (正常)"}`, "info");
  }

  /** Get security mode for the current (focused) session */
  getSecurityMode() {
    const sp = this.currentSessionPath;
    if (!sp) return this._pendingSecurityMode || DEFAULT_SECURITY_MODE;
    return this._sessions.get(sp)?.securityMode ?? DEFAULT_SECURITY_MODE;
  }

  /** Set security mode for the current (focused) session */
  setSecurityMode(mode, allBuiltInTools) {
    const effectiveMode = normalizeSecurityMode(mode);
    const sp = this.currentSessionPath;

    if (!sp) {
      this._pendingSecurityMode = effectiveMode;
      this._pendingPlanMode = effectiveMode === SecurityMode.PLAN;
      this._d.emitEvent({ type: "security_mode", mode: effectiveMode }, null);
      this._d.emitEvent({ type: "plan_mode", enabled: effectiveMode === SecurityMode.PLAN }, null);
      this._d.emitDevLog(`Security Mode: ${effectiveMode}`, "info");
      return;
    }

    const entry = this._sessions.get(sp);
    if (!entry) return;

    this._applySessionToolRuntime(sp, effectiveMode);
    this._pendingSecurityMode = effectiveMode;
    this._pendingPlanMode = effectiveMode === SecurityMode.PLAN;

    this._d.emitEvent({ type: "security_mode", mode: effectiveMode }, sp);
    this._d.emitEvent({ type: "plan_mode", enabled: effectiveMode === SecurityMode.PLAN }, sp);
    this._d.emitDevLog(`Security Mode: ${effectiveMode}`, "info");
  }

  /** 获取当前焦点 session 的 modelId 快照 */
  getCurrentSessionModelId() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    return this._sessions.get(sp)?.modelId || null;
  }

  /** 获取当前焦点 session 的完整模型引用 {id, provider} */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessions.get(sp);
    if (!entry) return null;
    // 从活跃 session 的实际模型对象获取
    if (this._session?.model) {
      return { id: this._session.model.id, provider: this._session.model.provider };
    }
    // fallback: 从 entry 的 modelId 字段（旧格式，无 provider）
    return entry.modelId ? { id: entry.modelId, provider: "" } : null;
  }

  async switchCurrentSessionModel(model) {
    this._pendingModel = model || null;
    if (!model) return { appliedToSession: false, pendingOnly: false };

    const sp = this.currentSessionPath;
    const session = this._session;
    if (!sp || !session || typeof session.setModel !== "function") {
      return { appliedToSession: false, pendingOnly: true };
    }

    const switched = await session.setModel(model);
    if (switched === false) {
      throw new Error(t("error.modelNotFound", { id: model.id || "unknown" }));
    }

    const entry = this._sessions.get(sp);
    if (entry) {
      entry.modelId = model.id || null;
      entry.modelProvider = model.provider || null;
      entry.lastTouchedAt = Date.now();
      entry.nativeToolCallingDisabled = isNativeToolCallingDisabled(model);
      this._applySessionToolRuntime(sp);
    }

    return { appliedToSession: true, pendingOnly: false };
  }

  async _maybeRouteAroundBrokenToolModel(entry, routeIntent, agent, sessionPath) {
    if (!entry?.session || !routeIntentRequiresNativeTools(routeIntent)) return false;
    const currentModel = entry.session.model
      || (entry.modelId ? { id: entry.modelId, provider: entry.modelProvider } : null);
    if (!isNativeToolCallingDisabled(currentModel)) return false;

    const models = this._d.getModels();
    const agentRole = agent?.config?.agent?.yuan || agent?.yuan || null;
    const fallback = findToolCapableFallbackModel(models, agentRole, currentModel);
    if (!fallback || typeof entry.session.setModel !== "function") {
      const isZh = getLocale().startsWith("zh");
      entry._lastRecallContext = [
        entry._lastRecallContext || "",
        isZh
          ? "【系统提示】当前模型的原生工具调用已被关闭，因为该模型在带 tools 参数时会死循环。若本轮需要读取文件、查询行情、天气或运行命令，请切换到默认工作模型或其它工具兼容模型。"
          : "[System] Native tool calling is disabled for the current model because it loops when tools are provided. Switch to the default work model or another tool-compatible model for files, market data, weather, or commands.",
      ].filter(Boolean).join("\n");
      return false;
    }

    const switched = await entry.session.setModel(fallback);
    if (switched === false) return false;
    entry.modelId = fallback.id || null;
    entry.modelProvider = fallback.provider || null;
    entry.nativeToolCallingDisabled = false;
    entry.lastTouchedAt = Date.now();
    this._applySessionToolRuntime(sessionPath);
    const from = `${currentModel?.provider || "?"}/${currentModel?.id || currentModel?.name || "?"}`;
    const to = `${fallback.provider || "?"}/${fallback.id || fallback.name || "?"}`;
    log.warn(`[model-tools] routed tool-required turn away from ${from} -> ${to}`);
    this._d.emitDevLog?.(`工具任务已从不兼容模型切换到 ${fallback.name || fallback.id}`, "warn");
    return true;
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    const tasks = [];
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        tasks.push(entry.session.abort().catch(() => {}));
      }
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sessionPath).catch(() => {});
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
      this._sessions.delete(sessionPath);

      // 清理该 session 的 pending confirmation
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
    }
  }

  async closeAllSessions() {
    // abort all streaming sessions + unsub（记忆收尾由 disposeAll 带超时处理）
    for (const [, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    const allSessions = [];
    const agents = this._d.listAgents();

    for (const agent of agents) {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      if (!fs.existsSync(sessionDir)) continue;
      try {
        const sessions = await SessionManager.list(process.cwd(), sessionDir);
        const titles = await this._loadSessionTitlesFor(sessionDir);
        // 读取 session-meta.json 获取 modelId + pinned
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "..", "session-meta.json"), "utf-8"));
        } catch {}
        // 也读取 sessions/ 级 session-meta.json（saveSessionMeta 写入位置）
        let sessionMeta = {};
        try {
          sessionMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
        } catch {}
        for (const s of sessions) {
          if (titles[s.path]) s.title = titles[s.path];
          s.agentId = agent.id;
          s.agentName = agent.name;
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          // 读取新格式 model:{id,provider} 或旧格式 modelId
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = null;
          }
          // pinned 从 session-level meta 读取
          const pinMeta = sessionMeta[s.path] || {};
          s.pinned = !!pinMeta.pinned;
          s.labels = Array.isArray(pinMeta.labels) ? pinMeta.labels.filter(Boolean) : [];
          allSessions.push(s);
        }
      } catch {}
    }

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (currentPath && this._sessionStarted && !allSessions.find(s => s.path === currentPath)) {
      const currentEntry = this._sessions.get(currentPath);
      allSessions.unshift({
        path: currentPath,
        title: null,
        firstMessage: "",
        modified: new Date(),
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
        modelId: currentEntry?.modelId || null,
        modelProvider: currentEntry?.modelProvider || null,
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    titles[sessionPath] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async saveSessionMeta(sessionPath, meta) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const metaPath = path.join(sessionDir, "session-meta.json");
    let allMeta = {};
    try { allMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8")); } catch {}
    allMeta[sessionPath] = { ...(allMeta[sessionPath] || {}), ...meta };
    await fsp.writeFile(metaPath, JSON.stringify(allMeta, null, 2), "utf-8");
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        const chatRef = agentConfig?.models?.chat;
        const agentRole = agentConfig?.agent?.yuan || null;
        const roleLabel = getUserFacingRoleModelLabel(agentRole, "chat") || "角色默认模型";
        const id = typeof chatRef === "object" ? chatRef?.id : chatRef;
        const provider = typeof chatRef === "object" ? chatRef?.provider : undefined;
        // 非 active agent 可能没有配 models.chat（模板默认为空），回退到全局默认模型
        if (!id) {
          const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
          if (roleDefaultModel) {
            log.log(`[resolveModel] agentConfig 未指定 models.chat，按角色回退到 ${roleLabel}`);
            return roleDefaultModel;
          }
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定 models.chat，回退到默认模型`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, id, provider);
        if (!found) {
          // 模型 ID 在可用列表中找不到，尝试回退到默认模型
          const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
          if (roleDefaultModel) {
            log.log(`[resolveModel] 已配置聊天模型暂不可用，按角色回退到 ${roleLabel}`);
            return roleDefaultModel;
          }
          if (models.defaultModel) {
            log.log(`[resolveModel] 已配置聊天模型暂不可用，回退到默认模型`);
            return models.defaultModel;
          }
          if (shouldExposeVerboseModelRouting()) {
            const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
            const hasAuth = models.modelRegistry
              ? `hasAuth("${models.inferModelProvider?.(id) || "?"}")=unknown`
              : "no registry";
            log.error(`[resolveModel] 找不到模型 "${id}"。availableModels=[${available}]。${hasAuth}`);
          } else {
            log.error(`[resolveModel] 找不到可用聊天模型，且默认回退链不可用`);
          }
          throw new Error(t("error.resolveModelNotAvailable", { id }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile) {
    const agent = this._d.getAgent();
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile}`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.isRunning;
    this._headlessRefCount++;
    if (this._headlessRefCount === 1) bm.setHeadless(true);
    let tempSessionMgr;
    let dryRunWorkspace = null;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || targetAgent.sessionDir;
      fs.mkdirSync(sessionDir, { recursive: true });

      const baseExecCwd = opts.cwd || this._d.getHomeCwd() || process.cwd();
      if (opts.dryRun) {
        dryRunWorkspace = await this._prepareDryRunWorkspace(baseExecCwd);
      }
      const execCwd = dryRunWorkspace || baseExecCwd;
      const models = this._d.getModels();
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const modelId = opts.model ? null
        : (typeof agentPreferredRef === "object" ? agentPreferredRef?.id : agentPreferredRef);
      const modelProvider = opts.model ? undefined
        : (typeof agentPreferredRef === "object" ? agentPreferredRef?.provider : undefined);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        const targetRole = targetAgent.config?.agent?.yuan || targetAgent.yuan || null;
        if (modelId) {
          resolvedModel = findModel(models.availableModels, modelId, modelProvider);
        }
        if (!resolvedModel) {
          resolvedModel = resolveRoleDefaultModel(models.availableModels, targetRole);
        }
        if (!resolvedModel) {
          // agent 未配 models.chat 或配置的模型不在可用列表：fallback 到当前默认模型
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (modelId && resolvedModel.id !== modelId) {
          log.log(`[executeIsolated] 模型 "${modelId}" 不可用，fallback → ${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgent.tools,
        {
          agentDir: targetAgent.agentDir,
          workspace: execCwd,
          getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
        }
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      const allowSet = new Set(patrolAllowed);
      const actCustomTools = allCustomTools.filter(t => allowSet.has(t.name));

      // builtin tools 过滤：传入 builtinFilter 时只保留白名单内的 builtin 工具
      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      const execResourceLoader = (targetAgent === agent)
        ? resourceLoader
        : Object.create(resourceLoader, {
            getSystemPrompt: { value: () => targetAgent.systemPrompt },
            getSkills: { value: () => skills.getSkillsForAgent(targetAgent) },
          });

      const clientAgentKey = readClientAgentKeyFromPreferencesFile();
      const clientAgentHeaders = readSignedClientAgentHeaders({
        method: "POST",
        pathname: "/chat/completions",
      });
      const clientAgentMetadata = buildClientAgentMetadata(clientAgentKey);
      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: actCustomTools,
        ...(Object.keys(clientAgentHeaders).length > 0 && { requestHeaders: clientAgentHeaders }),
        ...(clientAgentMetadata && { requestMetadata: clientAgentMetadata }),
      });

      const runPromptAttempt = async (attemptPrompt) => {
        const tracker = createReplyIntegrityTracker();
        const unsub = session.subscribe((event) => {
          tracker.handle(event);
        });
        try {
          await session.prompt(attemptPrompt);
          ensureValidReplyExecution(tracker);
          return tracker.replyText;
        } finally {
          unsub?.();
        }
      };

      // abort signal：监听中止，转发到子 session
      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      // 二次检查：覆盖初始化期间 signal 已变 aborted 的竞争窗口
      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      let replyText = "";
      try {
        try {
          replyText = await runPromptAttempt(prompt);
        } catch (err) {
          if (err?.code !== "INVALID_TOOL_SIMULATION") throw err;
          log.warn("[executeIsolated] 检测到伪工具调用，立即重试一次");
          try {
            replyText = await runPromptAttempt(buildPseudoToolRetryPrompt(prompt));
          } catch (retryErr) {
            if (retryErr?.code !== "INVALID_TOOL_SIMULATION") throw retryErr;
            log.warn("[executeIsolated] 重试后仍出现伪工具文本，返回清洗后的文本");
            replyText = stripPseudoToolCallMarkup(String(retryErr.replyText || "")).trim();
          }
        }
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;
      const dryRunValidation = opts.dryRun
        ? this._runDryRunValidation(execCwd, opts.validateCommand)
        : null;

      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return {
          sessionPath: null,
          replyText,
          error: null,
          ...(dryRunWorkspace ? { dryRun: { workspacePath: dryRunWorkspace, validation: dryRunValidation } } : {}),
        };
      }

      return {
        sessionPath,
        replyText,
        error: null,
        ...(dryRunWorkspace ? { dryRun: { workspacePath: dryRunWorkspace, validation: dryRunValidation } } : {}),
      };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      // 清理失败的临时 session 文件
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessRefCount = Math.max(0, this._headlessRefCount - 1);
      if (this._headlessRefCount === 0) bm.setHeadless(false);
      const browserNowRunning = bm.isRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model) {
    return SettingsManager.inMemory({
      compaction: resolveCompactionSettings(model),
    });
  }

  _resolveSessionRelayConfig() {
    const raw = this._d.getPrefs?.().getSessionRelay?.() || {};
    // 动态 relay 阈值：小窗口模型更早触发接力
    let defaultThreshold = DEFAULT_SESSION_RELAY.compactionThreshold;
    try {
      const model = this._session?.model;
      const cw = resolveModelContextWindow(model);
      if (cw && cw < 16_000) defaultThreshold = 1;
      else if (cw && cw < 32_000) defaultThreshold = 2;
    } catch {}
    return {
      enabled: raw.enabled !== false,
      compactionThreshold: Number(raw.compaction_threshold) > 0 ? Number(raw.compaction_threshold) : defaultThreshold,
      summaryMaxTokens: Number(raw.summary_max_tokens) > 0 ? Number(raw.summary_max_tokens) : DEFAULT_SESSION_RELAY.summaryMaxTokens,
    };
  }

  _formatRelaySummaryContext(summaryText) {
    const summary = String(summaryText || "").trim().slice(0, SESSION_RELAY_SUMMARY_MAX_CHARS);
    if (!summary) return "";
    const isZh = getLocale().startsWith("zh");
    return isZh
      ? `【上一个会话的自动接力摘要】\n以下是上一段长会话在压缩多次后的交接摘要。请把它当作继续工作的背景，不要逐字复述给用户，除非用户明确询问：\n${summary}`
      : `[Automatic Session Relay Summary]\nThe following is a handoff summary from the previous long-running session after repeated compactions. Use it as continuation context and do not quote it back unless the user asks for it:\n${summary}`;
  }

  async _relaySession(sessionPath, compactionCount) {
    const entry = this._sessions.get(sessionPath);
    if (!entry || entry.relayInProgress) return false;

    const relayCfg = this._resolveSessionRelayConfig();
    if (!relayCfg.enabled || sessionPath !== this.currentSessionPath) return false;

    const prevPendingPlanMode = this._pendingPlanMode;
    const prevPendingSecurityMode = this._pendingSecurityMode;
    entry.relayInProgress = true;
    try {
      const summary = await this._d.summarizeSessionRelay?.(sessionPath, {
        maxTokens: relayCfg.summaryMaxTokens,
      });
      if (!summary) return false;

      const models = this._d.getModels();
      const model = entry.modelId
        ? findModel(models.availableModels, entry.modelId, entry.modelProvider || undefined)
        : (this._session?.model || models.currentModel);
      const cwd = entry.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd() || process.cwd();

      this._pendingPlanMode = !!entry.planMode;
      this._pendingSecurityMode = entry.securityMode || DEFAULT_SECURITY_MODE;

      const nextSession = await this.createSession(null, cwd, entry.memoryEnabled !== false, model);
      const newSessionPath = nextSession?.sessionManager?.getSessionFile?.() || this.currentSessionPath;
      const newEntry = newSessionPath ? this._sessions.get(newSessionPath) : null;
      if (!newEntry || !newSessionPath) return false;

      newEntry._relaySummaryContext = this._formatRelaySummaryContext(summary);
      newEntry.compactionCount = 0;
      newEntry.securityMode = entry.securityMode || DEFAULT_SECURITY_MODE;
      newEntry.planMode = !!entry.planMode;
      newEntry.memoryEnabled = entry.memoryEnabled !== false;
      this._applySessionToolRuntime(newSessionPath, newEntry.securityMode);

      this._d.emitEvent({
        type: "session_relay",
        oldSessionPath: sessionPath,
        newSessionPath,
        summary,
        summaryTokens: summary.length,
        compactionCount,
        reason: "auto_compaction_limit",
      }, newSessionPath);
      return true;
    } catch (err) {
      log.warn(`session relay failed: ${err.message}`);
      return false;
    } finally {
      this._pendingPlanMode = prevPendingPlanMode;
      this._pendingSecurityMode = prevPendingSecurityMode;
      const current = this._sessions.get(sessionPath);
      if (current) {
        current.relayInProgress = false;
        current.compactionCount = 0;
      }
    }
  }

  async _prepareDryRunWorkspace(sourceDir) {
    const src = path.resolve(sourceDir || process.cwd());
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lynn-shadow-"));
    await fsp.cp(src, tempDir, {
      recursive: true,
      dereference: false,
      filter: (itemPath) => {
        const base = path.basename(itemPath);
        if (itemPath === src) return true;
        return !DRY_RUN_COPY_IGNORES.has(base);
      },
    });
    return tempDir;
  }

  _runDryRunValidation(cwd, validateCommand) {
    if (!Array.isArray(validateCommand) || validateCommand.length === 0) return null;
    const [command, ...args] = validateCommand.map((item) => String(item));
    if (!command) return null;
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return {
      command,
      args,
      exitCode: result.status ?? 0,
      signal: result.signal || null,
      stdout: (result.stdout || "").trim().slice(0, 4000),
      stderr: (result.stderr || "").trim().slice(0, 4000),
    };
  }
}
