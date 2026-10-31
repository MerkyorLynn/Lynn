/**
 * PreferencesManager — 全局 preferences.json 读写
 *
 * 统一管理用户级全局配置（bridge、agent 排序等），
 * 以及 primaryAgent 偏好。从 Engine 提取，避免 route 穿透私有字段。
 */
import fs from "fs";
import path from "path";
import { mergeJsonChanges, updateJsonFileSync } from "../shared/atomic-json.cjs";
import {
  CLIENT_AGENT_KEY_PREF_KEY,
  CLIENT_AGENT_SECRET_PREF_KEY,
  generateClientAgentKey,
  generateClientAgentSecret,
  sanitizeClientAgentKey,
  sanitizeClientAgentSecret,
} from "./client-agent-identity.js";

export type SecurityModePreference = "authorized" | "plan" | "safe";
export type UpdateChannelPreference = "stable" | "beta";

export interface PreferencesManagerOptions {
  userDir: string;
  agentsDir: string;
}

export interface LearnSkillsPreference {
  enabled?: boolean;
  safety_review?: boolean;
  [key: string]: unknown;
}

export interface SessionRelayPreference {
  enabled?: boolean;
  compaction_threshold?: number;
  summary_max_tokens?: number;
  [key: string]: unknown;
}

export interface NormalizedSessionRelayPreference {
  enabled: boolean;
  compaction_threshold: number;
  summary_max_tokens: number;
}

export interface SnapshotPreference {
  enabled?: boolean;
  maxDays?: number;
  [key: string]: unknown;
}

export interface NormalizedSnapshotPreference {
  enabled: boolean;
  maxDays: number;
}

export interface ContentFilterPreference {
  enabled?: boolean;
  byok?: "warn" | "block" | string;
  [key: string]: unknown;
}

export interface NormalizedContentFilterPreference {
  enabled: boolean;
  byok: "warn" | "block";
}

export interface ClientIdentity {
  key: string;
  secret: string;
}

export interface PreferencesData {
  sandbox?: boolean;
  securityMode?: SecurityModePreference | "full-access" | string;
  learn_skills?: LearnSkillsPreference;
  locale?: string;
  timezone?: string;
  thinking_level?: string;
  session_relay?: SessionRelayPreference;
  external_skill_paths?: unknown[];
  oauth_custom_models?: Record<string, string[]>;
  update_channel?: UpdateChannelPreference | string;
  snapshot?: SnapshotPreference;
  content_filter?: boolean | ContentFilterPreference;
  [CLIENT_AGENT_KEY_PREF_KEY]?: unknown;
  [CLIENT_AGENT_SECRET_PREF_KEY]?: unknown;
  primaryAgent?: string | null;
  [key: string]: unknown;
}

export class PreferencesManager {
  _userDir: string;
  _agentsDir: string;
  _path: string;
  _cache: PreferencesData;
  private _snapshots = new WeakMap<PreferencesData, PreferencesData>();

  constructor({ userDir, agentsDir }: PreferencesManagerOptions) {
    this._userDir = userDir;
    this._agentsDir = agentsDir;
    this._path = path.join(userDir, "preferences.json");
    this._cache = this._readFromDisk();
  }

  /** 读取全局 preferences（从内存缓存） */
  getPreferences(): PreferencesData {
    this._cache = this._readFromDisk();
    const snapshot = structuredClone(this._cache);
    this._snapshots.set(snapshot, structuredClone(snapshot));
    return snapshot;
  }

  /** 写入全局 preferences（更新缓存 + 原子写磁盘） */
  savePreferences(prefs: PreferencesData): void {
    const before = this._snapshots.get(prefs) || this._cache;
    this._cache = updateJsonFileSync(this._path, (latest: PreferencesData) => mergeJsonChanges(latest, before, prefs));
    this._snapshots.set(prefs, structuredClone(prefs));
  }

  /** @private 从磁盘读取（仅构造时调用一次） */
  _readFromDisk(): PreferencesData {
    try { return JSON.parse(fs.readFileSync(this._path, "utf-8")) as PreferencesData; }
    catch { return {}; }
  }

  /** 读取沙盒模式偏好 */
  getSandbox(): boolean {
    return this.getPreferences().sandbox !== false;
  }

  /** 保存沙盒模式偏好 */
  setSandbox(enabled: boolean | string): void {
    const prefs = this.getPreferences();
    prefs.sandbox = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取安全模式偏好（全局默认） */
  getSecurityMode(): SecurityModePreference {
    const prefs = this.getPreferences();
    const mode = prefs.securityMode;
    // 迁移：旧版 full-access 映射到新版 authorized（行为一致）
    if (mode === "full-access") return "authorized";
    if (mode === "authorized" || mode === "plan" || mode === "safe") return mode;
    return "authorized"; // 新默认：无沙盒限制
  }

  /** 保存安全模式偏好（全局默认） */
  setSecurityMode(mode: string): void {
    const prefs = this.getPreferences();
    prefs.securityMode = mode;
    // 向后兼容：full-access <=> sandbox: false
    prefs.sandbox = mode !== "full-access";
    this.savePreferences(prefs);
  }

  /** 读取自学技能配置（全局，跨 agent） */
  getLearnSkills(): LearnSkillsPreference {
    const cfg = this.getPreferences().learn_skills;
    if (!cfg) return { enabled: true, safety_review: true };
    return cfg;
  }

  /** 合并写入自学技能配置 */
  setLearnSkills(partial: Partial<LearnSkillsPreference>): void {
    const prefs = this.getPreferences();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取语言偏好（全局） */
  getLocale(): string {
    return this.getPreferences().locale || "";
  }

  /** 保存语言偏好 */
  setLocale(locale: string | null | undefined): void {
    const prefs = this.getPreferences();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /** 读取时区偏好（全局） */
  getTimezone(): string {
    return this.getPreferences().timezone || "";
  }

  /** 保存时区偏好 */
  setTimezone(tz: string | null | undefined): void {
    const prefs = this.getPreferences();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

  /** 读取 thinking level 偏好（用户全局，跨 agent / session） */
  getThinkingLevel(): string {
    return this.getPreferences().thinking_level || "auto";
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level: string): void {
    const prefs = this.getPreferences();
    prefs.thinking_level = level;
    this.savePreferences(prefs);
  }

  /** 读取 session 自动接力配置 */
  getSessionRelay(): NormalizedSessionRelayPreference {
    const cfg = this.getPreferences().session_relay || {};
    return {
      enabled: cfg.enabled !== false,
      compaction_threshold: Number(cfg.compaction_threshold) > 0 ? Number(cfg.compaction_threshold) : 3,
      summary_max_tokens: Number(cfg.summary_max_tokens) > 0 ? Number(cfg.summary_max_tokens) : 800,
    };
  }

  /** 保存 session 自动接力配置 */
  setSessionRelay(partial: Partial<SessionRelayPreference>): void {
    const prefs = this.getPreferences();
    prefs.session_relay = {
      ...(prefs.session_relay || {}),
      ...partial,
    };
    this.savePreferences(prefs);
  }

  /** 读取外部技能扫描路径 */
  getExternalSkillPaths(): unknown[] {
    return this.getPreferences().external_skill_paths || [];
  }

  /** 保存外部技能扫描路径 */
  setExternalSkillPaths(paths: unknown[]): void {
    const prefs = this.getPreferences();
    prefs.external_skill_paths = paths;
    this.savePreferences(prefs);
  }

  /** 读取 OAuth 自定义模型 { provider: ["model-id", ...] } */
  getOAuthCustomModels(): Record<string, string[]> {
    return this.getPreferences().oauth_custom_models || {};
  }

  /** 设置某个 OAuth provider 的自定义模型列表 */
  setOAuthCustomModels(provider: string, modelIds: string[]): void {
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
  getUpdateChannel(): string {
    return this.getPreferences().update_channel || "stable";
  }

  /** 保存更新通道偏好 */
  setUpdateChannel(channel: string): void {
    const prefs = this.getPreferences();
    prefs.update_channel = channel === "beta" ? "beta" : "stable";
    this.savePreferences(prefs);
  }

  /** 读取快照配置（文件防丢失） */
  getSnapshot(): NormalizedSnapshotPreference {
    const cfg = this.getPreferences().snapshot || {};
    return {
      enabled: cfg.enabled !== false,       // 默认开启
      maxDays: Number(cfg.maxDays) > 0 ? Number(cfg.maxDays) : 7,
    };
  }

  /** 保存快照配置 */
  setSnapshot(partial: Partial<SnapshotPreference>): void {
    const prefs = this.getPreferences();
    prefs.snapshot = { ...(prefs.snapshot || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取本地内容安全过滤配置 */
  getContentFilter(): NormalizedContentFilterPreference {
    const cfg = this.getPreferences().content_filter;
    const byok = cfg && typeof cfg === "object" && String(cfg.byok || "").toLowerCase() === "block"
      ? "block"
      : "warn";
    return {
      enabled: cfg !== false && !(cfg && typeof cfg === "object" && cfg.enabled === false),
      byok,
    };
  }

  /** 保存本地内容安全过滤配置 */
  setContentFilter(partial: boolean | Partial<ContentFilterPreference>): void {
    const prefs = this.getPreferences();
    if (typeof partial === "boolean") {
      prefs.content_filter = partial ? { enabled: true, byok: this.getContentFilter().byok } : false;
    } else {
      const current = this.getContentFilter();
      prefs.content_filter = {
        enabled: partial.enabled ?? current.enabled,
        byok: partial.byok === "block" ? "block" : partial.byok === "warn" ? "warn" : current.byok,
      };
    }
    this.savePreferences(prefs);
  }

  /** 读取当前客户端的 Agent Key */
  getClientAgentKey(): string | null {
    return sanitizeClientAgentKey(this.getPreferences()[CLIENT_AGENT_KEY_PREF_KEY]);
  }

  /** 读取当前客户端的签名密钥 */
  getClientAgentSecret(): string | null {
    return sanitizeClientAgentSecret(this.getPreferences()[CLIENT_AGENT_SECRET_PREF_KEY]);
  }

  /** 确保当前客户端存在稳定的 Agent Key（首次启动自动生成） */
  ensureClientAgentKey(): string {
    const existing = this.getClientAgentKey();
    if (existing) return existing;
    const prefs = this.getPreferences();
    const created = generateClientAgentKey();
    prefs[CLIENT_AGENT_KEY_PREF_KEY] = created;
    this.savePreferences(prefs);
    return created;
  }

  /** 确保当前客户端存在稳定的签名密钥（首次启动自动生成） */
  ensureClientAgentSecret(): string {
    const existing = this.getClientAgentSecret();
    if (existing) return existing;
    const prefs = this.getPreferences();
    const created = generateClientAgentSecret();
    prefs[CLIENT_AGENT_SECRET_PREF_KEY] = created;
    this.savePreferences(prefs);
    return created;
  }

  /** 同时确保客户端 ID 与签名密钥都存在 */
  ensureClientIdentity(): ClientIdentity {
    const key = this.ensureClientAgentKey();
    const secret = this.ensureClientAgentSecret();
    return { key, secret };
  }

  /** 读取 primary agent ID */
  getPrimaryAgent(): string | null {
    return this.getPreferences().primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId: string | null): void {
    const prefs = this.getPreferences();
    prefs.primaryAgent = agentId;
    this.savePreferences(prefs);
  }

  /** 找到 agents/ 目录下第一个合法的 agent */
  findFirstAgent(): string | null {
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
