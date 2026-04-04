/**
 * ConfigCoordinator — 运行时配置管理
 *
 * 负责 per-agent 模型选择、共享模型角色、搜索/utility 配置、
 * session meta 持久化、updateConfig 联动。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import path from "path";
import os from "os";
import { createModuleLogger } from "../lib/debug-log.js";
import { saveConfig } from "../lib/memory/config-loader.js";
import { findModel } from "../shared/model-ref.js";
import {
  getEffectiveTrustedRoots,
  getPreferredHomeFolder,
  normalizeTrustedRoot,
  uniqueTrustedRoots,
} from "../shared/trusted-roots.js";
import { t } from "../server/i18n.js";

const log = createModuleLogger("config");

/** Plan Mode / Bridge 只读工具名白名单 */
export const READ_ONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];

/** 全局共享模型字段 → preferences key 映射 */
export const SHARED_MODEL_KEYS = [
  ["utility",        "utility_model"],
  ["utility_large",  "utility_large_model"],
  ["summarizer",     "summarizer_model"],
  ["compiler",       "compiler_model"],
];

export class ConfigCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.lynnHome
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => Map} deps.getAgents - 所有 agent Map
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object|null} deps.getSession - 当前 session
   * @param {() => import('./session-coordinator.js').SessionCoordinator|null} deps.getSessionCoordinator
   * @param {() => object|null} deps.getHub
   * @param {(event, sp) => void} deps.emitEvent
   * @param {(text, level?) => void} deps.emitDevLog
   * @param {() => string|null} deps.getCurrentModel - currentModel name
   */
  constructor(deps) {
    this._d = deps;
  }

  // ── Home Folder ──

  getHomeFolder() {
    const prefs = this._prefs();
    const configured = getPreferredHomeFolder(prefs);
    if (configured && fs.existsSync(configured)) return configured;

    const trustedRoot = getEffectiveTrustedRoots(prefs).find((root) => fs.existsSync(root));
    if (trustedRoot) return trustedRoot;

    // 默认 fallback：~/Desktop/Lynn
    const defaultHome = path.join(os.homedir(), "Desktop", "Lynn");
    try { fs.mkdirSync(defaultHome, { recursive: true }); } catch {}
    return defaultHome;
  }

  setHomeFolder(folder) {
    const prefs = this._prefs();
    const normalized = normalizeTrustedRoot(folder);
    if (normalized) {
      try { fs.mkdirSync(normalized, { recursive: true }); } catch {}
      prefs.home_folder = normalized;
      prefs.trusted_roots = uniqueTrustedRoots([
        ...getEffectiveTrustedRoots(prefs),
        normalized,
      ]);
    } else {
      delete prefs.home_folder;
      prefs.trusted_roots = getEffectiveTrustedRoots(prefs);
    }
    this._savePrefs(prefs);
    log.log(`setHomeFolder: ${normalized || "(cleared)"}`);
  }

  getTrustedRoots() {
    return getEffectiveTrustedRoots(this._prefs());
  }

  setTrustedRoots(roots) {
    const prefs = this._prefs();
    prefs.trusted_roots = uniqueTrustedRoots(roots);

    const currentHome = normalizeTrustedRoot(prefs.home_folder);
    const effective = getEffectiveTrustedRoots(prefs);
    if (currentHome && !effective.includes(currentHome)) {
      if (effective[0]) prefs.home_folder = effective[0];
      else delete prefs.home_folder;
    }

    this._savePrefs(prefs);
    log.log(`setTrustedRoots: ${prefs.trusted_roots.join(", ") || "(defaults only)"}`);
  }

  // ── Shared Models ──

  getSharedModels() {
    const prefs = this._prefs();
    const result = {};
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      const raw = prefs[prefKey];
      if (typeof raw === "object" && raw?.id) {
        result[field] = raw;  // new format {id, provider}
      } else if (raw) {
        result[field] = raw;  // old format string — kept as-is for backward compat
      } else {
        result[field] = null;
      }
    }
    return result;
  }

  setSharedModels(partial) {
    const prefs = this._prefs();
    const changed = [];
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      if (partial[field] !== undefined) {
        if (partial[field] !== null && partial[field] !== "") prefs[prefKey] = partial[field];
        else delete prefs[prefKey];
        changed.push(`${field}=${partial[field] || "(cleared)"}`);
      }
    }
    this._savePrefs(prefs);
    if (changed.length) {
      const fresh = this.getSharedModels();
      const agent = this._d.getAgent();
      agent._utilityModel = fresh.utility || null;
      log.log(`setSharedModels: ${changed.join(", ")}`);
    }
  }

  // ── Search Config ──

  getSearchConfig() {
    const prefs = this._prefs();
    return {
      provider: prefs.search_provider || null,
      api_key: prefs.search_api_key || null,
    };
  }

  setSearchConfig(partial) {
    const prefs = this._prefs();
    if (partial.provider !== undefined) {
      if (partial.provider) prefs.search_provider = partial.provider;
      else delete prefs.search_provider;
    }
    if (partial.api_key !== undefined) {
      if (partial.api_key) prefs.search_api_key = partial.api_key;
      else delete prefs.search_api_key;
    }
    this._savePrefs(prefs);
    log.log(`setSearchConfig: provider=${partial.provider || "(cleared)"}`);
  }

  // ── Utility API ──

  getUtilityApi() {
    const prefs = this._prefs();
    return {
      provider: prefs.utility_api_provider || null,
      base_url: prefs.utility_api_base_url || null,
      api_key: prefs.utility_api_key || null,
    };
  }

  setUtilityApi(partial) {
    const prefs = this._prefs();
    for (const [key, prefKey] of [
      ["provider", "utility_api_provider"],
      ["base_url", "utility_api_base_url"],
      ["api_key", "utility_api_key"],
    ]) {
      if (partial[key] !== undefined) {
        if (partial[key]) prefs[prefKey] = partial[key];
        else delete prefs[prefKey];
      }
    }
    this._savePrefs(prefs);
    log.log(`setUtilityApi: provider=${partial.provider || "-"}, base_url=${partial.base_url || "-"}`);
  }

  resolveUtilityConfig() {
    const models = this._d.getModels();
    return models.resolveUtilityConfig(
      this._d.getAgent().config,
      this.getSharedModels(),
      this.getUtilityApi(),
    );
  }

  // ── Agent Order ──

  readAgentOrder() {
    return this._prefs().agentOrder || [];
  }

  saveAgentOrder(order) {
    const prefs = this._prefs();
    prefs.agentOrder = order;
    this._savePrefs(prefs);
  }

  // ── Model / Thinking ──

  async syncAndRefresh() {
    const models = this._d.getModels();
    const synced = await models.syncAndRefresh();
    this.normalizeUtilityApiPreferences();
    return synced;
  }

  /**
   * 切换当前聊天模型。
   * 规则：
   * 1. 立即切换当前活跃 session（如果存在）
   * 2. 同步写回当前 agent 的默认 chat 模型，避免 UI / 会话 / config.yaml 漂移
   * 3. 持久化 session meta，确保冷启动恢复时也沿用正确模型
   */
  async setPendingModel(modelId, provider) {
    const models = this._d.getModels();
    const model = findModel(models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    const sessionCoord = this._d.getSessionCoordinator();
    await sessionCoord?.switchCurrentSessionModel(model);
    models.setDefaultModel(model.id, model.provider || undefined);
    const agent = this._d.getAgent();
    const configPatch = {
      models: { chat: model.provider ? { id: model.id, provider: model.provider } : model.id },
      ...(model.provider ? { api: { provider: model.provider } } : {}),
    };
    if (agent?.configPath) {
      if (typeof agent.updateConfig === "function") {
        agent.updateConfig(configPatch);
      } else {
        saveConfig(agent.configPath, configPatch);
        if (agent.config && typeof agent.config === "object") {
          agent.config.models = {
            ...(agent.config.models || {}),
            chat: configPatch.models.chat,
          };
          if (model.provider) {
            agent.config.api = {
              ...(agent.config.api || {}),
              provider: model.provider,
            };
          }
        }
      }
    }
    this.persistSessionMeta();
    return model;
  }

  /**
   * 设置 agent 默认模型（设置页面操作）。
   * 更新 ModelManager._defaultModel + 持久化到 config.yaml。
   * 不修改任何已有 session 的模型。
   */
  setDefaultModel(modelId, provider) {
    const models = this._d.getModels();
    const model = models.setDefaultModel(modelId, provider);
    const agent = this._d.getAgent();
    if (agent?.configPath) {
      saveConfig(agent.configPath, {
        models: { chat: provider ? { id: modelId, provider } : modelId },
      });
    }
    log.log(`default model set to: ${model.name || model.id}`);
    return model;
  }

  setThinkingLevel(level) {
    // 持久化到全局 preference（跨 session 常驻）
    this._d.getPrefs().setThinkingLevel(level);
    const session = this._d.getSession();
    if (session) {
      session.setThinkingLevel(this._d.getModels().resolveThinkingLevel(level));
    }
  }

  /** 从 preference 读取用户设定的 thinking level */
  getThinkingLevel() {
    return this._d.getPrefs().getThinkingLevel();
  }

  // ── Memory ──

  setMemoryEnabled(val) {
    this._d.getAgent().setMemoryEnabled(val);
    this.persistSessionMeta();
  }

  setMemoryMasterEnabled(agentId, val) {
    const ag = this._d.getAgents().get(agentId);
    if (ag) ag.setMemoryMasterEnabled(val);
  }

  persistSessionMeta() {
    const session = this._d.getSession();
    const sessPath = session?.sessionManager?.getSessionFile?.();
    if (!sessPath) return;
    const agent = this._d.getAgent();
    const metaPath = path.join(agent.sessionDir, "session-meta.json");

    const sessionCoord = this._d.getSessionCoordinator();
    const modelRef = sessionCoord?.getCurrentSessionModelRef() || null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
        const sessKey = path.basename(sessPath);
        meta[sessKey] = {
          ...meta[sessKey],
          memoryEnabled: agent.memoryEnabled,
          ...(modelRef && { model: modelRef }),
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        return;
      } catch (err) {
        if (attempt === 0) {
          try { fs.mkdirSync(path.dirname(metaPath), { recursive: true }); } catch {}
        } else {
          console.error("[config] persistSessionMeta failed:", err.message);
        }
      }
    }
  }

  // ── updateConfig ──

  async updateConfig(partial) {
    const keys = Object.keys(partial);
    if (keys.length) log.log(`updateConfig: keys=[${keys.join(",")}]`);

    const agent = this._d.getAgent();
    const models = this._d.getModels();

    // agent 负责：写磁盘、刷新身份、刷新模块、重建 prompt
    agent.updateConfig(partial);

    // 切换聊天模型：不需要 sync，模型早已注册
    if (partial.models?.chat) {
      const chatRaw = partial.models.chat;
      const chatId = typeof chatRaw === "object" ? chatRaw.id : chatRaw;
      const chatProvider = (typeof chatRaw === "object" ? chatRaw.provider : null)
        || partial.api?.provider || undefined;
      const newModel = findModel(models.availableModels, chatId, chatProvider);
      if (newModel) {
        // 只更新 agent 默认模型，不改活跃 session
        models.defaultModel = newModel;
        log.log(`default model updated to: ${newModel.name || newModel.id}`);
      }
    }

    if (partial.skills) {
      this._d.getSkills().syncAgentSkills(agent);
    }

    if (partial.desk) {
      const scheduler = this._d.getHub()?.scheduler;
      if ("heartbeat_interval" in partial.desk && scheduler) {
        // 间隔变更：需要完整重建 heartbeat（INTERVAL 在创建时固化）
        this._d.emitDevLog(`[heartbeat] 巡检间隔已更新: ${partial.desk.heartbeat_interval} 分钟`);
        await scheduler.reloadHeartbeat();
      } else if ("heartbeat_enabled" in partial.desk) {
        const hb = scheduler?.heartbeat;
        if (hb) {
          if (partial.desk.heartbeat_enabled === false) {
            this._d.emitDevLog("[heartbeat] 巡检已关闭");
            await hb.stop();
          } else {
            this._d.emitDevLog("[heartbeat] 巡检已开启");
            hb.start();
          }
        }
      }
    }
  }

  normalizeUtilityApiPreferences(logFn = null) {
    const prefs = this._prefs();
    const hasOverride =
      !!prefs.utility_api_provider ||
      !!prefs.utility_api_base_url ||
      !!prefs.utility_api_key;
    if (!hasOverride) return false;

    const shared = this.getSharedModels();
    const utilityModelId = shared.utility || this._d.getAgent()?.config?.models?.utility || "";
    const utilityEntry = utilityModelId
      ? findModel(this._d.getModels().availableModels, utilityModelId)
      : null;

    let reason = "";
    if (!prefs.utility_api_provider || !prefs.utility_api_base_url || !prefs.utility_api_key) {
      reason = "override incomplete";
    } else if (!utilityEntry?.provider) {
      reason = "utility model unavailable";
    } else if (prefs.utility_api_provider !== utilityEntry.provider) {
      reason = `provider mismatch (${prefs.utility_api_provider} != ${utilityEntry.provider})`;
    }

    if (!reason) return false;

    delete prefs.utility_api_provider;
    delete prefs.utility_api_base_url;
    delete prefs.utility_api_key;
    this._savePrefs(prefs);
    const logger = logFn || log.log.bind(log);
    logger(`[config] cleared invalid utility_api override: ${reason}`);
    return true;
  }

  // ── helpers ──

  _prefs() { return this._d.getPrefs().getPreferences(); }
  _savePrefs(prefs) { return this._d.getPrefs().savePreferences(prefs); }
}
