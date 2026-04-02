/**
 * PreferencesManager — 全局 preferences.json 读写
 *
 * 统一管理用户级全局配置（bridge、agent 排序等），
 * 以及 primaryAgent 偏好。从 Engine 提取，避免 route 穿透私有字段。
 */
import fs from "fs";
import path from "path";
import {
  CLIENT_AGENT_KEY_PREF_KEY,
  generateClientAgentKey,
  sanitizeClientAgentKey,
} from "./client-agent-identity.js";

export class PreferencesManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDir  - 用户数据目录（preferences.json 所在）
   * @param {string} opts.agentsDir - agents 根目录（findFirstAgent 用）
   */
  constructor({ userDir, agentsDir }) {
    this._userDir = userDir;
    this._agentsDir = agentsDir;
    this._path = path.join(userDir, "preferences.json");
    this._cache = this._readFromDisk();
  }

  /** 读取全局 preferences（从内存缓存） */
  getPreferences() {
    return structuredClone(this._cache);
  }

  /** 写入全局 preferences（更新缓存 + 原子写磁盘） */
  savePreferences(prefs) {
    this._cache = structuredClone(prefs);
    fs.mkdirSync(this._userDir, { recursive: true });
    const tmp = this._path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, this._path);
  }

  /** @private 从磁盘读取（仅构造时调用一次） */
  _readFromDisk() {
    try { return JSON.parse(fs.readFileSync(this._path, "utf-8")); }
    catch { return {}; }
  }

  /** 读取沙盒模式偏好 */
  getSandbox() {
    return this.getPreferences().sandbox !== false;
  }

  /** 保存沙盒模式偏好 */
  setSandbox(enabled) {
    const prefs = this.getPreferences();
    prefs.sandbox = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取安全模式偏好（全局默认） */
  getSecurityMode() {
    const prefs = this.getPreferences();
    // Migration: if securityMode not set but sandbox was explicitly false (old full-access),
    // default to authorized mode (the new default that allows confirmation)
    if (prefs.securityMode) return prefs.securityMode;
    if (prefs.sandbox === false) return "authorized"; // was full-access, map to authorized
    return "authorized"; // default
  }

  /** 保存安全模式偏好（全局默认） */
  setSecurityMode(mode) {
    const prefs = this.getPreferences();
    prefs.securityMode = mode;
    // 向后兼容：同步 sandbox 字段
    // authorized/safe → sandbox: true, plan → sandbox: true
    prefs.sandbox = true;
    this.savePreferences(prefs);
  }

  /** 读取自学技能配置（全局，跨 agent） */
  getLearnSkills() {
    const cfg = this.getPreferences().learn_skills;
    if (!cfg) return { enabled: true, safety_review: true };
    return cfg;
  }

  /** 合并写入自学技能配置 */
  setLearnSkills(partial) {
    const prefs = this.getPreferences();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取语言偏好（全局） */
  getLocale() {
    return this.getPreferences().locale || "";
  }

  /** 保存语言偏好 */
  setLocale(locale) {
    const prefs = this.getPreferences();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /** 读取时区偏好（全局） */
  getTimezone() {
    return this.getPreferences().timezone || "";
  }

  /** 保存时区偏好 */
  setTimezone(tz) {
    const prefs = this.getPreferences();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

  /** 读取 thinking level 偏好（用户全局，跨 agent / session） */
  getThinkingLevel() {
    return this.getPreferences().thinking_level || "auto";
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level) {
    const prefs = this.getPreferences();
    prefs.thinking_level = level;
    this.savePreferences(prefs);
  }

  /** 读取外部技能扫描路径 */
  getExternalSkillPaths() {
    return this.getPreferences().external_skill_paths || [];
  }

  /** 保存外部技能扫描路径 */
  setExternalSkillPaths(paths) {
    const prefs = this.getPreferences();
    prefs.external_skill_paths = paths;
    this.savePreferences(prefs);
  }

  /** 读取 OAuth 自定义模型 { provider: ["model-id", ...] } */
  getOAuthCustomModels() {
    return this.getPreferences().oauth_custom_models || {};
  }

  /** 设置某个 OAuth provider 的自定义模型列表 */
  setOAuthCustomModels(provider, modelIds) {
    const prefs = this.getPreferences();
    if (!prefs.oauth_custom_models) prefs.oauth_custom_models = {};
    if (modelIds.length === 0) {
      delete prefs.oauth_custom_models[provider];
    } else {
      prefs.oauth_custom_models[provider] = modelIds;
    }
    this.savePreferences(prefs);
  }

  /** 读取更新通道偏好："stable" | "beta" */
  getUpdateChannel() {
    return this.getPreferences().update_channel || "stable";
  }

  /** 保存更新通道偏好 */
  setUpdateChannel(channel) {
    const prefs = this.getPreferences();
    prefs.update_channel = channel === "beta" ? "beta" : "stable";
    this.savePreferences(prefs);
  }

  /** 读取当前客户端的 Agent Key */
  getClientAgentKey() {
    return sanitizeClientAgentKey(this.getPreferences()[CLIENT_AGENT_KEY_PREF_KEY]);
  }

  /** 确保当前客户端存在稳定的 Agent Key（首次启动自动生成） */
  ensureClientAgentKey() {
    const existing = this.getClientAgentKey();
    if (existing) return existing;
    const prefs = this.getPreferences();
    const created = generateClientAgentKey();
    prefs[CLIENT_AGENT_KEY_PREF_KEY] = created;
    this.savePreferences(prefs);
    return created;
  }

  /** 读取 primary agent ID */
  getPrimaryAgent() {
    return this.getPreferences().primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId) {
    const prefs = this.getPreferences();
    prefs.primaryAgent = agentId;
    this.savePreferences(prefs);
  }

  /**
   * 找到 agents/ 目录下第一个合法的 agent
   * @returns {string|null}
   */
  findFirstAgent() {
    try {
      const entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(this._agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {}
    return null;
  }
}
