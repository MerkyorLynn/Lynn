/**
 * HanaEngine — Lynn 的核心引擎（Thin Facade）
 *
 * 持有所有 Manager，对外暴露统一 API。
 * 具体逻辑委托给：
 *   - AgentManager       — agent CRUD / init / switch
 *   - SessionCoordinator — session 生命周期 / listing
 *   - ConfigCoordinator  — 配置读写 / 模型 / 搜索 / utility
 *   - ChannelManager     — 频道 CRUD / 成员管理
 *   - BridgeSessionManager — 外部平台 session
 *   - ModelManager        — 模型注册 / 发现
 *   - PreferencesManager  — 全局偏好
 *   - SkillManager        — 技能注册 / 同步
 */
import fs from "fs";
import os from "os";
import path from "path";
import { migrateConfigScope } from "../shared/migrate-config-scope.js";
import { migrateToProvidersYaml } from "./migrate-providers.js";
import { findModel } from "../shared/model-ref.js";
import {
  registerClientIdentityWithBrainApi,
  readSignedClientAgentHeaders,
} from "./client-agent-identity.js";
import { PluginManager } from "./plugin-manager.js";
import {
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { WELL_KNOWN_SKILL_PATHS, allBuiltInTools } from "./constants.js";

import { PreferencesManager } from "./preferences-manager.js";
import { ModelManager } from "./model-manager.js";
import { SkillManager } from "./skill-manager.js";
import { BridgeSessionManager } from "./bridge-session-manager.js";
import { AgentManager } from "./agent-manager.js";
import { SessionCoordinator } from "./session-coordinator.js";
import { ConfigCoordinator, SHARED_MODEL_KEYS } from "./config-coordinator.js";
import { ChannelManager } from "./channel-manager.js";
import { ExpertManager } from "./expert-manager.js";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
  summarizeSessionRelay as _summarizeSessionRelay,
} from "./llm-utils.js";
import { debugLog } from "../lib/debug-log.js";
import { createSandboxedTools } from "../lib/sandbox/index.js";
import { t } from "../server/i18n.js";
import {
  SECURITY_MODE_CONFIG,
  normalizeSecurityMode,
} from "../shared/security-mode.js";
import {
  BRAIN_PROVIDER_ID,
  BRAIN_API_ROOT,
  BRAIN_API_ROOTS,
  isDeprecatedBrainProviderBaseUrl,
  BRAIN_LEGACY_PROVIDER_BASE_URL,
  buildBrainProviderConfig,
  getBrainRegistrationToken,
} from "../shared/brain-provider.js";
import {
  resolveRoleDefaultModel,
  getUserFacingRoleModelLabel,
} from "../shared/assistant-role-models.js";
import { prewarmHttpConnection } from "../shared/http-pool.js";

function shouldExposeVerboseModelRouting() {
  const flag = String(process?.env?.LYNN_DEBUG_MODELS || process?.env?.DEBUG_MODEL_ROUTING || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || process?.env?.NODE_ENV === "development";
}

// ── P2a: Tool Guard Wrapper ──
// 给 customTool 的 execute 包一层参数校验：
// 1. 参数类型强制转换（"true"→true, "123"→123）
// 2. 必填参数缺失时返回友好的 tool_result 而不是崩溃
// 3. ClawAegis: 敏感路径检测（审计 + warning）

function coerceParam(value, schema) {
  if (value === undefined || value === null) return value;
  const type = schema?.type;
  if (!type) return value;
  if (type === "number" || type === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    return value;
  }
  return value;
}

// ── ClawAegis: 敏感路径/参数异常检测 ──

const SENSITIVE_PATH_PATTERNS = [
  [/\.ssh[/\\]/i, "SSH 密钥目录"],
  [/\.gnupg[/\\]/i, "GPG 密钥目录"],
  [/\.aws[/\\]credentials/i, "AWS 凭证文件"],
  [/\.env$/i, "环境变量文件"],
  [/\.env\.\w+$/i, "环境变量文件"],
  [/\.npmrc$/i, "npm token 文件"],
  [/\.pypirc$/i, "PyPI token 文件"],
  [/\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/i, "SSH 私钥文件"],
  [/\.kube[/\\]config/i, "Kubernetes 配置"],
  [/\.docker[/\\]config\.json/i, "Docker 凭证"],
  [/keychain|keystore|\.p12$|\.pfx$/i, "密钥库文件"],
  [/\.git[/\\]config$/i, "Git 配置（可能含 token）"],
  [/\/etc\/shadow/i, "系统密码文件"],
  [/\/etc\/passwd/i, "系统用户文件"],
];

function detectSensitiveParams(toolName, params) {
  if (!params) return null;
  const text = JSON.stringify(params);
  for (const [pattern, label] of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(text)) {
      return { label, toolName, matched: text.match(pattern)?.[0] };
    }
  }
  return null;
}

function wrapToolWithGuard(tool) {
  if (!tool?.execute || tool._guarded) return tool;
  const originalExecute = tool.execute;
  const schema = tool.parameters;

  const guardedExecute = async (toolCallId, params, ...rest) => {
    let fixedParams = params || {};

    // 类型强制转换
    if (schema?.properties && typeof fixedParams === "object") {
      const coerced = { ...fixedParams };
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in coerced) {
          coerced[key] = coerceParam(coerced[key], propSchema);
        }
      }
      fixedParams = coerced;
    }

    // 必填参数检查
    const required = schema?.required || [];
    const missing = required.filter(k => fixedParams[k] === undefined || fixedParams[k] === null);
    if (missing.length > 0) {
      return {
        content: [{ type: "text", text: `参数缺失 / Missing parameters: ${missing.join(", ")}。请补全后重试。` }],
      };
    }

    // ClawAegis: 敏感路径检测
    const sensitive = detectSensitiveParams(tool.name, fixedParams);
    if (sensitive) {
      console.warn(`[ClawAegis] 敏感路径检测: tool=${sensitive.toolName} target=${sensitive.label} match=${sensitive.matched}`);
      // 不阻断，但在结果前追加 warning
      const result = await originalExecute(toolCallId, fixedParams, ...rest);
      const warningText = `⚠️ 安全提示：检测到访问${sensitive.label}（${sensitive.matched}）。请确认这是用户明确要求的操作。如非必要，不要读取或传输此类文件内容。`;
      if (result?.content?.[0]?.type === "text") {
        result.content[0].text = warningText + "\n\n" + result.content[0].text;
      }
      return result;
    }

    return originalExecute(toolCallId, fixedParams, ...rest);
  };

  return { ...tool, execute: guardedExecute, _guarded: true };
}

// ── P2b: Tool Name Aliases ──
// 弱模型常见的工具名拼写错误 → 正确名映射
const TOOL_ALIASES = {
  "web-search": "web_search",
  "websearch": "web_search",
  "web-fetch": "web_fetch",
  "webfetch": "web_fetch",
  "search-memory": "search_memory",
  "searchmemory": "search_memory",
  "pin-memory": "pin_memory",
  "unpin-memory": "unpin_memory",
  "recall-experience": "recall_experience",
  "record-experience": "record_experience",
  "present-files": "present_files",
  "presentfiles": "present_files",
  "create-artifact": "create_artifact",
  "install-skill": "install_skill",
  "update-settings": "update_settings",
  "ask-agent": "ask_agent",
  "message-agent": "message_agent",
};

function createToolAliases(customTools) {
  const nameSet = new Set(customTools.map(t => t.name));
  const aliases = [];
  for (const tool of customTools) {
    // 为每个工具创建别名（如果别名不和已有工具名冲突）
    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      if (target === tool.name && !nameSet.has(alias)) {
        aliases.push({ ...tool, name: alias, _aliasOf: tool.name });
        nameSet.add(alias);
      }
    }
  }
  return aliases;
}

export class HanaEngine {
  /**
   * @param {object} dirs
   * @param {string} dirs.lynnHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   */
  constructor({ lynnHome, productDir, agentId }) {
    this.lynnHome = lynnHome;
    this.productDir = productDir;
    this.agentsDir = path.join(lynnHome, "agents");
    this.userDir = path.join(lynnHome, "user");
    this.channelsDir = path.join(lynnHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._prefs.ensureClientIdentity();
    this._models = new ModelManager({ lynnHome });

    // 确定启动时焦点 agent
    const startId = agentId || this._prefs.getPrimaryAgent() || this._prefs.findFirstAgent();
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hub,
      deleteAgent: (agentId) => this._agentMgr?.deleteAgent(agentId),
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hub,
      getSkills: () => this._skills,
      getSearchConfig: () => this.getSearchConfig(),
      resolveUtilityConfig: () => this.resolveUtilityConfig(),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Expert Manager ──
    this._expertMgr = new ExpertManager({
      presetsDir: path.join(productDir, "experts", "presets"),
      getAgentManager: () => this._agentMgr,
      getModelManager: () => this._models,
      getSkillManager: () => this._skills,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getMcpPromptContext: () => this._mcpManager?.getPromptContext?.() || "",
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getHomeCwd: () => this.homeCwd,
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      listAgents: () => this.listAgents(),
      getConfirmStore: () => this._confirmStore,
      summarizeSessionRelay: (sessionPath, opts) => this.summarizeSessionRelay(sessionPath, opts),
    });

    // Initialize security mode from saved preference
    const savedSecurityMode = this._prefs.getSecurityMode();
    if (savedSecurityMode) {
      this._sessionCoord._pendingSecurityMode = normalizeSecurityMode(savedSecurityMode);
    }

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      lynnHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getSessionCoordinator: () => this._sessionCoord,
      getHub: () => this._hub,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
    });

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, customTools, opts) => this.buildTools(cwd, customTools, opts),
      getHomeCwd: () => this.homeCwd,
      resolveModelOverrides: (model, overrides) => this.resolveModelOverrides(model, overrides),
    });

    // ── Plugin Manager ──
    this._pluginManager = null;  // initialized async in initPlugins()

    // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // 事件系统
    this._listeners = new Set();
    this._eventBus = null;

    // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;

    // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;
  }

  // ════════════════════════════
  //  Agent 代理（→ AgentManager）
  // ════════════════════════════

  get agent() { return this._agentMgr.agent; }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }

  emitSessionEvent(event) {
    this._emitEvent(event, this.currentSessionPath);
  }

  setConfirmStore(store) {
    this._confirmStore = store;
    if (store) {
      store.onResolved = (confirmId, action) => {
        this._emitEvent({ type: "confirmation_resolved", confirmId, action }, null);
      };
    }
  }

  // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents() { return this._agentMgr.listAgents(); }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async ensureAgentLoaded(agentId, log = () => {}) { return this._agentMgr.ensureAgentLoaded(agentId, log); }
  async switchAgent(agentId) { return this._agentMgr.switchAgent(agentId); }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  setPrimaryAgent(agentId) { return this._agentMgr.setPrimaryAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem) { return this._agentMgr.createSessionForAgent(agentId, cwd, mem); }

  // 向后兼容：agent 属性代理
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.agent.userName; }
  set userName(v) { this.agent.userName = v; }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
  //  Session 代理（→ SessionCoordinator）
  // ════════════════════════════

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem, model) { return this._sessionCoord.createSession(mgr, cwd, mem, model); }
  async switchSession(p) { return this._sessionCoord.switchSession(p); }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }
  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort() { return this._sessionCoord.abort(); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

  // ── Path 感知 API（Phase 2） ──
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p) { return this._sessionCoord.abortSession(p); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key) { return this._bridge?.isSessionStreaming(key) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  steerBridgeSession(key, text) { return this._bridge?.steerSession(key, text) ?? false; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  isSessionStreaming(p) { return this._sessionCoord.isSessionStreaming(p); }
  async abortSessionByPath(p) { return this._sessionCoord.abortSessionByPath(p); }
  async listSessions() { return this._sessionCoord.listSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  async saveSessionMeta(p, meta) { return this._sessionCoord.saveSessionMeta(p, meta); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  promoteActivitySession(f) { return this._sessionCoord.promoteActivitySession(f); }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
  //  Config 代理（→ ConfigCoordinator）
  // ════════════════════════════

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
  get currentModel() {
    return this._sessionCoord.session?.model
      ?? this._sessionCoord.pendingModel
      ?? this._models.currentModel;
  }
  get availableModels() { return this._models.availableModels; }
  get memoryEnabled() { return this.agent.memoryEnabled; }
  get memoryModelUnavailableReason() { return this.agent.memoryModelUnavailableReason; }
  get planMode() { return this._sessionCoord.getPlanMode(); }
  get securityMode() { return this._sessionCoord.getSecurityMode(); }
  get homeCwd() { return this._configCoord.getHomeFolder() || null; }
  get authStorage() { return this._models.authStorage; }
  get modelRegistry() { return this._models.modelRegistry; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }

  /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  /**
   * 返回应用了用户 override 的模型对象（浅拷贝）。
   * override 字段映射集中在此处：ov.context→contextWindow, ov.maxOutput→maxTokens。
   * 不处理 displayName（模型显示名有独立的解析链 resolveModelName）。
   * @param {object} model - Pi SDK 模型对象
   * @param {object} [overrides] - 可选，指定 override map。不传则用当前 focus agent 的 config。
   *   bridge session 需要传入对应 agent 的 overrides，因为 bridge session 可能不属于 focus agent。
   */
  resolveModelOverrides(model, overrides) {
    if (!model) return null;
    const ov = (overrides || this.config?.models?.overrides)?.[model.id];
    if (!ov) return model;
    return {
      ...model,
      vision: ov.vision !== undefined ? ov.vision : (model.vision || false),
      reasoning: ov.reasoning !== undefined ? ov.reasoning : (model.reasoning || false),
      contextWindow: ov.context || model.contextWindow || null,
      maxTokens: ov.maxOutput || model.maxTokens || null,
    };
  }

  getHomeFolder() { return this._configCoord.getHomeFolder(); }
  setHomeFolder(f) { return this._configCoord.setHomeFolder(f); }
  getTrustedRoots() { return this._configCoord.getTrustedRoots(); }
  setTrustedRoots(r) { return this._configCoord.setTrustedRoots(r); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  getSearchConfig() { return this._configCoord.getSearchConfig(); }
  setSearchConfig(p) { return this._configCoord.setSearchConfig(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig() { return this._configCoord.resolveUtilityConfig(); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh() { return this._configCoord.syncAndRefresh(); }
  setPendingModel(id, provider) { return this._configCoord.setPendingModel(id, provider); }
  setDefaultModel(id, provider) { return this._configCoord.setDefaultModel(id, provider); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getSandbox() { return this._prefs.getSandbox(); }
  setSandbox(v) { this._prefs.setSandbox(v); }
  getSecurityModePreference() { return this._prefs.getSecurityMode(); }
  setSecurityModePreference(v) { this._prefs.setSecurityMode(v); }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  setLocale(l) { this._prefs.setLocale(l); }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  getUpdateChannel() { return this._prefs.getUpdateChannel(); }
  setUpdateChannel(ch) { this._prefs.setUpdateChannel(ch); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistSessionMeta() { return this._configCoord.persistSessionMeta(); }
  setPlanMode(enabled) { return this._sessionCoord.setPlanMode(enabled, allBuiltInTools); }
  setSecurityMode(mode) {
    this._sessionCoord.setSecurityMode(mode, allBuiltInTools);
    // Persist default mode preference
    this._prefs.setSecurityMode(mode);
  }
  async updateConfig(p) { return this._configCoord.updateConfig(p); }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  // ════════════════════════════
  //  Channel 代理（→ ChannelManager）
  // ════════════════════════════

  createChannel(opts) { return this._channels.createChannel(opts); }
  deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  archiveChannelByName(n) { return this._channels.archiveChannelByName(n); }
  async triggerChannelTriage(n, o) { return this._channels.triggerChannelTriage(n, o); }

  // ════════════════════════════
  //  Expert 代理（→ ExpertManager）
  // ════════════════════════════

  get expertManager() { return this._expertMgr; }
  listExperts(locale) { return this._expertMgr.listExperts(locale); }
  getExpert(slug, locale) { return this._expertMgr.getExpert(slug, locale); }
  async spawnExpert(slug, opts) { return this._expertMgr.spawnExpert(slug, opts); }

  // ════════════════════════════
  //  Bridge 代理（→ BridgeSessionManager）
  // ════════════════════════════

  getBridgeIndex() { return this._bridge.readIndex(); }
  saveBridgeIndex(i) { return this._bridge.writeIndex(i); }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }

  // ════════════════════════════
  //  Skills（→ SkillManager）
  // ════════════════════════════

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
    const ag = agentId ? this._agentMgr.getAgent(agentId) : this.agent;
    return this._skills.getAllSkills(ag || this.agent);
  }
  _getSkillsForAgent(ag) { return this._skills.getSkillsForAgent(ag); }
  get skillsDir() { return this._skills.skillsDir; }
  get userSkillsDir() { return this._skills.skillsDir; }
  get learnedSkillsDir() { return path.join(this.agent.agentDir, "learned-skills"); }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

  /** 获取外部技能路径配置（供 API 使用） */
  getExternalSkillPaths() {
    // 刷新 exists 状态，检测运行期间新增的目录
    let newDirAppeared = false;
    for (const d of this._discoveredExternalPaths || []) {
      const nowExists = fs.existsSync(d.dirPath);
      if (nowExists && !d.exists) newDirAppeared = true;
      d.exists = nowExists;
    }
    // 运行期间有新目录出现：重新集成到 SkillManager（watcher + 扫描）
    if (newDirAppeared) {
      const merged = this._mergeExternalPaths(this._prefs.getExternalSkillPaths());
      this._skills.setExternalPaths(merged);
      this.reloadSkills().then(() => {
        this._emitEvent({ type: "skills-changed" }, null);
      }).catch(() => {});
    }
    return {
      configured: this._prefs.getExternalSkillPaths(),
      discovered: this._discoveredExternalPaths || [],
    };
  }

  /** 更新外部技能路径 + 同步 ResourceLoader + 重载 */
  async setExternalSkillPaths(paths) {
    this._prefs.setExternalSkillPaths(paths);
    const merged = this._mergeExternalPaths(paths);
    // 1. 更新 SkillManager（数据 + watcher，不 reload）
    this._skills.setExternalPaths(merged);
    // 2. 统一 reload（外部技能由 SkillManager 扫描，不走 ResourceLoader）
    await this.reloadSkills();
    // 3. 通知前端
    this._emitEvent({ type: "skills-changed" }, null);
  }

  /** 合并自动发现 + 用户配置的外部路径（去重） */
  _mergeExternalPaths(userConfiguredPaths) {
    // 每次合并时重新检测目录是否存在（不依赖初始化快照）
    for (const d of this._discoveredExternalPaths || []) {
      d.exists = fs.existsSync(d.dirPath);
    }
    const discovered = (this._discoveredExternalPaths || [])
      .filter(d => d.exists)
      .map(d => ({ dirPath: d.dirPath, label: d.label }));
    const userParsed = (userConfiguredPaths || []).map(p => ({
      dirPath: path.resolve(p),
      label: path.basename(path.dirname(p)),
    }));
    const merged = [...discovered];
    const seen = new Set(merged.map(m => m.dirPath));
    for (const up of userParsed) {
      if (!seen.has(up.dirPath)) {
        merged.push(up);
        seen.add(up.dirPath);
      }
    }
    return merged;
  }

  // ════════════════════════════
  //  Model 代理
  // ════════════════════════════

  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p); }
  resolveProviderCredentials(p) { return this._resolveProviderCredentials(p); }
  _inferModelProvider(id) { return this._models.inferModelProvider(id); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async init(log = () => {}) {
    const startupTimer = Date.now();

    // 0. Config scope 迁移（全局字段从 agent config → preferences）
    migrateConfigScope({
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      primaryAgentId: this._prefs.getPrimaryAgent(),
      log,
    });

    // 0b. Provider 迁移（旧数据 → added-models.yaml，只跑一次）
    migrateToProvidersYaml(this.lynnHome, this.agentsDir, log);

    // 0c. 默认 Brain provider：新老用户都保证存在一条免 Key 的免费模型链路
    try {
      const current = this._models.providerRegistry.getAllProvidersRaw()[BRAIN_PROVIDER_ID] || {};
      const seeded = buildBrainProviderConfig();
      const currentBaseUrl = current.base_url === BRAIN_LEGACY_PROVIDER_BASE_URL || isDeprecatedBrainProviderBaseUrl(current.base_url)
        ? seeded.base_url
        : current.base_url;
      const next = {
        ...current,
        display_name: current.display_name || seeded.display_name,
        base_url: currentBaseUrl || seeded.base_url,
        api: current.api || seeded.api,
        auth_type: current.auth_type || seeded.auth_type,
        models: Array.isArray(current.models) && current.models.length > 0 ? current.models : seeded.models,
      };
      const changed =
        current.display_name !== next.display_name
        || current.base_url !== next.base_url
        || current.api !== next.api
        || current.auth_type !== next.auth_type
        || JSON.stringify(current.models || []) !== JSON.stringify(next.models || []);
      if (changed) {
        this._models.providerRegistry.saveProvider(BRAIN_PROVIDER_ID, next);
        log("[init] seeded built-in Brain provider");
      }
      this._models.providerRegistry.reload();
    } catch (err) {
      log(`[init] seed Brain provider failed: ${err.message}`);
    }

    // 0d. 将本机 Lynn 身份注册到 Brain 服务，后续请求走签名头鉴权
    //     放到后台执行，避免弱网场景把启动卡住；失败不阻断启动。
    this._brainRegistered = false;
    this._brainRegistrationPending = true;
    const brainApiRoots = BRAIN_API_ROOTS.length > 0 ? BRAIN_API_ROOTS : [BRAIN_API_ROOT];
    this._brainRegistrationTask = (async () => {
      const { key, secret } = this._prefs.ensureClientIdentity();
      const registrationToken = getBrainRegistrationToken();
      let lastError = null;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const timeoutMs = attempt === 1 ? 5000 : 8000;
        for (const baseUrl of brainApiRoots) {
          try {
            await registerClientIdentityWithBrainApi({
              baseUrl,
              agentKey: key,
              secret,
              registrationToken,
              timeoutMs,
            });
            this._brainRegistered = true;
            log(`[init] Brain device registration ok (${baseUrl})`);
            return true;
          } catch (err) {
            lastError = err;
            log(`[init] Brain device registration attempt ${attempt} failed via ${baseUrl}: ${err.message}`);
          }
        }
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      log(`[init] Brain device registration skipped: ${lastError?.message || "unknown error"}`);
      return false;
    })()
      .catch((err) => {
        log(`[init] Brain device registration crashed: ${err.message}`);
        return false;
      })
      .finally(() => {
        this._brainRegistrationPending = false;
      });

    // 1. Pi SDK + 模型基础设施（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK 初始化...`);
    this._models.init();
    // 预填充 _availableModels，agent init 时需要解析 utility model
    await this._models.refreshAvailable();
    log(`[init] 1/5 AuthStorage + ModelRegistry + ${this._models.availableModels.length} 个模型就绪`);

    // 2. 初始化所有 agent
    log(`[init] 2/5 初始化所有 agent...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    log(`[init] 2/5 ${this._agentMgr.agents.size} 个 agent 已就绪`);

    // 2b. 确保所有 agent 都有 channels.md（老用户升级兼容）
    for (const [id] of this._agentMgr.agents) {
      const channelsMd = path.join(this.agentsDir, id, 'channels.md');
      if (!fs.existsSync(channelsMd)) {
        this._channels.setupChannelsForNewAgent(id);
      }
    }

    // 2c. 清理绑定到已不存在频道的孤儿专家
    const orphanedExperts = this._channels.listOrphanedChannelExperts();
    if (orphanedExperts.length > 0) {
      const orphanSet = new Set(orphanedExperts);
      if (orphanSet.has(this.currentAgentId)) {
        const fallbackId = [...this._agentMgr.agents.keys()].find((id) => !orphanSet.has(id));
        if (fallbackId) {
          await this._agentMgr.switchAgentOnly(fallbackId);
          log(`[init] 当前 agent 绑定频道已失效，已切换到 ${fallbackId}`);
        } else {
          orphanSet.delete(this.currentAgentId);
          log(`[init] 检测到当前 agent 是孤儿频道专家，但没有可切换的其他 agent，暂不删除`);
        }
      }

      let cleanedCount = 0;
      for (const agentId of orphanSet) {
        try {
          await this._agentMgr.deleteAgent(agentId);
          cleanedCount += 1;
        } catch (err) {
          log(`[init] 清理孤儿频道专家失败 (${agentId}): ${err.message}`);
        }
      }
      if (cleanedCount > 0) {
        log(`[init] 已清理 ${cleanedCount} 个孤儿频道专家`);
      }
    }

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader 初始化...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.lynnHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // 解析外部兼容技能路径
    const homeDir = os.homedir();
    this._discoveredExternalPaths = WELL_KNOWN_SKILL_PATHS.map(w => ({
      dirPath: path.join(homeDir, w.suffix),
      label: w.label,
      exists: fs.existsSync(path.join(homeDir, w.suffix)),
    }));
    const externalPaths = this._mergeExternalPaths(this._prefs.getExternalSkillPaths());

    this._skills = new SkillManager({ skillsDir, externalPaths });
    this._resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => this.agent.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    const extCount = this._skills.allSkills.filter(s => s.source === "external").length;
    log(`[init] 3/5 ResourceLoader 完成 (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills${extCount ? `, ${extCount} external` : ""})`);

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

    // 4. 模型发现
    log(`[init] 4/5 发现可用模型...`);
    try { await this.syncModelsAndRefresh(); } catch {}
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    if (shouldExposeVerboseModelRouting()) {
      log(`[init] 4/5 找到 ${availableModels.length} 个模型: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    } else {
      log(`[init] 4/5 找到 ${availableModels.length} 个可用模型`);
    }
    if (availableModels.length === 0) {
      console.warn("[engine] ⚠ 未找到可用模型，请在设置中配置 API key");
      this._models.defaultModel = null;
    } else {
      const activeRole = this.agent?.config?.agent?.yuan || null;
      const roleLabel = getUserFacingRoleModelLabel(activeRole, "chat") || "角色默认模型";
      const chatRef = this.agent.config.models?.chat;
      const preferredId = typeof chatRef === "object" ? chatRef?.id : chatRef;
      const preferredProvider = typeof chatRef === "object" ? chatRef?.provider : undefined;
      let model = null;
      if (preferredId) {
        model = findModel(availableModels, preferredId, preferredProvider);
        if (!model) {
          if (shouldExposeVerboseModelRouting()) {
            console.warn(`[engine] ⚠ 配置的模型 "${preferredId}" 不在可用列表中，尝试自动选择角色默认模型`);
          } else {
            console.warn(`[engine] ⚠ 已配置聊天模型暂不可用，尝试切换到${roleLabel}`);
          }
        }
      }
      if (!model) {
        model = resolveRoleDefaultModel(availableModels, activeRole);
      }
      // 自动回退：未配置 models.chat 或配置的模型不可用时，取第一个可用模型
      if (!model) {
        model = availableModels[0];
        console.log(`[engine] 自动选择${roleLabel}`);
      }
      this._models.defaultModel = model;
      log(`✿ 使用${roleLabel}`);
    }

    // 5. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch {}

    // 7a. MCP 服务器连接
    try {
      const { McpManager } = await import("../lib/mcp-client.js");
      this._mcpManager = new McpManager(this.lynnHome);
      await this._mcpManager.init();
      if (this._mcpManager.toolCount > 0) {
        log(`✿ MCP: ${this._mcpManager.serverCount} server(s), ${this._mcpManager.toolCount} tool(s)`);
      }
    } catch (err) {
      log(`[init] MCP init failed (non-fatal): ${err.message}`);
      this._mcpManager = null;
    }

    // 7a-1. Brain Provider 连接预热（降低首 Token 延迟）
    try {
      const brainBaseUrl = this.providerRegistry?.get(BRAIN_PROVIDER_ID)?.baseUrl;
      if (brainBaseUrl) {
        const prewarmUrl = `${String(brainBaseUrl).replace(/\/+$/, "")}/models`;
        const pathname = (() => {
          try { return new URL(prewarmUrl).pathname || "/models"; } catch { return "/models"; }
        })();
        const headers = readSignedClientAgentHeaders({
          method: "GET",
          pathname,
        });
        void prewarmHttpConnection(prewarmUrl, {
          method: "GET",
          headers,
          timeoutMs: 3000,
        }).catch((err) => {
          log(`[init] Brain prewarm skipped: ${err.message}`);
        });
      }
    } catch (err) {
      log(`[init] Brain prewarm skipped: ${err.message}`);
    }

    // 7b. 内容安全过滤器
    try {
      const { ContentFilter } = await import("../lib/content-filter.js");
      this._contentFilter = new ContentFilter();
      await this._contentFilter.init();
      // 注入到 SessionCoordinator
      this._sessionCoord._contentFilter = this._contentFilter;
      log(`✿ 内容过滤器已加载 (${this._contentFilter.stats.totalWords} 词)`);
    } catch (err) {
      log(`[init] content filter init failed (non-fatal): ${err.message}`);
      this._contentFilter = null;
    }

    // 8. 沙盒日志
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    log(`✿ 沙盒${sandboxEnabled ? "已启用" : "已关闭"}`);

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`✿ 初始化完成（${totalTime}s）`);
  }

  async dispose() {
    this._skills?.unwatch();
    await this._mcpManager?.dispose?.();
    await this._agentMgr.disposeAll(this._sessionCoord);
    await this._sessionCoord.cleanupSession();
  }

  // ════════════════════════════
  //  插件系统
  // ════════════════════════════

  /**
   * Initialize plugin system. Called after Hub construction (EventBus available).
   * @param {import('../hub/event-bus.js').EventBus} bus
   */
  async initPlugins(bus) {
    const builtinPluginsDir = path.join(this.productDir, "..", "plugins");
    const userPluginsDir = path.join(this.lynnHome, "plugins");
    const pluginDataDir = path.join(this.lynnHome, "plugin-data");

    this._pluginManager = new PluginManager({
      pluginsDirs: [builtinPluginsDir, userPluginsDir],
      dataDir: pluginDataDir,
      bus,
      engine: this,
    });
    this._pluginManager.scan();
    await this._pluginManager.loadAll();

    // Register plugin skill paths with SkillManager
    if (this._skills) {
      const existing = this._skills._externalPaths || [];
      const pluginPaths = this._pluginManager.getSkillPaths();
      this._skills.setExternalPaths([...existing, ...pluginPaths]);
    }
  }

  get pluginManager() { return this._pluginManager; }
  get mcpManager() { return this._mcpManager; }

  // [2026-04-17] MCP 按需激活 API (供 session-coordinator + UI 调用)
  activateMcpServer(sessionPath, serverName) {
    if (!this._sessionCoord) return false;
    const entry = this._sessionCoord._sessions?.get(sessionPath);
    if (!entry) return false;
    if (!entry.activeMcpServers) entry.activeMcpServers = new Set();
    entry.activeMcpServers.add(serverName);
    this._sessionCoord._applySessionToolRuntime?.(sessionPath);
    this._emitEvent({ type: 'mcp_activation_changed', sessionPath, serverName, active: true }, sessionPath);
    return true;
  }
  deactivateMcpServer(sessionPath, serverName) {
    if (!this._sessionCoord) return false;
    const entry = this._sessionCoord._sessions?.get(sessionPath);
    if (!entry?.activeMcpServers) return false;
    entry.activeMcpServers.delete(serverName);
    this._sessionCoord._applySessionToolRuntime?.(sessionPath);
    this._emitEvent({ type: 'mcp_activation_changed', sessionPath, serverName, active: false }, sessionPath);
    return true;
  }
  getSessionActiveMcp(sessionPath) {
    const entry = this._sessionCoord?._sessions?.get(sessionPath);
    return entry?.activeMcpServers ? [...entry.activeMcpServers] : [];
  }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  buildTools(cwd, customTools, opts = {}) {
    const ct = customTools || this.agent.tools;
    // Append plugin tools + MCP tools
    const pluginTools = this._pluginManager?.getAllTools() || [];

    // [2026-04-17] MCP 按需激活：默认不加载 MCP 工具，避免 tools 数量膨胀拖慢模型
    // 用户可在 session 里通过 activateMcpServer(name) 或 UI 开关激活
    const prefs = this._readPreferences?.() || {};
    const mcpAutoLoad = prefs.mcpAutoLoad === true; // default false
    const sessionActiveMcp = opts.activeMcpServers; // Set<string> | undefined
    let mcpTools = [];
    if (this._mcpManager) {
      if (sessionActiveMcp && sessionActiveMcp.size > 0) {
        // 仅 session 激活的 server 的工具
        mcpTools = (this._mcpManager.getTools() || []).filter(tool => {
          const m = (tool.name || '').match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
          return m && sessionActiveMcp.has(m[1]);
        });
      } else if (mcpAutoLoad) {
        // 全量加载（向后兼容：用户在 preferences 里显式开启）
        mcpTools = this._mcpManager.getTools() || [];
      }
      // else: default — 不加载 MCP 工具
    }

    const allTools = [...ct, ...pluginTools, ...mcpTools];

    const effectiveAgentDir = opts.agentDir || this.agent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined ? opts.workspace : this.homeCwd;
    const sandboxEnabled = this._readPreferences().sandbox !== false;

    // Derive sandbox mode from security mode
    let effectiveMode;
    if (opts.mode) {
      effectiveMode = opts.mode;
    } else if (!sandboxEnabled) {
      effectiveMode = "full-access";
    } else {
      // Use security mode config to determine sandbox behavior
      const secMode = this.securityMode;
      const secConfig = SECURITY_MODE_CONFIG[secMode];
      effectiveMode = secConfig ? secConfig.sandboxMode : "standard";
    }

    const result = createSandboxedTools(cwd, allTools, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      trustedRoots: this.getTrustedRoots(),
      lynnHome: this.lynnHome,
      mode: effectiveMode,
      confirmStore: this._confirmStore,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      getSessionPath: opts.getSessionPath,
    });

    // P2a: 给 customTools 包参数校验 Guard
    result.customTools = (result.customTools || []).map(wrapToolWithGuard);
    // P2b: 注册工具名别名（弱模型常见拼写错误兜底）
    const aliases = createToolAliases(result.customTools);
    if (aliases.length > 0) result.customTools = [...result.customTools, ...aliases];
    return result;
  }

  // ════════════════════════════
  //  事件系统
  // ════════════════════════════

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        try { fn(event, sessionPath); } catch {}
      }
    }
  }

  emitEvent(event, sessionPath) { this._emitEvent(event, sessionPath); }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
  //  日记 / 工具调用
  // ════════════════════════════

  async writeDiary() {
    const currentPath = this.currentSessionPath;
    if (currentPath && this.agent.memoryTicker) {
      await this.agent.memoryTicker.flushSession(currentPath);
    }
    const { writeDiary } = await import("../lib/diary/diary-writer.js");
    const diaryModelId = this.agent.config.models?.chat || this.agent.memoryModel;
    const resolvedModel = this._models.resolveModelWithCredentials(diaryModelId);
    return writeDiary({
      summaryManager: this.agent.summaryManager,
      resolvedModel,
      agentPersonality: this.agent.personality,
      memory: (() => {
        try { return fs.readFileSync(this.agent.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: this.agent.userName,
      agentName: this.agent.agentName,
      cwd: this.homeCwd || process.cwd(),
      activityStore: this.activityStore,
    });
  }

  async summarizeTitle(ut, at, opts) {
    return _summarizeTitle(this.resolveUtilityConfig(), ut, at, opts);
  }

  async translateSkillNames(names, lang) {
    return _translateSkillNames(this.resolveUtilityConfig(), names, lang);
  }

  async summarizeActivity(sp) {
    return _summarizeActivity(this.resolveUtilityConfig(), sp, (msg) => this.emitDevLog(msg));
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig(), sessionPath);
  }

  async summarizeSessionRelay(sessionPath, opts = {}) {
    return _summarizeSessionRelay(this.resolveUtilityConfig(), sessionPath, opts);
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {}
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }
  _readPrimaryAgent() { return this._prefs.getPrimaryAgent(); }
  _savePrimaryAgent(agentId) { return this._prefs.savePrimaryAgent(agentId); }

  // ════════════════════════════
  //  巡检工具白名单（向后兼容静态引用）
  // ════════════════════════════

  static PATROL_TOOLS_DEFAULT = [
    "search_memory", "pin_memory", "unpin_memory",
    "recall_experience", "record_experience",
    "web_search", "web_fetch",
    "todo", "notify",
    "present_files", "message_agent",
  ];
}
