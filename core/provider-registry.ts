/**
 * ProviderRegistry — 声明式 provider 插件注册表
 *
 * 职责：
 *   - 管理所有已知 provider 的静态声明（能力、协议、认证类型）
 *   - 将插件声明与 added-models.yaml 用户配置合并为 ProviderEntry
 *   - 读取 provider 凭证（api_key / base_url / api）
 *   - 管理 provider 的模型列表（CRUD + 持久化）
 *
 * 设计来源：OpenClaw 的插件注册表模式
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { encryptApiKey as _encryptKey, decryptApiKey as _decryptKey } from "./provider-key-crypto.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { fromRoot } from "../shared/lynn-root.js";
import type {
  ModelId,
  ProviderConfig,
  ProviderConfigMap,
  ProviderCredentials,
  ProviderEntry,
  ProviderId,
  ProviderModelConfig,
  ProviderModelEntry,
  ProviderPlugin,
} from "./types.js";

type SafeReadYamlSync = (filePath: string, fallback: unknown, yaml: typeof YAML) => unknown;
const readYamlSync = safeReadYAMLSync as SafeReadYamlSync;
const SAVED_API_KEY_SENTINEL = "__saved__";

// API Key encryption (_encryptKey / _decryptKey) now lives in provider-key-crypto.ts — see the
// #74 fix (stable seed instead of the drifting os.hostname()).

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
) as Record<string, ModelId[]>;

// ── 内置插件 ────────────────────────────────────────────────────────────────

import { dashscopePlugin } from "../lib/providers/dashscope.js";
import { brainPlugin } from "../lib/providers/brain.js";
import { localQwen35Plugin } from "../lib/providers/local-qwen35.js";
import { openaiPlugin } from "../lib/providers/openai.js";
import { anthropicPlugin } from "../lib/providers/anthropic.js";
import { deepseekPlugin } from "../lib/providers/deepseek.js";
import { geminiPlugin } from "../lib/providers/gemini.js";
import { openrouterPlugin } from "../lib/providers/openrouter.js";
import { ollamaPlugin } from "../lib/providers/ollama.js";
import { minimaxPlugin } from "../lib/providers/minimax.js";
import { minimaxOAuthPlugin } from "../lib/providers/minimax-oauth.js";
import { openaiCodexOAuthPlugin } from "../lib/providers/openai-codex-oauth.js";
// 中国
import { siliconflowPlugin } from "../lib/providers/siliconflow.js";
import { zhipuPlugin } from "../lib/providers/zhipu.js";
import { moonshotPlugin } from "../lib/providers/moonshot.js";
import { baichuanPlugin } from "../lib/providers/baichuan.js";
import { stepfunPlugin } from "../lib/providers/stepfun.js";
import { volcenginePlugin } from "../lib/providers/volcengine.js";
import { hunyuanPlugin } from "../lib/providers/hunyuan.js";
import { baiduCloudPlugin } from "../lib/providers/baidu-cloud.js";
import { modelscopePlugin } from "../lib/providers/modelscope.js";
import { infiniPlugin } from "../lib/providers/infini.js";
// 国际
import { groqPlugin } from "../lib/providers/groq.js";
import { togetherPlugin } from "../lib/providers/together.js";
import { fireworksPlugin } from "../lib/providers/fireworks.js";
import { mistralPlugin } from "../lib/providers/mistral.js";
import { perplexityPlugin } from "../lib/providers/perplexity.js";
import { xaiPlugin } from "../lib/providers/xai.js";
// Coding Plan
import { dashscopeCodingPlugin } from "../lib/providers/dashscope-coding.js";
import { kimiCodingPlugin } from "../lib/providers/kimi-coding.js";
import { minimaxCodingPlugin } from "../lib/providers/minimax-coding.js";
import { zhipuCodingPlugin } from "../lib/providers/zhipu-coding.js";
import { stepfunCodingPlugin } from "../lib/providers/stepfun-coding.js";
import { tencentCodingPlugin } from "../lib/providers/tencent-coding.js";
import { volcegineCodingPlugin } from "../lib/providers/volcengine-coding.js";

const BUILTIN_PLUGINS = [
  brainPlugin,
  localQwen35Plugin,
  dashscopePlugin,
  openaiPlugin,
  anthropicPlugin,
  deepseekPlugin,
  geminiPlugin,
  openrouterPlugin,
  ollamaPlugin,
  minimaxPlugin,
  minimaxOAuthPlugin,
  openaiCodexOAuthPlugin,
  // 中国
  siliconflowPlugin,
  zhipuPlugin,
  moonshotPlugin,
  baichuanPlugin,
  stepfunPlugin,
  volcenginePlugin,
  hunyuanPlugin,
  baiduCloudPlugin,
  modelscopePlugin,
  infiniPlugin,
  // 国际
  groqPlugin,
  togetherPlugin,
  fireworksPlugin,
  mistralPlugin,
  perplexityPlugin,
  xaiPlugin,
  // Coding Plan
  dashscopeCodingPlugin,
  kimiCodingPlugin,
  minimaxCodingPlugin,
  zhipuCodingPlugin,
  stepfunCodingPlugin,
  tencentCodingPlugin,
  volcegineCodingPlugin,
];

// ── ProviderRegistry ─────────────────────────────────────────────────────────

export class ProviderRegistry {
  _lynnHome: string;
  _plugins: Map<ProviderId, ProviderPlugin>;
  _entries: Map<ProviderId, ProviderEntry>;

  /**
   * @param {string} lynnHome - 用户数据根目录（如 ~/.lynn-dev）
   */
  constructor(lynnHome: string) {
    this._lynnHome = lynnHome;
    /** @type {Map<ProviderId, ProviderPlugin>} id → plugin */
    this._plugins = new Map();
    /** @type {Map<ProviderId, ProviderEntry>} id → entry（合并后） */
    this._entries = new Map();

    // 注册内置插件
    for (const plugin of BUILTIN_PLUGINS) {
      this._plugins.set(plugin.id, plugin);
    }
  }

  _canonicalProviderId(providerId: ProviderId | string): ProviderId {
    const raw = String(providerId || "").trim() as ProviderId;
    if (!raw) return raw;
    const lower = raw.toLowerCase();
    for (const id of this._plugins.keys()) {
      if (String(id).toLowerCase() === lower) return id;
    }
    return lower as ProviderId;
  }

  _modelEntryId(model: ProviderModelConfig | undefined): string {
    if (!model) return "";
    return typeof model === "object" ? String(model.id || "") : String(model || "");
  }

  _mergeStringLists(...lists: unknown[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const value of list) {
        const id = String(value || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }
    }
    return merged;
  }

  _hasUsableApiKey(apiKey: unknown): boolean {
    if (typeof apiKey !== "string" || !apiKey.trim()) return false;
    if (!apiKey.startsWith("enc:")) return true;
    return !!_decryptKey(apiKey, this._lynnHome);
  }

  _mergeProviderConfig(base: ProviderConfig, incoming: ProviderConfig): ProviderConfig {
    const baseHasUsableKey = this._hasUsableApiKey(base?.api_key);
    const incomingHasUsableKey = this._hasUsableApiKey(incoming?.api_key);
    const preferIncomingConfig = incomingHasUsableKey && !baseHasUsableKey;
    const merged: ProviderConfig = preferIncomingConfig ? { ...incoming } : { ...base };
    const fillSource = preferIncomingConfig ? base : incoming;

    for (const [key, value] of Object.entries(fillSource || {})) {
      if (key === "models" || key === "removed_models") continue;
      if (key === "api_key") {
        if (!this._hasUsableApiKey(merged.api_key) && this._hasUsableApiKey(value)) {
          merged.api_key = value as string;
        }
        continue;
      }
      const current = merged[key];
      if (current === undefined || current === null || current === "") {
        merged[key] = value;
      }
    }

    const nextModels: ProviderModelConfig[] = [];
    const seen = new Set<string>();
    for (const model of [
      ...((Array.isArray(base.models) ? base.models : []) as ProviderModelConfig[]),
      ...((Array.isArray(incoming.models) ? incoming.models : []) as ProviderModelConfig[]),
    ]) {
      const id = this._modelEntryId(model);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nextModels.push(model);
    }
    if (nextModels.length > 0) merged.models = nextModels;
    const removedModels = this._mergeStringLists(base.removed_models, incoming.removed_models)
      .filter((id) => !seen.has(id));
    if (removedModels.length > 0) merged.removed_models = removedModels;
    else delete merged.removed_models;
    return merged;
  }

  _normalizeProviderConfigMap(providers: ProviderConfigMap): { providers: ProviderConfigMap; changed: boolean } {
    const normalized: ProviderConfigMap = {};
    let changed = false;

    for (const [rawId, config] of Object.entries(providers || {})) {
      const canonicalId = this._canonicalProviderId(rawId);
      if (canonicalId !== rawId) changed = true;
      const incoming = (config && typeof config === "object" ? config : {}) as ProviderConfig;
      if (normalized[canonicalId]) {
        normalized[canonicalId] = this._mergeProviderConfig(normalized[canonicalId], incoming);
        changed = true;
      } else {
        normalized[canonicalId] = { ...incoming };
      }
    }

    return { providers: normalized, changed };
  }

  /**
   * 注册 provider 插件
   * 同一 id 注册两次会覆盖（方便测试/扩展）
   * @param {ProviderPlugin} plugin
   */
  register(plugin: ProviderPlugin): void {
    if (!plugin?.id) throw new Error("ProviderPlugin must have an id");
    this._plugins.set(plugin.id, plugin);
    // 让 reload() 在下次调用时重新合并
    this._entries.delete(plugin.id);
  }

  /**
   * 从 _lynnHome 直接读 added-models.yaml（不走全局 config-loader）
   * @returns {Record<ProviderId, ProviderConfig>}
   */
  _loadAddedModels(): ProviderConfigMap {
    const ymlPath = path.join(this._lynnHome, "added-models.yaml");
    const raw = (readYamlSync(ymlPath, {}, YAML) || {}) as { providers?: ProviderConfigMap };
    const { providers, changed } = this._normalizeProviderConfigMap(raw.providers || {});
    if (changed) {
      try {
        this._saveAddedModels(providers);
      } catch {
        // A failed self-heal must not prevent settings from loading. The next explicit save will retry.
      }
    }
    return providers;
  }

  /**
   * 将 providers 对象写入 _lynnHome/added-models.yaml
   * @param {Record<ProviderId, ProviderConfig>} providers
   */
  _saveAddedModels(providers: ProviderConfigMap): void {
    const ymlPath = path.join(this._lynnHome, "added-models.yaml");
    // 读取现有文件以保留 _migrated 等顶层元数据
    const existing = (readYamlSync(ymlPath, {}, YAML) || {}) as Record<string, unknown>;
    const header =
      "# Lynn 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    const data = { ...existing, providers };
    // Encrypt API keys before persisting
    if (data.providers) {
      for (const prov of Object.values(data.providers) as ProviderConfig[]) {
        if (prov?.api_key === SAVED_API_KEY_SENTINEL) {
          delete prov.api_key;
        }
        if (prov && typeof prov === "object" && prov.api_key && !prov.api_key.startsWith("enc:")) {
          prov.api_key = _encryptKey(prov.api_key, this._lynnHome);
        }
      }
    }
    const yamlStr = header + YAML.dump(data, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "\"",
      forceQuotes: false,
    });
    const tmpPath = ymlPath + ".tmp";
    fs.writeFileSync(tmpPath, yamlStr, "utf-8");
    fs.renameSync(tmpPath, ymlPath);
    try { fs.chmodSync(ymlPath, 0o600); } catch {}
  }

  /**
   * 从 added-models.yaml 加载用户配置，与所有插件声明合并
   * 每次 added-models.yaml 变更后调用
   */
  reload(): void {
    this._entries.clear();
    const userConfig = this._loadAddedModels();

    // 1. 先处理所有已注册插件（内置 + 外部注册的）
    for (const [id, plugin] of this._plugins) {
      const uc = userConfig[id] || {};
      this._entries.set(id, this._merge(plugin, uc, true));
    }

    // 2. 处理 added-models.yaml 中有但没有对应插件的条目（用户自定义 provider）
    for (const [id, uc] of Object.entries(userConfig)) {
      if (this._entries.has(id)) continue;
      // 没有插件声明，从配置推断
      const syntheticPlugin: ProviderPlugin = {
        id,
        displayName: uc.display_name || id,
        authType: uc.auth_type || "api-key",
        defaultBaseUrl: uc.base_url || "",
        defaultApi: uc.api || "openai-completions",
      };
      this._entries.set(id, this._merge(syntheticPlugin, uc, false));
    }
  }

  /**
   * 合并插件声明和用户配置
   * @param {ProviderPlugin} plugin
   * @param {ProviderConfig} userConfig
   * @param {boolean} isBuiltin
   * @returns {ProviderEntry}
   * @private
   */
  _merge(plugin: ProviderPlugin, userConfig: ProviderConfig, isBuiltin: boolean): ProviderEntry {
    return {
      id: plugin.id,
      displayName: userConfig.display_name || plugin.displayName,
      displayNameEn: plugin.displayNameEn,
      authType: userConfig.auth_type || plugin.authType,
      baseUrl: userConfig.base_url || plugin.defaultBaseUrl,
      api: userConfig.api || plugin.defaultApi,
      authJsonKey: plugin.authJsonKey || plugin.id,
      isBuiltin,
    };
  }

  /**
   * 获取所有 provider entry（已合并）
   * @returns {Map<ProviderId, ProviderEntry>}
   */
  getAll(): Map<ProviderId, ProviderEntry> {
    if (this._entries.size === 0) this.reload();
    return this._entries;
  }

  /**
   * 获取单个 provider entry
   * @param {ProviderId} providerId
   * @returns {ProviderEntry|null}
   */
  get(providerId: ProviderId): ProviderEntry | null {
    if (this._entries.size === 0) this.reload();
    const canonicalId = this._canonicalProviderId(providerId);
    const direct = this._entries.get(canonicalId);
    if (direct) return direct;
    // 反向查找：providerId 可能是某个 OAuth provider 的 authJsonKey
    // 如 "openai-codex" → "openai-codex-oauth"
    for (const entry of this._entries.values()) {
      if (entry.authJsonKey === providerId && entry.id !== providerId) return entry;
    }
    return null;
  }

  /**
   * 批量获取 provider entry
   * @param {ProviderId[]} providerIds
   * @returns {Map<ProviderId, ProviderEntry>}
   */
  getBatch(providerIds: ProviderId[]): Map<ProviderId, ProviderEntry> {
    const result = new Map<ProviderId, ProviderEntry>();
    for (const id of providerIds) {
      const entry = this.get(id);
      if (entry) result.set(id, entry);
    }
    return result;
  }

  /**
   * 列出所有 authType 为 "oauth" 的 provider id
   * @returns {ProviderId[]}
   */
  getOAuthProviderIds(): ProviderId[] {
    const all = this.getAll();
    return [...all.values()]
      .filter(e => e.authType === "oauth")
      .map(e => e.id);
  }

  /**
   * 获取 OAuth provider 在 auth.json 中的实际 key
   * （部分 provider 的 authJsonKey 与 id 不同，如 minimax-oauth → minimax）
   * @param {ProviderId} providerId
   * @returns {ProviderId}
   */
  getAuthJsonKey(providerId: ProviderId): ProviderId {
    return this.get(providerId)?.authJsonKey || providerId;
  }

  /**
   * 获取某 provider 的默认模型列表（来自 lib/default-models.json）
   * @param {ProviderId} providerId
   * @returns {ModelId[]}
   */
  getDefaultModels(providerId: ProviderId): ModelId[] {
    return _defaultModels[this._canonicalProviderId(providerId)] || [];
  }

  /**
   * 更新 provider 的用户配置（写 added-models.yaml）
   * 只更新非凭证字段（base_url / api / display_name / auth_type）
   * @param {ProviderId} providerId
   * @param {Pick<ProviderConfig, "base_url" | "api" | "display_name" | "auth_type">} overrides
   */
  setUserConfig(
    providerId: ProviderId,
    overrides: Pick<ProviderConfig, "base_url" | "api" | "display_name" | "auth_type">,
  ): void {
    const canonicalId = this._canonicalProviderId(providerId);
    const userConfig = this._loadAddedModels();
    userConfig[canonicalId] = { ...(userConfig[canonicalId] || {}), ...overrides };
    this._saveAddedModels(userConfig);
    // 更新内存中的 entry
    this._entries.delete(canonicalId);
    if (this._plugins.has(canonicalId)) {
      const plugin = this._plugins.get(canonicalId);
      if (plugin) this._entries.set(canonicalId, this._merge(plugin, userConfig[canonicalId], true));
    } else {
      this.reload(); // 自定义 provider 走完整 reload
    }
  }

  /**
   * 删除一个 provider（仅从 added-models.yaml，内置插件的插件声明保留）
   * @param {ProviderId} providerId
   */
  remove(providerId: ProviderId): void {
    const canonicalId = this._canonicalProviderId(providerId);
    const userConfig = this._loadAddedModels();
    if (!Object.prototype.hasOwnProperty.call(userConfig, canonicalId)) return;
    delete userConfig[canonicalId];
    this._saveAddedModels(userConfig);
    this._entries.delete(canonicalId);
    // 如果有内置插件声明，以默认值重建 entry
    if (this._plugins.has(canonicalId)) {
      const plugin = this._plugins.get(canonicalId);
      if (plugin) this._entries.set(canonicalId, this._merge(plugin, {}, true));
    }
  }

  /**
   * 检查某个 id 是否是已知的 OAuth provider
   * @param {ProviderId} providerId
   */
  isOAuth(providerId: ProviderId): boolean {
    return this.get(providerId)?.authType === "oauth";
  }

  // ── credential read + model CRUD ──────────────────────────────────────────

  /**
   * 读取 provider 的凭证信息（apiKey, baseUrl, api）
   * 从 added-models.yaml 读取用户配置值，baseUrl/api 不存在时回退到插件默认值
   * @param {ProviderId} providerId
   * @returns {ProviderCredentials | null}
   */
  getCredentials(providerId: ProviderId): ProviderCredentials | null {
    const userConfig = this._loadAddedModels();
    const canonicalId = this._canonicalProviderId(providerId);
    const uc = userConfig[canonicalId];
    if (!uc) return null;

    const plugin = this._plugins.get(canonicalId);
    return {
      apiKey: _decryptKey(uc.api_key, this._lynnHome) || "",
      baseUrl: uc.base_url || plugin?.defaultBaseUrl || "",
      api: uc.api || plugin?.defaultApi || "",
    };
  }

  /**
   * 读取某 provider 在 added-models.yaml 中的模型 ID 列表
   * 模型条目可以是字符串或 {id, name?, context?, maxOutput?} 对象，统一提取 id
   * @param {ProviderId} providerId
   * @returns {ModelId[]}
   */
  getProviderModels(providerId: ProviderId): ModelId[] {
    const userConfig = this._loadAddedModels();
    const uc = userConfig[this._canonicalProviderId(providerId)];
    if (!uc?.models || !Array.isArray(uc.models)) return [];
    return uc.models.map((m) => (typeof m === "object" ? m.id : m));
  }

  /**
   * 返回 added-models.yaml 的原始数据（不经过插件合并）
   * @returns {Record<ProviderId, ProviderConfig>}
   */
  getAllProvidersRaw(): ProviderConfigMap {
    return this._loadAddedModels();
  }

  /**
   * 向某 provider 的 models 列表添加一个模型，立即持久化
   * 不会添加重复项（按 id 判断）
   * @param {ProviderId} providerId
   * @param {ModelId | ProviderModelEntry} model
   */
  addModel(providerId: ProviderId, model: ModelId | ProviderModelEntry): void {
    const canonicalId = this._canonicalProviderId(providerId);
    const userConfig = this._loadAddedModels();
    if (!userConfig[canonicalId]) userConfig[canonicalId] = {};
    if (!Array.isArray(userConfig[canonicalId].models)) {
      userConfig[canonicalId].models = [];
    }

    const newId = typeof model === "object" ? model.id : model;
    const exists = userConfig[canonicalId].models.some(
      (m) => (typeof m === "object" ? m.id : m) === newId,
    );
    if (exists) return;

    userConfig[canonicalId].models.push(model);
    if (Array.isArray(userConfig[canonicalId].removed_models)) {
      userConfig[canonicalId].removed_models = userConfig[canonicalId].removed_models?.filter((id) => id !== newId);
      if (userConfig[canonicalId].removed_models?.length === 0) delete userConfig[canonicalId].removed_models;
    }
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
   * 从某 provider 的 models 列表移除一个模型（按 id 匹配），立即持久化
   * @param {ProviderId} providerId
   * @param {ModelId} modelId
   */
  removeModel(providerId: ProviderId, modelId: ModelId): void {
    const userConfig = this._loadAddedModels();
    const uc = userConfig[this._canonicalProviderId(providerId)];
    if (!uc?.models || !Array.isArray(uc.models)) return;

    uc.models = uc.models.filter(
      (m) => (typeof m === "object" ? m.id : m) !== modelId,
    );
    uc.removed_models = this._mergeStringLists(uc.removed_models, [modelId]);
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
   * 创建或更新一个 provider 条目（合并写入 added-models.yaml）
   * @param {ProviderId} providerId
   * @param {ProviderConfig} data - 要写入的字段（api_key, base_url, api, models 等）
   */
  saveProvider(providerId: ProviderId, data: ProviderConfig): void {
    const canonicalId = this._canonicalProviderId(providerId);
    const userConfig = this._loadAddedModels();
    const nextData = { ...data };
    const existing = userConfig[canonicalId] || {};
    if (nextData.api_key === SAVED_API_KEY_SENTINEL) {
      delete nextData.api_key;
    }
    if (
      Array.isArray(nextData.models)
      && nextData.models.length === 0
      && Array.isArray(existing.models)
      && existing.models.length > 0
    ) {
      delete nextData.models;
    }
    userConfig[canonicalId] = { ...existing, ...nextData };
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
   * 删除一个 provider（remove 的显式别名）
   * @param {ProviderId} providerId
   */
  removeProvider(providerId: ProviderId): void {
    this.remove(providerId);
  }
}
