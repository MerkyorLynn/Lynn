import { isSafePathSegment } from "../shared/path-segment.js";
/**
 * AgentManager — 多 Agent 生命周期管理
 *
 * 从 Engine 提取，负责 agent 的扫描/初始化/创建/切换/删除。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import type { DumpOptions } from "js-yaml";
import { Agent } from "./agent.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { clearConfigCache } from "../lib/memory/config-loader.js";
import { t } from "../shared/i18n-runtime.js";
import { ActivityStore } from "../lib/desk/activity-store.js";
import {
  generateAgentId as _generateAgentId,
} from "./llm-utils.js";
import { findModel } from "../shared/model-ref.js";
import { getUserFacingRoleModelLabel, resolveRoleDefaultModel } from "../shared/assistant-role-models.js";

// TypeScript Interfaces
interface AgentManagerDependencies {
  agentsDir: string;
  productDir: string;
  userDir: string;
  channelsDir: string;
  getPrefs: () => PreferencesManager;
  getModels: () => ModelManager;
  getHub: () => HubInterface | null;
  getSkills: () => SkillManager;
  getSearchConfig: () => SearchConfig;
  resolveUtilityConfig: () => UtilityExecutionConfig;
  getSharedModels: () => SharedModels;
  getChannelManager: () => ChannelManager;
  getSessionCoordinator: () => SessionCoordinator;
  getEngine?: () => EngineInterface | null;
  getResourceLoader?: () => ResourceLoader | null;
}

interface PreferencesManager {
  getPreferences(): PreferencesData;
  savePreferences(prefs: PreferencesData): void;
  getPrimaryAgent(): string | null;
  savePrimaryAgent(agentId: string): void;
}

interface PreferencesData {
  bridge?: {
    owner?: Record<string, unknown>;
  };
  agentOrder?: string[];
  [key: string]: unknown;
}

interface ModelManager {
  availableModels: ResolvedModel[];
  defaultModel: ResolvedModel | null;
  resolveModelWithCredentials(bareId: string): ResolvedModel | null;
  inferModelProvider(modelId: string): string | null;
  providerRegistry: ProviderRegistry;
}

interface ProviderRegistry {
  getAllProvidersRaw?(): Record<string, { models?: unknown[] }>;
}

interface ResolvedModel {
  id: string;
  provider?: string | null;
  [key: string]: unknown;
}

interface HubInterface {
  scheduler?: {
    startAgentCron(agentId: string): void;
    removeAgentCron(agentId: string): void;
  };
  dmRouter?: {
    handleNewDm(fromId: string, toId: string): void;
  };
  eventBus?: {
    emit(event: { type: string; title: string; body: string }, context: null): void;
  };
  pauseForAgentSwitch(): Promise<void>;
  resumeAfterAgentSwitch(): void;
}

interface SkillManager {
  syncAgentSkills(agent: Agent): void;
  reload(resourceLoader: ResourceLoader | null, agents: Map<string, Agent>): Promise<void>;
}

interface SearchConfig {
  [key: string]: unknown;
}

interface UtilityExecutionConfig {
  [key: string]: unknown;
}

interface SharedModels {
  [key: string]: unknown;
}

interface ChannelManager {
  setupChannelsForNewAgent(agentId: string): void;
  cleanupAgentFromChannels(agentId: string): void;
}

interface SessionCoordinator {
  createSession(sessionId?: string | null, cwd?: string, memoryEnabled?: boolean): Promise<unknown>;
  _sessions: Map<string, unknown>;
}

interface EngineInterface {
  [key: string]: unknown;
}

interface ResourceLoader {
  [key: string]: unknown;
}

interface AgentInfo {
  id: string;
  name: string;
  yuan: string;
  tier: string;
  expertSlug: string | null;
  identity: string;
  hasAvatar: boolean;
}

interface AgentListCache {
  raw: AgentInfo[];
  ts: number;
}

interface CreateAgentOptions {
  name: string;
  id?: string;
  yuan: string;
}

interface AgentScanEntry {
  name: string;
  isDirectory(): boolean;
}

const log = createModuleLogger("agent-mgr");
const YAML_DUMP_OPTIONS = {
  lineWidth: 120,
  noRefs: true,
  quotingType: '"',
} as unknown as DumpOptions;

function firstExistingPath(...paths: Array<string | null | undefined>): string | null {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function normalizeYuanType(yuan: unknown): string {
  return String(yuan || "").trim().toLowerCase();
}

export class AgentManager {
  private _d: AgentManagerDependencies;
  private _agents: Map<string, Agent>;
  private _activeAgentId: string | null;
  private _switching: boolean;
  private _switchingFull: boolean;
  private _activityStores: Map<string, ActivityStore>;
  private _agentListCache: AgentListCache | null;

  static AGENT_LIST_TTL = 30_000; // 30 秒

  constructor(deps: AgentManagerDependencies) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switching = false;
    this._switchingFull = false;
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
  }

  /** 清除 listAgents 缓存（agent 增删改时调用） */
  invalidateAgentListCache(): void { this._agentListCache = null; }

  get agents(): Map<string, Agent> { return this._agents; }
  get activeAgentId(): string | null { return this._activeAgentId; }
  set activeAgentId(id: string | null) { this._activeAgentId = id; }
  get switching(): boolean { return this._switching; }

  /** 当前焦点 agent */
  get agent(): Agent | null { return this._agents.get(this._activeAgentId ?? "") || null; }

  /** 按 ID 获取 agent */
  getAgent(agentId: string): Agent | null { return this._agents.get(agentId) || null; }

  // ── Activity Store（per-agent 懒缓存） ──

  get activityStores(): Map<string, ActivityStore> { return this._activityStores; }

  getActivityStore(agentId: string): ActivityStore {
    let store = this._activityStores.get(agentId);
    if (!store) {
      const agDir = path.join(this._d.agentsDir, agentId);
      store = new ActivityStore(
        path.join(agDir, "desk", "activities.json"),
        path.join(agDir, "activity"),
      );
      this._activityStores.set(agentId, store);
    }
    return store;
  }

  private _repairExpertAgentConfigs(): void {
    const models = this._d.getModels();
    let repaired = 0;

    for (const entry of this._scanAgentDirs()) {
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;

      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML) as Record<string, unknown>;
        const isExpert = ((cfg?.agent as Record<string, unknown>)?.tier === "expert" || !!(cfg?.expert as Record<string, unknown>)?.slug);
        if (!isExpert) continue;

        let changed = false;

        if ((cfg?.agent as Record<string, unknown>)?.yuan === "ming") {
          (cfg.agent as Record<string, unknown>) = { ...((cfg.agent as Record<string, unknown>) || {}), yuan: "lynn" };
          changed = true;
        }

        // ── 1. 修复缺失的 provider ──
        const rawChat = (cfg?.models as Record<string, unknown>)?.chat;
        const chatModelId = typeof rawChat === "object" ? (rawChat as Record<string, unknown>)?.id : rawChat;
        const chatProviderInModel = typeof rawChat === "object" ? (rawChat as Record<string, unknown>)?.provider : "";
        const currentProvider = (cfg?.api as Record<string, unknown>)?.provider || chatProviderInModel || "";
        if (chatModelId && !currentProvider) {
          let inferredProvider = models.inferModelProvider(chatModelId as string);
          if (!inferredProvider) {
            const rawProviders = models.providerRegistry?.getAllProvidersRaw?.() || {};
            inferredProvider = Object.entries(rawProviders).find(([, raw]) =>
              Array.isArray((raw as Record<string, unknown>)?.models) && ((raw as Record<string, unknown>)?.models as Array<unknown>)?.some((m: unknown) => (typeof m === "object" ? (m as Record<string, unknown>)?.id : m) === chatModelId)
            )?.[0] || "";
          }
          if (inferredProvider) {
            cfg.api = { ...((cfg.api as Record<string, unknown>) || {}), provider: inferredProvider };
            if (typeof rawChat === "object") {
              cfg.models = cfg.models || {};
              (cfg.models as Record<string, unknown>).chat = { ...(rawChat as Record<string, unknown>), provider: (rawChat as Record<string, unknown>)?.provider || inferredProvider };
            }
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(
            configPath,
            YAML.dump(cfg, YAML_DUMP_OPTIONS),
            "utf-8",
          );
          repaired += 1;
        }

        // ── 2. 修复缺失/错误的专家头像：从预设目录同步 ──
        const slug = (cfg?.expert as Record<string, unknown>)?.slug as string;
        if (slug && this._d.productDir) {
          const presetAvatarsDir = fs.existsSync(path.join(this._d.productDir, "lib", "experts", "presets", slug, "avatars"))
            ? path.join(this._d.productDir, "lib", "experts", "presets", slug, "avatars")
            : path.join(this._d.productDir, "experts", "presets", slug, "avatars");
          const agentAvatarsDir = path.join(this._d.agentsDir, entry.name, "avatars");
          try {
            if (fs.existsSync(presetAvatarsDir)) {
              fs.mkdirSync(agentAvatarsDir, { recursive: true });
              const presetFiles = fs.readdirSync(presetAvatarsDir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
              for (const f of presetFiles) {
                const src = path.join(presetAvatarsDir, f);
                const ext = path.extname(f).toLowerCase();
                const agentDst = path.join(agentAvatarsDir, `agent${ext}`);
                const avatarDst = path.join(agentAvatarsDir, `avatar${ext}`);
                // 只有当 agent.* 头像不存在时才同步（避免覆盖用户自定义头像）
                if (!fs.existsSync(agentDst)) {
                  fs.copyFileSync(src, agentDst);
                  fs.copyFileSync(src, avatarDst);
                  log.log(`同步专家头像 ${slug} → ${entry.name}`);
                }
              }
            }
          } catch (avatarErr: any) {
            log.warn(`同步专家头像失败 (${entry.name}): ${avatarErr.message}`);
          }
        }
      } catch (err: any) {
        log.warn(`修复专家配置失败 (${entry.name}): ${err.message}`);
      }
    }

    if (repaired > 0) {
      clearConfigCache();
      this.invalidateAgentListCache();
      log.log(`已修复 ${repaired} 个专家配置中的缺失 provider`);
    }
  }

  // ── Init ──

  async initAllAgents(log: (msg: string) => void, startId: string): Promise<void> {
    this._activeAgentId = startId;

    const sharedModels = this._d.getSharedModels();
    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const resolveModel = (bareId: string, agentConfig: object) =>
      this._d.getModels().resolveModelWithCredentials(bareId) as object;

    this._repairExpertAgentConfigs();
    const entries = this._scanAgentDirs();
    const initOne = async (agentId: string) => {
      const agentDir = path.join(this._d.agentsDir, agentId);
      const ag = this._createAgentInstance(agentDir, getOwnerIds);
      await ag.init(
        agentId === this._activeAgentId ? log : () => {},
        sharedModels,
        resolveModel,
      );
      this._agents.set(agentId, ag);
    };

    // 焦点 agent 先初始化
    await initOne(this._activeAgentId);

    // 其余并行
    const others = entries.map(e => e.name).filter(id => id !== this._activeAgentId);
    if (others.length) {
      const results = await Promise.allSettled(others.map(id => initOne(id)));
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const rejectedResult = results[i] as PromiseRejectedResult;
          console.error(`[agent-manager] agent "${others[i]}" init 失败: ${rejectedResult.reason?.message}`);
        }
      }
    }
    log(`[init] ${this._agents.size} 个 agent 初始化完成`);
  }

  // ── List ──

  listAgents(): AgentInfo[] {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      const raw = this._agents.size > 0
        ? this._listLoadedAgents()
        : this._scanAgentList();
      this._agentListCache = { raw, ts: now };
    }

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    const order = prefs.getPreferences()?.agentOrder || [];

    const agents = this._agentListCache.raw.map(a => ({
      ...a,
      isPrimary: a.id === primaryId,
      isCurrent: a.id === this._activeAgentId,
    }));

    if (order.length) {
      agents.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }
    return agents;
  }

  private _listLoadedAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [];
    for (const [id, ag] of this._agents.entries()) {
      const cfg = ag?.config || {} as Record<string, unknown>;
      agents.push({
        id,
        name: ((cfg.agent as Record<string, unknown>)?.name as string) || ag?.agentName || id,
        yuan: ((cfg.agent as Record<string, unknown>)?.yuan as string) || "hanako",
        tier: ((cfg.agent as Record<string, unknown>)?.tier as string) || "local",
        expertSlug: ((cfg.expert as Record<string, unknown>)?.slug as string) || null,
        identity: "",
        hasAvatar: false,
      });
    }
    return agents;
  }

  /** 扫盘读取所有 agent 元数据（I/O 密集，由缓存保护） */
  private _scanAgentList(): AgentInfo[] {
    const entries = fs.readdirSync(this._d.agentsDir, { withFileTypes: true });
    const agents: AgentInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML) as Record<string, unknown>;
        let identity = "";
        try {
          const idMd = fs.readFileSync(path.join(this._d.agentsDir, entry.name, "identity.md"), "utf-8");
          const lines = idMd.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          identity = lines[0]?.trim() || "";
        } catch {}
        const avatarDir = path.join(this._d.agentsDir, entry.name, "avatars");
        let hasAvatar = false;
        try {
          const avatarFiles = fs.readdirSync(avatarDir);
          hasAvatar = avatarFiles.some(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
        } catch {}
        agents.push({
          id: entry.name,
          name: (cfg.agent as Record<string, unknown>)?.name as string || entry.name,
          yuan: (cfg.agent as Record<string, unknown>)?.yuan as string || "hanako",
          tier: (cfg.agent as Record<string, unknown>)?.tier as string || "local",
          expertSlug: (cfg.expert as Record<string, unknown>)?.slug as string || null,
          identity,
          hasAvatar,
        });
      } catch {}
    }
    return agents;
  }

  // ── Create ──

  async createAgent({ name, id, yuan }: CreateAgentOptions): Promise<{ id: string; name: string }> {
    if (!name?.trim()) throw new Error(t("error.agentNameEmpty"));

    const agentId = id?.trim() || await this._generateAgentId(name);
    if (/[\/\\]|\.\./.test(agentId)) throw new Error(t("error.agentIdInvalid"));
    const agentDir = path.join(this._d.agentsDir, agentId);

    if (fs.existsSync(agentDir)) {
      throw new Error(t("error.agentAlreadyExists", { id: agentId }));
    }

    // 创建目录结构
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });

    // 从模板复制 config.yaml（优先解析 YAML，避免模板文案微调导致 replace 失效）
    const templateConfig = fs.readFileSync(path.join(this._d.productDir, "config.example.yaml"), "utf-8");
    const currentAgent = this.agent;
    const userName = currentAgent?.userName || "";
    const normalizedYuan = normalizeYuanType(yuan);
    const VALID_YUAN = ["hanako", "butter", "lynn", "kong"];
    const yuanType = VALID_YUAN.includes(normalizedYuan) ? normalizedYuan : "hanako";
    const primaryChat = ((currentAgent?.config?.models as Record<string, unknown>)?.chat as string) || this._d.getModels().defaultModel?.id || "";

    let configYamlOut: string;
    try {
      const cfg = YAML.load(templateConfig) as Record<string, unknown>;
      if (!cfg || typeof cfg !== "object") throw new Error("invalid template");
      cfg.agent = cfg.agent || {};
      (cfg.agent as Record<string, unknown>).name = name.trim();
      (cfg.agent as Record<string, unknown>).yuan = yuanType;
      if (userName) {
        cfg.user = cfg.user || {};
        (cfg.user as Record<string, unknown>).name = userName;
      }
      if (primaryChat) {
        cfg.models = cfg.models || {};
        (cfg.models as Record<string, unknown>).chat = primaryChat;
      }
      configYamlOut = YAML.dump(cfg, YAML_DUMP_OPTIONS);
    } catch (e: any) {
      log.warn(`createAgent: YAML 模板解析失败，回退字符串替换: ${e.message}`);
      const safeName = name.trim().replace(/"/g, '\\"');
      let config = templateConfig.replace(/name: Lynn/, `name: "${safeName}"`);
      config = config.replace(/yuan: hanako/, `yuan: ${yuanType}`);
      if (userName) {
        config = config.replace(/user:\s*\n\s+name:\s*""/, `user:\n  name: "${userName}"`);
      }
      if (primaryChat) {
        config = config.replace(/chat: ""/, `chat: "${primaryChat}"`);
      }
      configYamlOut = config;
    }
    const configPath = path.join(agentDir, "config.yaml");
    fs.writeFileSync(configPath, configYamlOut, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(configPath, 0o600);

    const pd = this._d.productDir;
    // identity.md（按 yuan 选模板，缺省回退 hanako / identity.example）
    const identityPath = firstExistingPath(
      path.join(pd, "identity-templates", `${yuanType}.md`),
      path.join(pd, "identity-templates", "hanako.md"),
      path.join(pd, "identity.example.md"),
    );
    if (identityPath) {
      const tmpl = fs.readFileSync(identityPath, "utf-8");
      const filled = tmpl
        .replace(/\{\{agentName\}\}/g, name.trim())
        .replace(/\{\{userName\}\}/g, currentAgent?.userName || t("error.fallbackUserName"));
      fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
    }

    // ishiki.md
    const ishikiPath = firstExistingPath(
      path.join(pd, "ishiki-templates", `${yuanType}.md`),
      path.join(pd, "ishiki-templates", "hanako.md"),
      path.join(pd, "ishiki.example.md"),
    );
    if (ishikiPath) {
      fs.copyFileSync(ishikiPath, path.join(agentDir, "ishiki.md"));
    }

    // public-ishiki.md（对外意识；缺失时回退 hanako）
    const publicIshikiPath = firstExistingPath(
      path.join(pd, "public-ishiki-templates", `${yuanType}.md`),
      path.join(pd, "public-ishiki-templates", "hanako.md"),
    );
    if (publicIshikiPath) {
      fs.copyFileSync(publicIshikiPath, path.join(agentDir, "public-ishiki.md"));
    }

    // 可选文件：确保存在（即使为空），避免运行时 ENOENT
    const touchIfMissing = (p: string) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
    touchIfMissing(path.join(agentDir, 'pinned.md'));

    // 频道系统
    this._d.getChannelManager().setupChannelsForNewAgent(agentId);

    // 初始化并加入长驻 Map
    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const ag = this._createAgentInstance(agentDir, getOwnerIds);
    const resolveModel = (bareId: string, agentConfig: object) =>
      this._d.getModels().resolveModelWithCredentials(bareId) as object;
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel);
    } catch (err: any) {
      // init 失败：回滚已创建的目录，防止孤儿残留
      try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
    this._agents.set(agentId, ag);

    // 启动 cron
    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);

    // 注入 DM 回调
    const dmRouter = hub?.dmRouter;
    if (dmRouter) {
      (ag as any)._dmSentHandler = (fromId: string, toId: string) => dmRouter.handleNewDm(fromId, toId);
    }

    this.invalidateAgentListCache();
    log.log(`创建助手: ${name} (${agentId})`);
    return { id: agentId, name: name.trim() };
  }

  // ── Switch ──

  async switchAgentOnly(agentId: string): Promise<void> {
    if (this._switching) throw new Error(t("error.agentSwitching"));
    if (!this._agents.has(agentId)) {
      const loaded = await this.ensureAgentLoaded(agentId);
      if (!loaded) {
        throw new Error(t("error.agentNotFound", { id: agentId }));
      }
    }
    if (!this._agents.has(agentId)) {
      throw new Error(t("error.agentNotFound", { id: agentId }));
    }
    this._switching = true;
    const prevAgentId = this._activeAgentId;
    log.log(`switching agent to ${agentId}`);
    try {
      const hub = this._d.getHub();
      await hub?.pauseForAgentSwitch();
      // Phase 1: 不再杀 session，只切 agent 指针
      clearConfigCache();
      this._activeAgentId = agentId;

      const chatRef = ((this.agent?.config?.models as Record<string, unknown>)?.chat);
      const agentRole = ((this.agent?.config?.agent as Record<string, unknown>)?.yuan as string) || (this.agent as any)?.yuan || null;
      const roleLabel = getUserFacingRoleModelLabel(agentRole, "chat") || "角色默认模型";
      const preferredId = typeof chatRef === "object" ? (chatRef as Record<string, unknown>)?.id : chatRef;
      const preferredProvider = typeof chatRef === "object" ? (chatRef as Record<string, unknown>)?.provider : undefined;
      const models = this._d.getModels();
      if (preferredId) {
        const model = findModel(models.availableModels, preferredId as string, preferredProvider as string);
        if (!model) {
          const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
          if (!roleDefaultModel) {
            throw new Error(t("error.agentModelNotAvailable", { id: agentId, model: preferredId }));
          }
          models.defaultModel = roleDefaultModel;
        } else {
          models.defaultModel = model;
        }
      } else {
        const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
        if (roleDefaultModel) {
          models.defaultModel = roleDefaultModel;
        }
      }
      // 未配 models.chat 的 agent 继承当前 defaultModel
      log.log(`agent switched to ${this.agent?.agentName} (${agentId}), model=${roleLabel}`);
    } catch (err: any) {
      this._activeAgentId = prevAgentId;
      try { this._d.getHub()?.resumeAfterAgentSwitch(); } catch {}
      throw err;
    } finally {
      this._d.getHub()?.resumeAfterAgentSwitch();
      this._switching = false;
    }
  }

  async switchAgent(agentId: string): Promise<void> {
    // switchAgentOnly 内部有 _switching 锁，但 createSession 不在锁范围内
    // 用额外的 _switchingFull 标志保护整个流程，防止快速连续切换导致 session 用错 agent 配置
    if (this._switchingFull) throw new Error(t("error.agentSwitching"));
    this._switchingFull = true;
    try {
      await this.switchAgentOnly(agentId);
      const hub = this._d.getHub();
      hub?.resumeAfterAgentSwitch();
      this._d.getSkills().syncAgentSkills(this.agent!);
      this._d.getPrefs().savePrimaryAgent(agentId);
      await this._d.getSessionCoordinator().createSession();
      log.log(`已切换到助手: ${this.agent?.agentName} (${agentId})`);
    } finally {
      this._switchingFull = false;
    }
  }

  async createSessionForAgent(agentId: string, cwd: string, memoryEnabled = true): Promise<unknown> {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled);
  }

  // ── Delete ──

  async deleteAgent(agentId: string): Promise<void> {
    if (!isSafePathSegment(agentId)) throw new Error("Invalid agent ID");
    if (agentId === this._activeAgentId) {
      throw new Error(t("error.agentDeleteActive"));
    }

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(agentDir)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }

    const ag = this._agents.get(agentId);
    if (ag) {
      this._agents.delete(agentId);
      this._activityStores.delete(agentId);
      await this._d.getHub()?.scheduler?.removeAgentCron(agentId);
      await ag.dispose();
    }

    // 频道清理
    try {
      this._d.getChannelManager().cleanupAgentFromChannels(agentId);
    } catch (err: any) {
      log.error(`频道清理失败 (${agentId}): ${err.message}`);
    }

    await fsp.rm(agentDir, { recursive: true, force: true });

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    if (primaryId === agentId) {
      prefs.savePrimaryAgent(this._activeAgentId!);
    }

    const order = prefs.getPreferences()?.agentOrder || [];
    const newOrder = order.filter(id => id !== agentId);
    if (newOrder.length !== order.length) {
      const p = prefs.getPreferences();
      p.agentOrder = newOrder;
      prefs.savePreferences(p);
    }

    this.invalidateAgentListCache();
    log.log(`已删除助手: ${agentId}`);
  }

  // ── Utility ──

  setPrimaryAgent(agentId: string): void {
    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    this._d.getPrefs().savePrimaryAgent(agentId);
  }

  async ensureAgentLoaded(agentId: string, logFn: (msg: string) => void = () => {}): Promise<Agent | null> {
    if (!agentId) return null;
    const existing = this._agents.get(agentId);
    if (existing) return existing;

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      return null;
    }

    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const ag = this._createAgentInstance(agentDir, getOwnerIds);
    const resolveModel = (bareId: string, agentConfig: object) =>
      this._d.getModels().resolveModelWithCredentials(bareId) as object;

    await ag.init(logFn, this._d.getSharedModels(), resolveModel);
    this._agents.set(agentId, ag);
    this._d.getSkills()?.syncAgentSkills?.(ag);

    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);
    if (hub?.dmRouter) {
      (ag as any)._dmSentHandler = (fromId: string, toId: string) => hub.dmRouter!.handleNewDm(fromId, toId);
    }

    this.invalidateAgentListCache();
    return ag;
  }

  agentIdFromSessionPath(sessionPath: string): string | null {
    const rel = path.relative(this._d.agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(sessionCoord: SessionCoordinator): Promise<void> {
    // 对所有缓存 session 做 final 滚动摘要（带超时保护）
    const entries = sessionCoord ? [...sessionCoord._sessions.entries()] : [];
    if (entries.length > 0) {
      const summaryPromises = entries.map(([sp, entry]) => {
        const agent = this._agents.get((entry as any).agentId) || this.agent;
        return Promise.race([
          agent?._memoryTicker?.notifySessionEnd(sp) ?? Promise.resolve(),
          new Promise(r => setTimeout(r, 4000)),
        ]);
      });
      await Promise.allSettled(summaryPromises);
    }
    await Promise.allSettled(
      [...this._agents.values()].map(ag => ag.dispose()),
    );
    this._agents.clear();
  }

  // ── Internal ──

  private _scanAgentDirs(): AgentScanEntry[] {
    try {
      return fs.readdirSync(this._d.agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml")));
    } catch { return []; }
  }

  private _createAgentInstance(agentDir: string, getOwnerIds: () => Record<string, unknown>): Agent {
    const ag = new (Agent as any)({
      agentDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      agentsDir: this._d.agentsDir,
      searchConfigResolver: () => this._d.getSearchConfig(),
    });
    (ag as any)._getOwnerIds = getOwnerIds;
    (ag as any)._engine = this._d.getEngine?.() || null;
    (ag as any)._onInstallCallback = async (skillName: string) => {
      const skills = this._d.getSkills();
      await skills.reload(this._d.getResourceLoader?.() as ResourceLoader | null, this._agents);
      const enabled = new Set(ag.config?.skills?.enabled || []);
      enabled.add(skillName);
      ag.updateConfig({ skills: { enabled: [...enabled] } });
      skills.syncAgentSkills(ag);
    };
    (ag as any)._notifyHandler = (title: string, body: string) => {
      this._d.getHub()?.eventBus?.emit({ type: "notification", title, body }, null);
    };
    return ag;
  }

  private async _generateAgentId(name: string): Promise<string> {
    let utilConfig;
    try {
      utilConfig = this._d.resolveUtilityConfig();
    } catch {
      // utility 模型未配置（新用户常见），直接走兜底 ID
      return `agent-${Date.now().toString(36)}`;
    }
    return _generateAgentId(utilConfig, name, this._d.agentsDir);
  }
}
