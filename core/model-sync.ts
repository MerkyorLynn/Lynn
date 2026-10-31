/**
 * model-sync.js — added-models.yaml → models.json 单向投影
 *
 * 系统中唯一写 models.json 的地方。从 providers 配置（snake_case）
 * 投影为 Lynn runtime models.json 格式（camelCase），附加 known-models.json 元数据。
 */

import fs from "fs";
import { decryptApiKey } from "./provider-key-crypto.js";
import { isLocalBaseUrl } from "../shared/net-utils.js";
import { lookupKnown } from "../shared/known-models.js";
import type {
  ModelId,
  ModelsJsonModelEntry,
  ProviderConfigMap,
  ProviderId,
  ProviderModelConfig,
  ProviderModelsJsonMap,
  SyncModelsOptions,
} from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const ZAI_PROVIDER_IDS = new Set<ProviderId>(["zhipu", "glm", "glm-5", "zai", "z-ai"]);

type KnownModelMetadata = {
  name?: string;
  context?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
  thinkingFormat?: string;
  quirks?: string[];
};

/**
 * 模型 ID → 人类可读名
 * "doubao-seed-2-0-pro-260215" → "Doubao Seed 2.0 Pro"
 */
function humanizeName(id: ModelId): string {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

/** 从 auth.json entry 提取 API key（兼容多种格式） */
function extractApiKey(entry: unknown): string {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  if (typeof record.apiKey === "string") return record.apiKey;
  if (typeof record.access === "string") return record.access;
  if (typeof record.token === "string") return record.token;
  return "";
}

/**
 * 构建单个模型的 Lynn runtime 格式条目
 * @param {string|{id:string, name?:string, context?:number, maxOutput?:number}} modelEntry
 * @param {string} provider - provider 名称（查词典用）
 */
function buildModelEntry(modelEntry: ProviderModelConfig, provider: ProviderId): ModelsJsonModelEntry {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = isObj ? modelEntry.id : modelEntry;
  const known = lookupKnown(provider, id) as KnownModelMetadata | null;

  const explicitVision = isObj && typeof modelEntry.vision === "boolean" ? modelEntry.vision : undefined;
  const explicitReasoning = isObj && typeof modelEntry.reasoning === "boolean" ? modelEntry.reasoning : undefined;
  const vision = explicitVision ?? (known?.vision === true);
  const reasoning = explicitReasoning ?? (known?.reasoning === true);
  const entry: ModelsJsonModelEntry = {
    id,
    name: (isObj && modelEntry.name) || known?.name || humanizeName(id),
    input: vision ? ["text", "image"] : ["text"],
    contextWindow: (isObj && modelEntry.context) || known?.context || DEFAULT_CONTEXT_WINDOW,
    vision,
    reasoning,
  };

  const maxOutput = (isObj && modelEntry.maxOutput) || known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;

  if (known?.quirks?.length) entry.quirks = known.quirks;

  // Runtime compat 覆盖：
  // 1. 非 OpenAI provider 不发 developer role（dashscope 等不支持）
  // 2. Qwen reasoning 模型使用 enable_thinking
  // 3. 智谱 / GLM reasoning 模型使用 zai thinking 格式：thinking: { type: "enabled|disabled" }
  if (entry.reasoning && provider !== "openai") {
    const compat: NonNullable<ModelsJsonModelEntry["compat"]> = { supportsDeveloperRole: false };
    if (known?.thinkingFormat) {
      compat.thinkingFormat = known.thinkingFormat;
    } else if (entry.quirks?.includes("enable_thinking")) {
      compat.thinkingFormat = "qwen";
    } else if (ZAI_PROVIDER_IDS.has(provider)) {
      compat.thinkingFormat = "zai";
    }
    entry.compat = compat;
  }

  return entry;
}

/**
 * 单向投影：providers 配置 → models.json（Lynn runtime 格式）
 *
 * @param {Record<string, object>} providers - added-models.yaml 中的 providers 块（snake_case）
 * @param {object} [opts]
 * @param {string} opts.modelsJsonPath - models.json 输出路径
 * @param {string} [opts.authJsonPath] - auth.json 路径（OAuth 凭证查找用）
 * @param {Record<string, string>} [opts.oauthKeyMap] - providerId → auth.json key 映射
 * @returns {boolean} 内容是否有变化
 */
export function syncModels(
  providers: ProviderConfigMap,
  opts: SyncModelsOptions = {} as SyncModelsOptions,
): boolean {
  const modelsJsonPath = opts.modelsJsonPath;
  const authJsonPath = opts.authJsonPath;
  const oauthKeyMap = opts.oauthKeyMap || {};

  // 懒加载 auth.json（只在需要时读一次）
  let _authJson: Record<string, unknown> | undefined;
  function getAuthJson(): Record<string, unknown> {
    if (_authJson !== undefined) return _authJson;
    if (!authJsonPath) { _authJson = {}; return _authJson; }
    try {
      _authJson = (JSON.parse(fs.readFileSync(authJsonPath, "utf-8")) || {}) as Record<string, unknown>;
    } catch {
      _authJson = {};
    }
    return _authJson || {};
  }

  // 构建新的 providers 块
  const newProviders: ProviderModelsJsonMap = {};

  for (const [name, p] of Object.entries(providers || {})) {
    const providerId = name as ProviderId;
    if (!p.base_url) continue;
    if (!p.models || p.models.length === 0) continue;

    let apiKey = decryptApiKey(p.api_key || "", opts.lynnHome);
    const authType = p.auth_type || "api-key";

    // 无 api_key 时尝试 OAuth 查找
    if (!apiKey) {
      const authKey = oauthKeyMap[providerId] || providerId;
      apiKey = extractApiKey(getAuthJson()[authKey]);
    }

    // 无凭证且非 localhost，跳过
    const isLocal = isLocalBaseUrl(p.base_url);
    const allowMissingApiKey = authType === "none";
    if (!apiKey && !isLocal && !allowMissingApiKey) continue;

    // Runtime registry 目前要求 provider entry 带一个非空 apiKey；对无 Key 的内置远端 provider，
    // 用占位值保活 models.json，真实请求侧会依赖 Lynn 签名头鉴权。
    const effectiveApiKey = apiKey || "local";

    newProviders[providerId] = {
      baseUrl: p.base_url,
      api: p.api || "openai-completions",
      apiKey: effectiveApiKey,
      models: p.models.map(m => buildModelEntry(m, providerId)),
    };
  }

  const newJson = { providers: newProviders };
  const newStr = JSON.stringify(newJson, null, 4) + "\n";

  // 比较是否有变化
  let oldStr = "";
  try {
    oldStr = fs.readFileSync(modelsJsonPath, "utf-8");
  } catch {
    // 文件不存在，视为有变化
  }
  if (oldStr === newStr) return false;

  // 原子写入：先写 tmp 文件，再 rename
  const tmpPath = `${modelsJsonPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, newStr, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmpPath, modelsJsonPath);

  return true;
}
