/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { t, getLocale } from "../server/i18n.js";
import { findModel } from "../shared/model-ref.js";
import { runReadToolPromptInjectionGuardrail } from "./claw-aegis-guardrails.js";
import {
  SecurityMode,
  DEFAULT_SECURITY_MODE,
  normalizeSecurityMode,
} from "../shared/security-mode.js";
import {
  buildClientAgentMetadata,
  readClientAgentKeyFromPreferencesFile,
  readSignedClientAgentHeaders,
} from "./client-agent-identity.js";
import { resolveCompactionSettings } from "./compaction-settings.js";
import { getUserFacingRoleModelLabel, resolveRoleDefaultModel } from "../shared/assistant-role-models.js";
import {
  classifyRouteIntent,
  ROUTE_INTENTS,
} from "../shared/task-route-intent.js";
import {
  isNativeToolCallingDisabled,
} from "../shared/model-tool-capabilities.js";
import {
  buildAtInjectionPromptHint,
  buildRouteAndScenarioHint,
  buildScenarioHintContext,
  buildSkillHintContext,
  getSteerPrefix,
  shouldAttachSkillHint,
  toSessionPromptOptions,
} from "./session-context-hints.js";
import {
  createReplyIntegrityTracker,
  ensureValidReplyExecution,
  sanitizeActiveSessionContextForPrompt,
} from "./session-prompt-sanitizer.js";
import {
  applySessionToolRuntime,
  buildSessionToolsForEntry,
  filterCustomToolsByTier,
  normalizeCustomToolsForModel,
  resolveToolTier,
  shouldSuppressClientToolSchema,
} from "./session-tool-runtime.js";
import {
  MAX_CACHED_SESSIONS,
  evictSessionCacheEntries,
  listCoordinatorSessions,
  refreshMissingSessionIndexes,
} from "./session-list-cache.js";
import {
  formatRelaySummaryContext,
  resolveSessionRelayConfig,
  runSessionRelay,
} from "./session-relay.js";
import { promoteActivitySessionFile } from "./session-activity.js";
import {
  loadSessionTitlesFor,
  saveSessionMetaFile,
  saveSessionTitleFile,
  type SessionTitleCacheEntry,
} from "./session-title-meta.js";
import {
  prepareDryRunWorkspace,
  runDryRunValidation,
} from "./session-dry-run.js";
import {
  prepareIsolatedToolRuntime,
  resolveIsolatedExecutionModel,
} from "./session-isolated-runtime.js";
import { createSessionResourceLoader } from "./session-resource-loader.js";
import type { ResolvedModel } from "./types.js";

export { PATROL_TOOLS_DEFAULT } from "./session-isolated-runtime.js";

const log = createModuleLogger("session");

type AnyRecord = Record<string, any>;
type ToolLike = AnyRecord & { name: string };
type AgentLike = AnyRecord;
type SessionLike = AnyRecord;
type ModelLike = ResolvedModel | AnyRecord | null;
type PromptImage = { data: string; mimeType?: string };
type PromptOptions = AnyRecord & {
  images?: PromptImage[];
  turnInstruction?: string;
  disableTools?: boolean;
};
type SessionEntry = AnyRecord & {
  session: SessionLike;
  agentId: string;
  memoryEnabled?: boolean;
  planMode?: boolean;
  securityMode?: string;
  modelId?: string | null;
  modelProvider?: string | null;
  nativeToolCallingDisabled?: boolean;
  lastTouchedAt: number;
  unsub: () => void;
  activeMcpServers?: string[] | null;
  compactionCount?: number;
  relayInProgress?: boolean;
};
type SessionCoordinatorDeps = AnyRecord & {
  agentsDir: string;
  getAgent: () => AgentLike;
  getActiveAgentId: () => string;
  getModels: () => AnyRecord;
  getResourceLoader: () => AnyRecord;
  getSkills?: () => AnyRecord | null;
  buildTools: (cwd: string, customTools?: unknown, opts?: AnyRecord) => { tools: ToolLike[]; customTools: ToolLike[] };
  emitEvent: (event: AnyRecord, sessionPath: string | null | undefined) => void;
  emitDevLog?: (message: string, level?: string) => void;
  getHomeCwd: () => string | null | undefined;
  agentIdFromSessionPath: (sessionPath: string) => string | null | undefined;
  switchAgentOnly: (id: string) => Promise<unknown>;
  getConfig: () => AnyRecord;
  getPrefs: () => AnyRecord;
  getAgents: () => Map<string, AgentLike>;
  getActivityStore: (agentId: string) => AnyRecord | null;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  listAgents: () => AgentLike[];
};
type IsolatedExecutionOptions = AnyRecord & {
  agentId?: string;
  signal?: AbortSignal;
  persist?: string;
  cwd?: string;
  dryRun?: boolean;
  model?: ModelLike;
  toolFilter?: string[];
  builtinFilter?: string[];
  validateCommand?: unknown[];
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function warnMemoryNotifySessionEnd(context: string, sessionPath: string | null | undefined, err: unknown) {
  const message = errMessage(err);
  log.warn(`memory notifySessionEnd failed during ${context} · session=${sessionPath} · ${message}`);
}

function notifyMemorySessionEnd(agent: AgentLike | null | undefined, sessionPath: string, context: string) {
  const promise = agent?._memoryTicker?.notifySessionEnd(sessionPath);
  if (!promise?.catch) return promise;
  return promise.catch((err: unknown) => warnMemoryNotifySessionEnd(context, sessionPath, err));
}

function shouldExposeVerboseModelRouting() {
  const flag = String(process?.env?.LYNN_DEBUG_MODELS || process?.env?.DEBUG_MODEL_ROUTING || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || process?.env?.NODE_ENV === "development";
}

export class SessionCoordinator {
  _d: SessionCoordinatorDeps;
  _pendingModel: ModelLike;
  _session: SessionLike | null;
  _sessionStarted: boolean;
  _sessions: Map<string, SessionEntry>;
  _headlessRefCount: number;
  _titlesCache: Map<string, SessionTitleCacheEntry>;
  _pendingPlanMode: boolean;
  _pendingSecurityMode: string;
  _contentFilter?: AnyRecord | null;

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
  constructor(deps: SessionCoordinatorDeps) {
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

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model: ModelLike) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr: AnyRecord | null = null, cwd?: string | null, memoryEnabled = true, model: ModelLike = null) {
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
    const sessionEntry = {} as SessionEntry; // populated after session creation; resourceLoader proxy references this

    const resourceLoader = createSessionResourceLoader({
      baseResourceLoader,
      sessionEntry,
      effectiveModel,
      getAgent: () => this._d.getAgent(),
      getAgentById: (agentId) => this._d.getAgentById?.(agentId),
      getHomeCwd: () => this._d.getHomeCwd(),
      getMcpPromptContext: () => this._d.getMcpPromptContext?.(),
    });

    let sessionPathRef: string | null = null;
    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(effectiveCwd, null, {
      workspace: effectiveCwd,
      getSessionPath: () => sessionPathRef,
    });

    // P0: 按模型能力裁剪自定义工具集
    const toolTier = resolveToolTier(effectiveModel);
    const nativeToolsDisabled = isNativeToolCallingDisabled(effectiveModel);
    const suppressClientTools = shouldSuppressClientToolSchema(effectiveModel);
    const filteredCustomTools = filterCustomToolsByTier(sessionCustomTools, toolTier);
    const effectiveSessionTools = (nativeToolsDisabled || suppressClientTools) ? [] : sessionTools;
    const effectiveCustomTools = (nativeToolsDisabled || suppressClientTools) ? [] : normalizeCustomToolsForModel(filteredCustomTools, effectiveModel);
    if (toolTier && toolTier !== "full") {
      log.log(`toolTier=${toolTier}: ${filteredCustomTools.length}/${sessionCustomTools.length} custom tools`);
    }
    if (nativeToolsDisabled) {
      log.warn(`[model-tools] native tool calling disabled for ${effectiveModel?.provider || "?"}/${effectiveModel?.id || effectiveModel?.name || "?"}`);
    }
    if (suppressClientTools) {
      log.log(`[model-tools] using Brain V2 internal tool chain for ${effectiveModel?.provider || "?"}/${effectiveModel?.id || effectiveModel?.name || "?"}; client tool schema suppressed`);
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
      thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel(), effectiveModel),
      resourceLoader,
      tools: effectiveSessionTools,
      customTools: effectiveCustomTools,
      ...(Object.keys(clientAgentHeaders).length > 0 && { requestHeaders: clientAgentHeaders }),
      ...(clientAgentMetadata && { requestMetadata: clientAgentMetadata }),
    } as any);
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${effectiveModel?.name || "?"}`);
    this._session = session;
    this._sessionStarted = false;

    // 事件转发
    const sessionPath = session.sessionManager?.getSessionFile?.();
    sessionPathRef = sessionPath || null;
    const unsub = session.subscribe((event: AnyRecord) => {
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
      // 工具失败只记录事件本身，不再向后续上下文注入“停止使用工具”等
      // 指令。模型是否继续调用工具应由模型和真实工具结果决定。
      if (event?.type === "tool_execution_end" && entryForEvent) {
        entryForEvent._toolFailCount = Boolean(event.isError || event.result?.isError)
          ? (entryForEvent._toolFailCount || 0) + 1
          : 0;
        entryForEvent._toolFailDegraded = false;

        // ── ClawAegis 输入层：read 工具返回内容 prompt injection 扫描 ──
        const toolIsError = Boolean(event.isError || event.result?.isError);
        const toolName = event.toolName || event.toolCall?.name || "";
        runReadToolPromptInjectionGuardrail(event, {
          logger: (message) => console.warn(message),
        });

        // ── ClawAegis 输出层：输出验证（AI 声称 vs 实际结果） ──
        if (toolIsError && entryForEvent) {
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
      _scenarioContractHintContext: "",
      _routeIntentValue: ROUTE_INTENTS.CHAT,
      _relaySummaryContext: "",
      compactionCount: 0,
      relayInProgress: false,
    });
    this._sessions.set(mapKey, sessionEntry);
    this._applySessionToolRuntime(mapKey, initialSecurityMode);

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    evictSessionCacheEntries({
      sessions: this._sessions,
      currentKey: mapKey,
      focusPath: this.currentSessionPath,
      maxSessions: MAX_CACHED_SESSIONS,
      getAgentById: (agentId) => this._d.getAgentById(agentId),
      getFallbackAgent: () => this._d.getAgent(),
      notifySessionEnd: notifyMemorySessionEnd,
    });

    return session;
  }

  async switchSession(sessionPath: string) {
    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 从 session-meta.json 恢复记忆开关 & 模型
    let memoryEnabled = true;
    let savedModelRef: { id: string; provider?: string } | null = null;  // {id, provider} or null
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${errMessage(err)}`);
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
          await notifyMemorySessionEnd(oldAgent, oldSp, "session switch");
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
        await notifyMemorySessionEnd(oldAgent, oldSp, "cold session switch");
      }
    }
    // 冷启动恢复：从 session-meta.json 解析 model，传给 createSession
    let savedModel: ModelLike = null;
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

  async prompt(text: string, opts: PromptOptions = {}) {
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
        entry._scenarioContractHintContext = buildScenarioHintContext(
          text,
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
        entry._turnInstructionHintContext = String(opts?.turnInstruction || "").trim();
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
    sanitizeActiveSessionContextForPrompt(this._session, sp);
    const runPromptAttempt = async (attemptText: string) => {
      const tracker = createReplyIntegrityTracker();
      const activeSession = this._session;
      if (!activeSession) throw new Error(t("error.noActiveSessionPrompt"));
      const unsub = activeSession.subscribe((event: AnyRecord) => {
        tracker.handle(event);
      });
      try {
        await activeSession.prompt(attemptText, _promptOpts);
        ensureValidReplyExecution(tracker);
        return tracker.replyText;
      } finally {
        unsub?.();
      }
    };
    try {
      const entry = sp ? this._sessions.get(sp) : null;
      if (opts?.disableTools && entry) {
        await this._runWithTurnToolsDisabled(sp, entry, () => runPromptAttempt(text));
      } else {
        await runPromptAttempt(text);
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
          entry._turnInstructionHintContext = "";
          entry._routeIntentHintContext = "";
          entry._scenarioContractHintContext = "";
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

  steer(text: string) {
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

  async promptSession(sessionPath: string, text: string, opts: PromptOptions = {}) {
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
    entry._scenarioContractHintContext = buildScenarioHintContext(
      text,
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
    entry._turnInstructionHintContext = String(opts?.turnInstruction || "").trim();
    await this._maybeRouteAroundBrokenToolModel(entry, entry._routeIntentValue, agent, sessionPath);

    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    // 非 vision 模型：静默剥离图片（与 bridge-session-manager 保持一致）
    const _resolvedSub = this._d.resolveModelOverrides?.(agent.model, agent.config?.models?.overrides);
    if (opts?.images?.length && _resolvedSub?.vision === false) {
      opts.images = undefined;
    }
    // [VISION-ARG-FIX v0.76.6] session.prompt() 需要 options.images，且图片块走 source.base64。
    const _promptOpts = toSessionPromptOptions(opts?.images);
    sanitizeActiveSessionContextForPrompt(entry.session, sessionPath);
    const runPromptAttempt = async (attemptText: string) => {
      const tracker = createReplyIntegrityTracker();
      const unsub = entry.session.subscribe((event: AnyRecord) => {
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
      if (opts?.disableTools) {
        await this._runWithTurnToolsDisabled(sessionPath, entry, () => runPromptAttempt(text));
      } else {
        await runPromptAttempt(text);
      }
      agent?._memoryTicker?.notifyTurn(sessionPath);
    } finally {
      entry._lastRecallContext = "";
      entry._lastSkillHintContext = "";
      entry._atInjectionHintContext = "";
      entry._turnInstructionHintContext = "";
      entry._routeIntentHintContext = "";
      entry._scenarioContractHintContext = "";
      entry._routeIntentValue = ROUTE_INTENTS.CHAT;
    }
  }

  async _runWithTurnToolsDisabled(sessionPath: string, entry: SessionEntry, run: () => Promise<unknown>) {
    const session = entry?.session;
    if (!session || typeof session._buildRuntime !== "function") {
      return run();
    }

    const previousCustomTools = session._customTools;
    const previousBaseToolsOverride = session._baseToolsOverride;
    try {
      session._customTools = [];
      session._baseToolsOverride = {};
      session._buildRuntime({ activeToolNames: [] });
      log.log(`[model-tools] disabled client tools for no-tool turn · ${sessionPath || "current"}`);
      return await run();
    } finally {
      session._customTools = previousCustomTools;
      session._baseToolsOverride = previousBaseToolsOverride;
      if (sessionPath && this._sessions.has(sessionPath)) {
        this._applySessionToolRuntime(sessionPath, entry.securityMode);
      } else {
        try {
          session._buildRuntime({ activeToolNames: [] });
        } catch {}
      }
    }
  }

  _applyContentFilter(text: string, sessionPath: string | null | undefined) {
    if (!this._contentFilter || !text) return null;
    const check = this._contentFilter.check(text);
    if (!check || !check.matches?.length || check.level === "pass") return check;

    const categories = [...new Set(check.matches.map((m: AnyRecord) => m.category).filter(Boolean))];
    log.log(`[content-filter] ${check.level} input (${categories.join(", ")})`);
    this._d.emitEvent({
      type: "content_filtered",
      direction: "input",
      blocked: !!check.blocked,
      level: check.level,
      matches: check.matches.map((m: AnyRecord) => ({ category: m.category, level: m.level })),
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

  steerSession(sessionPath: string, text: string) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(getSteerPrefix() + text);
    return true;
  }

  async abortSession(sessionPath: string) {
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

  _buildSessionTools(entry: SessionEntry, modeOverride: string | null = null) {
    return buildSessionToolsForEntry({
      entry,
      modeOverride,
      buildTools: (cwd, extra, options) => this._d.buildTools(cwd, extra, options),
      getHomeCwd: () => this._d.getHomeCwd(),
      getAgentById: (agentId) => agentId ? this._d.getAgentById(agentId) : null,
      getFallbackAgent: () => this._d.getAgent(),
    });
  }

  _applySessionToolRuntime(sessionPath: string, modeOverride: string | null = null) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) return;

    applySessionToolRuntime({
      entry,
      modeOverride,
      buildTools: (cwd, extra, options) => this._d.buildTools(cwd, extra, options),
      getHomeCwd: () => this._d.getHomeCwd(),
      getAgentById: (agentId) => agentId ? this._d.getAgentById(agentId) : null,
      getFallbackAgent: () => this._d.getAgent(),
      logger: log,
    });
  }

  /** Set plan mode for the current (focused) session */
  setPlanMode(enabled: boolean, allBuiltInTools?: ToolLike[]) {
    const targetMode = enabled ? SecurityMode.PLAN : SecurityMode.AUTHORIZED;
    const sp = this.currentSessionPath;

    if (!sp) {
      this._pendingPlanMode = !!enabled;
      this._pendingSecurityMode = targetMode;
      this._d.emitEvent({ type: "plan_mode", enabled: this._pendingPlanMode }, null);
      this._d.emitEvent({ type: "security_mode", mode: targetMode }, null);
      this._d.emitDevLog?.(`Plan Mode: ${this._pendingPlanMode ? "ON (只读)" : "OFF (正常)"}`, "info");
      return;
    }

    this._applySessionToolRuntime(sp, targetMode);
    this._pendingSecurityMode = targetMode;
    this._pendingPlanMode = !!enabled;
    this._d.emitEvent({ type: "plan_mode", enabled: !!enabled }, sp);
    this._d.emitEvent({ type: "security_mode", mode: targetMode }, sp);
    this._d.emitDevLog?.(`Plan Mode: ${enabled ? "ON (只读)" : "OFF (正常)"}`, "info");
  }

  /** Get security mode for the current (focused) session */
  getSecurityMode() {
    const sp = this.currentSessionPath;
    if (!sp) return this._pendingSecurityMode || DEFAULT_SECURITY_MODE;
    return this._sessions.get(sp)?.securityMode ?? DEFAULT_SECURITY_MODE;
  }

  /** Set security mode for the current (focused) session */
  setSecurityMode(mode: string, allBuiltInTools?: ToolLike[]) {
    const effectiveMode = normalizeSecurityMode(mode);
    const sp = this.currentSessionPath;

    if (!sp) {
      this._pendingSecurityMode = effectiveMode;
      this._pendingPlanMode = effectiveMode === SecurityMode.PLAN;
      this._d.emitEvent({ type: "security_mode", mode: effectiveMode }, null);
      this._d.emitEvent({ type: "plan_mode", enabled: effectiveMode === SecurityMode.PLAN }, null);
      this._d.emitDevLog?.(`Security Mode: ${effectiveMode}`, "info");
      return;
    }

    const entry = this._sessions.get(sp);
    if (!entry) return;

    this._applySessionToolRuntime(sp, effectiveMode);
    this._pendingSecurityMode = effectiveMode;
    this._pendingPlanMode = effectiveMode === SecurityMode.PLAN;

    this._d.emitEvent({ type: "security_mode", mode: effectiveMode }, sp);
    this._d.emitEvent({ type: "plan_mode", enabled: effectiveMode === SecurityMode.PLAN }, sp);
    this._d.emitDevLog?.(`Security Mode: ${effectiveMode}`, "info");
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

  async switchCurrentSessionModel(model: ResolvedModel | null) {
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

  async _maybeRouteAroundBrokenToolModel(entry: SessionEntry, routeIntent: string, agent: AgentLike, sessionPath: string) {
    return false;
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

  async closeSession(sessionPath: string) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      notifyMemorySessionEnd(agent, sessionPath, "close session");
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

  getSessionByPath(sessionPath: string) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath: string) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath: string) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    return listCoordinatorSessions({
      agentsDir: this._d.agentsDir,
      agents: this._d.listAgents(),
      currentPath: this.currentSessionPath,
      sessionStarted: this._sessionStarted,
      currentSession: this._session,
      currentEntry: this.currentSessionPath ? this._sessions.get(this.currentSessionPath) : null,
      activeAgentId: this._d.getActiveAgentId(),
      activeAgent: this._d.getAgent(),
      onIndexRefreshError: (agent, err) => {
        log.warn(`session index refresh failed · agent=${agent.id} · ${errMessage(err)}`);
      },
    });
  }

  async _refreshSessionIndexesInBackground() {
    await refreshMissingSessionIndexes({
      agentsDir: this._d.agentsDir,
      agents: this._d.listAgents(),
      onError: (agent, err) => {
        log.warn(`session index refresh skipped · agent=${agent.id} · ${errMessage(err)}`);
      },
    });
  }

  async saveSessionTitle(sessionPath: string, title: string) {
    await saveSessionTitleFile(sessionPath, title, {
      agentsDir: this._d.agentsDir,
      currentAgent: this._d.getAgent(),
      agentIdFromSessionPath: this._d.agentIdFromSessionPath,
      titlesCache: this._titlesCache,
    });
  }

  async saveSessionMeta(sessionPath: string, meta: AnyRecord) {
    await saveSessionMetaFile(sessionPath, meta, {
      agentsDir: this._d.agentsDir,
      currentAgent: this._d.getAgent(),
      agentIdFromSessionPath: this._d.agentIdFromSessionPath,
    });
  }

  async _loadSessionTitlesFor(sessionDir: string): Promise<Record<string, string>> {
    return loadSessionTitlesFor(sessionDir, this._titlesCache);
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills?.() || {};
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag: AgentLike) => skills.getSkillsForAgent?.(ag) || [],
      buildTools:     (cwd: string, customTools?: unknown, opts?: AnyRecord) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig: AnyRecord) => {
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
            const available = models.availableModels.map((m: AnyRecord) => `${m.provider}/${m.id}`).join(", ");
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

  promoteActivitySession(activitySessionFile: string) {
    return promoteActivitySessionFile(activitySessionFile, this._d.getAgent(), {
      onPromoted: () => log.log(`promoted activity session: ${activitySessionFile}`),
      onError: (err) => log.error(`promoteActivitySession failed: ${errMessage(err)}`),
    });
  }

  // ── Isolated Execution ──

  async executeIsolated(prompt: string, opts: IsolatedExecutionOptions = {}) {
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
    let tempSessionMgr: AnyRecord | null = null;
    let dryRunWorkspace: string | null = null;
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
      const resolved = resolveIsolatedExecutionModel({
        explicitModel: opts.model,
        targetAgent,
        availableModels: models.availableModels,
        defaultModel: models.defaultModel,
      });
      const resolvedModel = resolved.model;
      if (!resolvedModel) {
        log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，也没有可用的默认模型`);
        throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
      }
      if (resolved.usedFallback && resolved.requestedModelId) {
        log.log(`[executeIsolated] 模型 "${resolved.requestedModelId}" 不可用，fallback → ${resolvedModel.id}`);
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const isolatedTools = prepareIsolatedToolRuntime({
        execCwd,
        targetAgent,
        execModel,
        buildTools: this._d.buildTools,
        getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
        toolFilter: opts.toolFilter,
        builtinFilter: opts.builtinFilter,
      });
      if (isolatedTools.suppressClientTools) {
        log.log(`[executeIsolated] using Brain V2 internal tool chain for ${execModel?.provider || "?"}/${execModel?.id || execModel?.name || "?"}; client tool schema suppressed`);
      }

      const agent = this._d.getAgent();
      const skills = this._d.getSkills?.();
      const resourceLoader = this._d.getResourceLoader();
      const execResourceLoader = (targetAgent === agent)
        ? resourceLoader
        : Object.create(resourceLoader, {
            getSystemPrompt: { value: () => targetAgent.systemPrompt },
            getSkills: { value: () => skills?.getSkillsForAgent?.(targetAgent) || [] },
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
        thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel(), execModel),
        resourceLoader: execResourceLoader,
        tools: isolatedTools.tools,
        customTools: isolatedTools.customTools,
        ...(Object.keys(clientAgentHeaders).length > 0 && { requestHeaders: clientAgentHeaders }),
        ...(clientAgentMetadata && { requestMetadata: clientAgentMetadata }),
      } as any);

      const runPromptAttempt = async (attemptPrompt: string) => {
        const tracker = createReplyIntegrityTracker();
        const unsub = session.subscribe((event: AnyRecord) => {
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
        replyText = await runPromptAttempt(prompt);
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
      log.error(`isolated execution failed: ${errMessage(err)}`);
      // 清理失败的临时 session 文件
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: errMessage(err) };
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
  _createSettings(model: ModelLike) {
    return SettingsManager.inMemory({
      compaction: resolveCompactionSettings(model as any),
    });
  }

  _resolveSessionRelayConfig() {
    const raw = this._d.getPrefs?.().getSessionRelay?.() || {};
    return resolveSessionRelayConfig(raw, this._session?.model);
  }

  _formatRelaySummaryContext(summaryText: string) {
    return formatRelaySummaryContext(summaryText, getLocale());
  }

  async _relaySession(sessionPath: string, compactionCount: number) {
    const prevPendingPlanMode = this._pendingPlanMode;
    const prevPendingSecurityMode = this._pendingSecurityMode;
    return runSessionRelay({
      sessionPath,
      compactionCount,
      sessions: this._sessions,
      currentSessionPath: this.currentSessionPath,
      getCurrentSessionPath: () => this.currentSessionPath,
      relayConfig: this._resolveSessionRelayConfig(),
      defaultSecurityMode: DEFAULT_SECURITY_MODE,
      summarize: async (path, options) => (
        this._d.summarizeSessionRelay
          ? await this._d.summarizeSessionRelay(path, options)
          : null
      ),
      resolveModel: (entry) => {
        const models = this._d.getModels();
        return entry.modelId
          ? findModel(models.availableModels, entry.modelId, entry.modelProvider || undefined)
          : (this._session?.model || models.currentModel);
      },
      resolveCwd: (entry) => entry.session?.sessionManager?.getCwd?.() || this._d.getHomeCwd() || process.cwd(),
      createSession: async ({ entry, cwd, memoryEnabled, model }) => {
        this._pendingPlanMode = !!entry.planMode;
        this._pendingSecurityMode = entry.securityMode || DEFAULT_SECURITY_MODE;
        try {
          return await this.createSession(null, cwd, memoryEnabled, model as ModelLike);
        } finally {
          this._pendingPlanMode = prevPendingPlanMode;
          this._pendingSecurityMode = prevPendingSecurityMode;
        }
      },
      formatSummaryContext: (summary) => this._formatRelaySummaryContext(summary),
      applySessionToolRuntime: (path, mode) => this._applySessionToolRuntime(path, mode),
      emitEvent: (event, path) => this._d.emitEvent(event, path),
      onError: (err) => log.warn(`session relay failed: ${errMessage(err)}`),
    });
  }

  async _prepareDryRunWorkspace(sourceDir: string) {
    return prepareDryRunWorkspace(sourceDir);
  }

  _runDryRunValidation(cwd: string, validateCommand: unknown[] | undefined) {
    return runDryRunValidation(cwd, validateCommand);
  }
}
