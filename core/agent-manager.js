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
import { Agent } from "./agent.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { clearConfigCache } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ActivityStore } from "../lib/desk/activity-store.js";
import {
  generateAgentId as _generateAgentId,
} from "./llm-utils.js";
import { findModel } from "../shared/model-ref.js";
import { getUserFacingRoleModelLabel, resolveRoleDefaultModel } from "../shared/assistant-role-models.js";

const log = createModuleLogger("agent-mgr");

function firstExistingPath(...paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class AgentManager {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {string} deps.productDir
   * @param {string} deps.userDir
   * @param {string} deps.channelsDir
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object|null} deps.getHub
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object} deps.getSearchConfig
   * @param {() => object} deps.resolveUtilityConfig
   * @param {() => object} deps.getSharedModels
   * @param {() => import('./channel-manager.js').ChannelManager} deps.getChannelManager
   * @param {() => import('./session-coordinator.js').SessionCoordinator} deps.getSessionCoordinator
   */
  constructor(deps) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switching = false;
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
  }

  /** 清除 listAgents 缓存（agent 增删改时调用） */
  invalidateAgentListCache() { this._agentListCache = null; }

  get agents() { return this._agents; }
  get activeAgentId() { return this._activeAgentId; }
  set activeAgentId(id) { this._activeAgentId = id; }
  get switching() { return this._switching; }

  /** 当前焦点 agent */
  get agent() { return this._agents.get(this._activeAgentId); }

  /** 按 ID 获取 agent */
  getAgent(agentId) { return this._agents.get(agentId) || null; }

  // ── Activity Store（per-agent 懒缓存） ──

  get activityStores() { return this._activityStores; }

  getActivityStore(agentId) {
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

  _repairExpertAgentConfigs() {
    const models = this._d.getModels();
    let repaired = 0;

    for (const entry of this._scanAgentDirs()) {
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;

      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML);
        const isExpert = cfg?.agent?.tier === "expert" || !!cfg?.expert?.slug;
        if (!isExpert) continue;

        let changed = false;

        if (cfg?.agent?.yuan === "ming") {
          cfg.agent = { ...(cfg.agent || {}), yuan: "lynn" };
          changed = true;
        }

        // ── 1. 修复缺失的 provider ──
        const rawChat = cfg?.models?.chat;
        const chatModelId = typeof rawChat === "object" ? rawChat?.id : rawChat;
        const chatProviderInModel = typeof rawChat === "object" ? rawChat?.provider : "";
        const currentProvider = cfg?.api?.provider || chatProviderInModel || "";
        if (chatModelId && !currentProvider) {
          let inferredProvider = models.inferModelProvider(chatModelId);
          if (!inferredProvider) {
            const rawProviders = models.providerRegistry?.getAllProvidersRaw?.() || {};
            inferredProvider = Object.entries(rawProviders).find(([, raw]) =>
              Array.isArray(raw?.models) && raw.models.some((m) => (typeof m === "object" ? m.id : m) === chatModelId)
            )?.[0] || "";
          }
          if (inferredProvider) {
            cfg.api = { ...(cfg.api || {}), provider: inferredProvider };
            if (typeof rawChat === "object") {
              cfg.models = cfg.models || {};
              cfg.models.chat = { ...rawChat, provider: rawChat.provider || inferredProvider };
            }
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(
            configPath,
            YAML.dump(cfg, { lineWidth: 120, noRefs: true, quotingType: '"' }),
            "utf-8",
          );
          repaired += 1;
        }

        // ── 2. 修复缺失/错误的专家头像：从预设目录同步 ──
        const slug = cfg?.expert?.slug;
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
          } catch (avatarErr) {
            log.warn(`同步专家头像失败 (${entry.name}): ${avatarErr.message}`);
          }
        }
      } catch (err) {
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

  async initAllAgents(log, startId) {
    this._activeAgentId = startId;

    const sharedModels = this._d.getSharedModels();
    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);

    this._repairExpertAgentConfigs();
    const entries = this._scanAgentDirs();
    const initOne = async (agentId) => {
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
          console.error(`[agent-manager] agent "${others[i]}" init 失败: ${results[i].reason?.message}`);
        }
      }
    }
    log(`[init] ${this._agents.size} 个 agent 初始化完成`);
  }

  // ── List ──

  static AGENT_LIST_TTL = 30_000; // 30 秒

  listAgents() {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      this._agentListCache = { raw: this._scanAgentList(), ts: now };
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

  /** 扫盘读取所有 agent 元数据（I/O 密集，由缓存保护） */
  _scanAgentList() {
    const entries = fs.readdirSync(this._d.agentsDir, { withFileTypes: true });
    const agents = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML);
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
          name: cfg.agent?.name || entry.name,
          yuan: cfg.agent?.yuan || "hanako",
          tier: cfg.agent?.tier || "local",
          expertSlug: cfg.expert?.slug || null,
          identity,
          hasAvatar,
        });
      } catch {}
    }
    return agents;
  }

  // ── Create ──

  async createAgent({ name, id, yuan }) {
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
    const primaryChat = currentAgent?.config?.models?.chat || this._d.getModels().defaultModel?.id || "";

    let configYamlOut;
    try {
      const cfg = YAML.load(templateConfig);
      if (!cfg || typeof cfg !== "object") throw new Error("invalid template");
      cfg.agent = cfg.agent || {};
      cfg.agent.name = name.trim();
      cfg.agent.yuan = yuanType;
      if (userName) {
        cfg.user = cfg.user || {};
        cfg.user.name = userName;
      }
      if (primaryChat) {
        cfg.models = cfg.models || {};
        cfg.models.chat = primaryChat;
      }
      configYamlOut = YAML.dump(cfg, { lineWidth: 120, noRefs: true, quotingType: '"' });
    } catch (e) {
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
    fs.writeFileSync(path.join(agentDir, "config.yaml"), configYamlOut, "utf-8");

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
    const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
    touchIfMissing(path.join(agentDir, 'pinned.md'));

    // 频道系统
    this._d.getChannelManager().setupChannelsForNewAgent(agentId);

    // 初始化并加入长驻 Map
    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const ag = this._createAgentInstance(agentDir, getOwnerIds);
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel);
    } catch (err) {
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
      ag._dmSentHandler = (fromId, toId) => dmRouter.handleNewDm(fromId, toId);
    }

    this.invalidateAgentListCache();
    log.log(`创建助手: ${name} (${agentId})`);
    return { id: agentId, name: name.trim() };
  }

  // ── Switch ──

  async switchAgentOnly(agentId) {
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

      const chatRef = this.agent.config.models?.chat;
      const agentRole = this.agent.config?.agent?.yuan || this.agent.yuan || null;
      const roleLabel = getUserFacingRoleModelLabel(agentRole, "chat") || "角色默认模型";
      const preferredId = typeof chatRef === "object" ? chatRef?.id : chatRef;
      const preferredProvider = typeof chatRef === "object" ? chatRef?.provider : undefined;
      const models = this._d.getModels();
      if (preferredId) {
        const model = findModel(models.availableModels, preferredId, preferredProvider);
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
      log.log(`agent switched to ${this.agent.agentName} (${agentId}), model=${roleLabel}`);
    } catch (err) {
      this._activeAgentId = prevAgentId;
      try { this._d.getHub()?.resumeAfterAgentSwitch(); } catch {}
      throw err;
    } finally {
      this._switching = false;
    }
  }

  async switchAgent(agentId) {
    // switchAgentOnly 内部有 _switching 锁，但 createSession 不在锁范围内
    // 用额外的 _switchingFull 标志保护整个流程，防止快速连续切换导致 session 用错 agent 配置
    if (this._switchingFull) throw new Error(t("error.agentSwitching"));
    this._switchingFull = true;
    try {
      await this.switchAgentOnly(agentId);
      const hub = this._d.getHub();
      hub?.resumeAfterAgentSwitch();
      this._d.getSkills().syncAgentSkills(this.agent);
      this._d.getPrefs().savePrimaryAgent(agentId);
      await this._d.getSessionCoordinator().createSession();
      log.log(`已切换到助手: ${this.agent.agentName} (${agentId})`);
    } finally {
      this._switchingFull = false;
    }
  }

  async createSessionForAgent(agentId, cwd, memoryEnabled = true) {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled);
  }

  // ── Delete ──

  async deleteAgent(agentId) {
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
    } catch (err) {
      log.error(`频道清理失败 (${agentId}): ${err.message}`);
    }

    await fsp.rm(agentDir, { recursive: true, force: true });

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    if (primaryId === agentId) {
      prefs.savePrimaryAgent(this._activeAgentId);
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

  setPrimaryAgent(agentId) {
    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    this._d.getPrefs().savePrimaryAgent(agentId);
  }

  async ensureAgentLoaded(agentId, logFn = () => {}) {
    if (!agentId) return null;
    const existing = this._agents.get(agentId);
    if (existing) return existing;

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      return null;
    }

    const getOwnerIds = () => this._d.getPrefs().getPreferences()?.bridge?.owner || {};
    const ag = this._createAgentInstance(agentDir, getOwnerIds);
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);

    await ag.init(logFn, this._d.getSharedModels(), resolveModel);
    this._agents.set(agentId, ag);
    this._d.getSkills()?.syncAgentSkills?.(ag);

    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);
    if (hub?.dmRouter) {
      ag._dmSentHandler = (fromId, toId) => hub.dmRouter.handleNewDm(fromId, toId);
    }

    this.invalidateAgentListCache();
    return ag;
  }

  agentIdFromSessionPath(sessionPath) {
    const rel = path.relative(this._d.agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(sessionCoord) {
    // 对所有缓存 session 做 final 滚动摘要（带超时保护）
    const entries = sessionCoord ? [...sessionCoord._sessions.entries()] : [];
    if (entries.length > 0) {
      const summaryPromises = entries.map(([sp, entry]) => {
        const agent = this._agents.get(entry.agentId) || this.agent;
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

  _scanAgentDirs() {
    try {
      return fs.readdirSync(this._d.agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml")));
    } catch { return []; }
  }

  _createAgentInstance(agentDir, getOwnerIds) {
    const ag = new Agent({
      agentDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      agentsDir: this._d.agentsDir,
      searchConfigResolver: () => this._d.getSearchConfig(),
    });
    ag._getOwnerIds = getOwnerIds;
    ag._engine = this._d.getEngine?.() || null;
    ag._onInstallCallback = async (skillName) => {
      const skills = this._d.getSkills();
      await skills.reload(this._d.getResourceLoader?.(), this._agents);
      const enabled = new Set(ag.config?.skills?.enabled || []);
      enabled.add(skillName);
      ag.updateConfig({ skills: { enabled: [...enabled] } });
      skills.syncAgentSkills(ag);
    };
    ag._notifyHandler = (title, body) => {
      this._d.getHub()?.eventBus?.emit({ type: "notification", title, body }, null);
    };
    return ag;
  }

  async _generateAgentId(name) {
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
