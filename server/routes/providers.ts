/**
 * 供应商管理 REST 路由
 */
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { buildProviderAuthHeaders, buildProbeUrl } from "../../lib/llm/provider-client.js";
import { buildProviderSummaryStateSnapshot } from "../../core/provider-state-summary.js";

type ProviderModelConfig = string | {
  id?: string;
  name?: string;
  context?: number | null;
  maxOutput?: number | null;
  vision?: boolean | null;
  reasoning?: boolean | null;
  [key: string]: unknown;
};

type RawProviderConfig = {
  api_key?: string;
  base_url?: string;
  api?: string;
  auth_type?: string;
  display_name?: string;
  models?: ProviderModelConfig[];
  removed_models?: string[];
  [key: string]: unknown;
};

type ProviderSummary = {
  type: string;
  display_name: string;
  base_url: string;
  api: string;
  api_key: string;
  models: unknown[];
  custom_models: string[];
  removed_models: string[];
  has_credentials: boolean;
  credential_error?: string;
  logged_in?: boolean;
  supports_oauth: boolean;
  is_coding_plan: boolean;
  can_delete: boolean;
};

type ProviderRegistryEntry = {
  id?: string;
  displayName?: string;
  authType?: string;
  baseUrl?: string;
  api?: string;
  authJsonKey?: string;
};

type ProviderCredentials = {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
};

type OAuthProviderInfo = {
  id: string;
  name: string;
};

type OAuthCredential = {
  type?: string;
};

type OAuthLoginInfo = {
  name: string;
  loggedIn: boolean;
};

type SmokeResponsePayload = {
  error?: { message?: string };
  message?: string;
};

type RouteModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number | null;
  context?: number | null;
  maxOutputTokens?: number | null;
  maxOutput?: number | null;
};

type NormalizedModel = {
  id: string;
  name: string;
  context: number | null;
  maxOutput: number | null;
  vision?: boolean;
  reasoning?: boolean;
};

type ModelsCache = Record<string, {
  models?: NormalizedModel[];
  fetchedAt?: string | null;
}>;

type ProviderFetchModelsBody = {
  name?: string;
  base_url?: string;
  api?: string;
  api_key?: string;
};

type ProviderTestBody = {
  name?: string;
  base_url?: string;
  api?: string;
  api_key?: string;
  model_id?: unknown;
  modelId?: unknown;
  model?: unknown;
};

const SAVED_API_KEY_SENTINEL = "__saved__";

function sanitizeExplicitApiKey(value: unknown): string {
  const key = String(value || "").replace(/[^\x20-\x7E]/g, "").trim();
  return key === SAVED_API_KEY_SENTINEL ? "" : key;
}

type ProviderRegistryLike = {
  get(providerId: string): ProviderRegistryEntry | null | undefined;
  getAll(): Map<string, ProviderRegistryEntry>;
  getAllProvidersRaw(): Record<string, RawProviderConfig>;
  getOAuthProviderIds(): string[];
  getAuthJsonKey(providerId: string): string;
  getDefaultModels(providerId: string | undefined): string[];
  getCredentials(providerId: string): ProviderCredentials | null | undefined;
  isOAuth(providerId: string): boolean;
};

type AuthStorageLike = {
  getOAuthProviders?(): OAuthProviderInfo[];
  get(providerId: string): OAuthCredential | null | undefined;
  getApiKey(providerId: string): Promise<string | null | undefined> | string | null | undefined;
};

type PreferencesLike = {
  getOAuthCustomModels(): Record<string, string[] | undefined>;
};

type ModelRegistryLike = {
  getAll(): RouteModel[];
};

interface ProvidersRouteEngine {
  lynnHome: string;
  providerRegistry: ProviderRegistryLike;
  authStorage: AuthStorageLike;
  preferences: PreferencesLike;
  availableModels?: RouteModel[];
  modelRegistry?: ModelRegistryLike;
  refreshAvailableModels(): Promise<unknown> | unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Models-cache helpers ──

function getCachePath(engine: Pick<ProvidersRouteEngine, "lynnHome">): string {
  return path.join(engine.lynnHome, "models-cache.json");
}

function readModelsCache(engine: Pick<ProvidersRouteEngine, "lynnHome">): ModelsCache {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(engine), "utf-8")) as ModelsCache;
  } catch {
    return {};
  }
}

/** Atomic write: tmp + rename to avoid partial reads */
function writeModelsCache(engine: Pick<ProvidersRouteEngine, "lynnHome">, cache: ModelsCache): void {
  const target = getCachePath(engine);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + os.EOL);
  fs.renameSync(tmp, target);
}

export function createProvidersRoute(engine: ProvidersRouteEngine): Hono {
  const route = new Hono();

  function normalizeBaseUrl(value: unknown): string {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function resolveAllowMissingApiKey(name: string | undefined, baseUrl: unknown): boolean {
    if (name) {
      return engine.providerRegistry?.get?.(name)?.authType === "none";
    }
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) return false;
    return [...(engine.providerRegistry?.getAll?.()?.values?.() || [])].some((entry) => {
      return entry?.authType === "none" && normalizeBaseUrl(entry.baseUrl) === normalizedBaseUrl;
    });
  }

  // ── Cache helper: persist discovered models per-provider ──
  function saveToCache(providerName: string | undefined, models: NormalizedModel[]): void {
    if (!providerName || !models?.length) return;
    try {
      const cache = readModelsCache(engine);
      cache[providerName] = { models, fetchedAt: new Date().toISOString() };
      writeModelsCache(engine, cache);
    } catch { /* best-effort; cache miss is harmless */ }
  }

  // ── Provider Summary ──

  /**
   * 统一概览：合并 added-models.yaml + OAuth status + SDK 模型
   * 前端新 ProvidersTab 的核心数据源
   */
  route.get("/providers/summary", async (c) => {
    const rawProviders = engine.providerRegistry.getAllProvidersRaw();
    // 补全凭证和模型列表（getAllProvidersRaw 返回的是 added-models.yaml 原始数据）
    const providers: Record<string, RawProviderConfig> = {};
    for (const [name, p] of Object.entries(rawProviders)) {
      const entry = engine.providerRegistry.get(name);
      providers[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api_key: p.api_key || "",
        api: p.api || entry?.api || "",
        auth_type: p.auth_type || entry?.authType || "api-key",
        models: p.models || [],
        removed_models: Array.isArray(p.removed_models) ? p.removed_models : [],
      };
    }

    // ProviderRegistry 是 OAuth 判断的唯一权威
    // 只有在 ProviderRegistry 中注册为 authType:"oauth" 的 provider 才是 OAuth provider
    // Pi SDK 内置的危险 OAuth（anthropic/github-copilot 等）不在 Registry 中，不会泄露
    const provRegistry = engine.providerRegistry;

    // OAuth provider 登录状态（Pi SDK AuthStorage，key 是 authJsonKey）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map<string, OAuthLoginInfo>();
    for (const p of oauthProviders) {
      const cred = engine.authStorage?.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    // OAuth 自定义模型
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    // SDK 可用模型（含 OAuth 注入的）
    const sdkModels = engine.availableModels || [];
    const sdkByProvider = new Map<string, string[]>();
    for (const m of sdkModels) {
      if (!sdkByProvider.has(m.provider)) sdkByProvider.set(m.provider, []);
      sdkByProvider.get(m.provider)?.push(m.id);
    }

    const result: Record<string, ProviderSummary & { stateSnapshot: ReturnType<typeof buildProviderSummaryStateSnapshot> }> = {};

    // OAuth 登录信息查找（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name: string): OAuthLoginInfo | null {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name) || null;
      const authKey = provRegistry.getAuthJsonKey(name);
      if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey) || null;
      return null;
    }

    function withProviderState(
      name: string,
      summary: ProviderSummary,
      {
        rawProvider = null,
        registryEntry = null,
        isOAuth = false,
        loggedIn = false,
      }: {
        rawProvider?: RawProviderConfig | null;
        registryEntry?: ProviderRegistryEntry | null;
        isOAuth?: boolean;
        loggedIn?: boolean;
      } = {},
    ): ProviderSummary & { stateSnapshot: ReturnType<typeof buildProviderSummaryStateSnapshot> } {
      return {
        ...summary,
        stateSnapshot: buildProviderSummaryStateSnapshot({
          id: name,
          summary,
          rawProvider,
          registryEntry,
          isOAuth,
          loggedIn,
        }),
      };
    }

    // 先处理 added-models.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const rawProvider = rawProviders[name] || p;
      const registryEntry = provRegistry.get(name);
      const isOAuth = provRegistry.isOAuth(name);
      const oauthInfo = getOAuthLoginInfo(name);
      const sdkIds = sdkByProvider.get(name) || [];
      const defaultModels = provRegistry.getDefaultModels(name) || [];
      const savedModels = dedupeProviderModelEntries([...(p.models || [])]);
      const savedModelIds = new Set(savedModels.map(normalizeModelId).filter(Boolean));
      const removedModelIds = new Set(dedupeModelIds(p.removed_models || []));
      const customModels = dedupeModelIds([
        ...(oauthCustom[name] || []),
        ...defaultModels,
        ...sdkIds,
      ]).filter((id) => !savedModelIds.has(id) && !removedModelIds.has(id));
      const decryptedCreds = provRegistry.getCredentials?.(name);
      const hasSavedApiKey = decryptedCreds
        ? !!decryptedCreds.apiKey
        : !!p.api_key;
      const credentialError = p.api_key && !hasSavedApiKey ? "unreadable_api_key" : undefined;

      const summary: ProviderSummary = {
        type: isOAuth ? "oauth" : ((p.auth_type || registryEntry?.authType) === "none" ? "none" : "api-key"),
        display_name: oauthInfo?.name || p.display_name || registryEntry?.displayName || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key: hasSavedApiKey ? "__saved__" : "",
        models: savedModels,
        custom_models: customModels,
        removed_models: [...removedModelIds],
        has_credentials: ((p.auth_type || registryEntry?.authType) === "none")
          ? !!(p.base_url || registryEntry?.baseUrl)
          : !!(hasSavedApiKey || (isOAuth && oauthInfo?.loggedIn)),
        credential_error: credentialError,
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth,
        is_coding_plan: name.endsWith("-coding"),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
      result[name] = withProviderState(name, summary, {
        rawProvider,
        registryEntry,
        isOAuth,
        loggedIn: !!oauthInfo?.loggedIn,
      });
    }

    // 追加 OAuth-only provider。即使用户尚未登录，也必须显示授权入口；
    // 否则新用户会在「模型」页找不到 GPT/Codex 登录。
    // 只遍历 ProviderRegistry 中声明的 OAuth plugin，不暴露 SDK 内置 OAuth。
    for (const oauthId of provRegistry.getOAuthProviderIds()) {
      if (result[oauthId]) continue;
      const authKey = provRegistry.getAuthJsonKey(oauthId);
      const loginInfo = oauthLoginMap.get(authKey);
      const entry = provRegistry.get(oauthId);
      const sdkIds = sdkByProvider.get(authKey) || sdkByProvider.get(oauthId) || [];
      const defaultModels = provRegistry.getDefaultModels(oauthId) || [];
      const customModels = dedupeModelIds([
        ...(oauthCustom[authKey] || []),
        ...(oauthCustom[oauthId] || []),
        ...defaultModels,
        ...sdkIds,
      ]);
      const summary: ProviderSummary = {
        type: "oauth",
        display_name: loginInfo?.name || entry?.displayName || oauthId,
        base_url: entry?.baseUrl || "",
        api: entry?.api || "",
        api_key: "",
        models: [],
        custom_models: customModels,
        removed_models: [],
        has_credentials: !!loginInfo?.loggedIn,
        logged_in: !!loginInfo?.loggedIn,
        supports_oauth: true,
        is_coding_plan: false,
        can_delete: false,
      };
      result[oauthId] = withProviderState(oauthId, summary, {
        registryEntry: entry,
        isOAuth: true,
        loggedIn: !!loginInfo?.loggedIn,
      });
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        const sdkIds = sdkByProvider.get(id) || [];
        const defaultModels = provRegistry.getDefaultModels(id) || [];
        const customModels = dedupeModelIds([...defaultModels, ...sdkIds]);
        const summary: ProviderSummary = {
          type: entry.authType === "none" ? "none" : "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key: "",
          models: [],
          custom_models: customModels,
          removed_models: [],
          has_credentials: entry.authType === "none" ? !!entry.baseUrl : false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: id.endsWith("-coding"),
          can_delete: false,
        };
        result[id] = withProviderState(id, summary, {
          registryEntry: entry,
          isOAuth: false,
        });
      }
    }

    return c.json({ providers: result });
  });

  function buildBuiltinFallbackModels(providerName: string | undefined): NormalizedModel[] {
    if (!providerName) return [];
    const defaults = engine.providerRegistry?.getDefaultModels?.(providerName) || [];
    return defaults.map((id) => ({
      id,
      name: id,
      context: null,
      maxOutput: null,
    }));
  }

  function buildFetchFallback(providerName: string | undefined): { source: "builtin" | "cache"; models: NormalizedModel[] } | null {
    const builtinModels = buildBuiltinFallbackModels(providerName);
    if (builtinModels.length > 0) {
      saveToCache(providerName, builtinModels);
      return { source: "builtin", models: builtinModels };
    }

    if (providerName) {
      const cachedModels = readModelsCache(engine)?.[providerName]?.models || [];
      if (cachedModels.length > 0) {
        return { source: "cache", models: cachedModels };
      }
    }

    return null;
  }

  function normalizeModelId(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "object") {
      const record = value as { id?: unknown };
      if (typeof record.id === "string") return record.id.trim();
    }
    return String(value).trim();
  }

  function dedupeProviderModelEntries(values: unknown[]): unknown[] {
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const value of values) {
      const id = normalizeModelId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(value);
    }
    return result;
  }

  function dedupeModelIds(values: unknown[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const id = normalizeModelId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function resolveProviderSmokeModel(providerName: string | undefined, body: ProviderTestBody = {}): string {
    const explicit = normalizeModelId(body.model_id || body.modelId || body.model);
    if (explicit && explicit !== "test") return explicit;
    if (!providerName) return "";
    const rawProviders = engine.providerRegistry?.getAllProvidersRaw?.() || {};
    const savedModels = rawProviders[providerName]?.models || [];
    const savedModel = savedModels.map(normalizeModelId).find(Boolean);
    if (savedModel) return savedModel;
    const defaults = engine.providerRegistry?.getDefaultModels?.(providerName) || [];
    return defaults.map(normalizeModelId).find(Boolean) || "";
  }

  const PROVIDER_SMOKE_PROMPT = "Reply with OK only.";
  const PROVIDER_SMOKE_MAX_TOKENS = 128;

  async function runProviderChatSmoke({
    baseUrl,
    api,
    apiKey,
    allowMissingApiKey,
    modelId,
  }: {
    baseUrl: string;
    api: string;
    apiKey: string;
    allowMissingApiKey: boolean;
    modelId: string;
  }): Promise<{ ok: boolean; status: number; model: string; message: string } | null> {
    if (!modelId) return null;
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) return null;

    const base = String(baseUrl || "").replace(/\/+$/, "");
    const endpoint = api === "anthropic-messages"
      ? `${base}/v1/messages`
      : api === "openai-responses"
        ? `${base}/responses`
        : `${base}/chat/completions`;
    const pathname = api === "anthropic-messages"
      ? "/v1/messages"
      : api === "openai-responses"
        ? "/responses"
        : "/chat/completions";
    const headers = buildProviderAuthHeaders(api, apiKey, {
      allowMissingApiKey,
      method: "POST",
      pathname,
    }) as HeadersInit;
    const body = api === "anthropic-messages"
      ? {
          model: modelId,
          temperature: 0,
          max_tokens: PROVIDER_SMOKE_MAX_TOKENS,
          messages: [{ role: "user", content: PROVIDER_SMOKE_PROMPT }],
        }
      : api === "openai-responses"
        ? {
            model: modelId,
            temperature: 0,
            max_output_tokens: PROVIDER_SMOKE_MAX_TOKENS,
            input: [{ role: "user", content: PROVIDER_SMOKE_PROMPT }],
          }
        : {
            model: modelId,
            temperature: 0,
            max_tokens: PROVIDER_SMOKE_MAX_TOKENS,
            messages: [{ role: "user", content: PROVIDER_SMOKE_PROMPT }],
          };

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    let payload: SmokeResponsePayload | null = null;
    try {
      const text = await res.text();
      payload = text ? JSON.parse(text) as SmokeResponsePayload : null;
    } catch {
      payload = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      model: modelId,
      message: payload?.error?.message || payload?.message || `HTTP ${res.status}`,
    };
  }

  // ── Fetch / Test ──

  function normalizeRegistryModels(models: RouteModel[]): NormalizedModel[] {
    return models.map((model) => {
      const normalized: NormalizedModel = {
        id: model.id,
        name: model.name || model.id,
        context: model.contextWindow ?? model.context ?? null,
        maxOutput: model.maxOutputTokens ?? model.maxOutput ?? null,
      };
      if (typeof (model as { vision?: unknown }).vision === "boolean") {
        normalized.vision = (model as { vision?: boolean }).vision;
      }
      if (typeof (model as { reasoning?: unknown }).reasoning === "boolean") {
        normalized.reasoning = (model as { reasoning?: boolean }).reasoning;
      }
      return normalized;
    });
  }

  /**
   * 从供应商的 /v1/models (OpenAI 兼容) 端点拉取模型列表
   * body: { name, base_url, api, api_key? }
   */
  route.post("/providers/fetch-models", async (c) => {
    const body = await safeJson<ProviderFetchModelsBody>(c);
    const { name, base_url, api: explicitApi } = body;
    const api_key = sanitizeExplicitApiKey(body.api_key);
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
    }

    const savedProvider: RawProviderConfig = name ? (() => {
      const cred = engine.providerRegistry.getCredentials(name);
      if (!cred) return {};
      return { api_key: cred.apiKey, base_url: cred.baseUrl, api: cred.api };
    })() : {};
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const sameSavedBase = effectiveBaseUrl.replace(/\/+$/, "") === String(savedProvider.base_url || "").replace(/\/+$/, "");
    const savedKey = sameSavedBase ? savedProvider.api_key || "" : "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    const allowMissingApiKey = resolveAllowMissingApiKey(name, effectiveBaseUrl);
    const hasExplicitRemoteConfig = !!(effectiveBaseUrl && effectiveApi && (api_key || savedKey));

    const isOAuthProvider = !!name && engine.providerRegistry.isOAuth(name);

    if (isOAuthProvider && !hasExplicitRemoteConfig) {
      try {
        await engine.refreshAvailableModels();
        // Pi SDK 用 authJsonKey 作为 model.provider，需要两个 ID 都匹配
        const authKey = engine.providerRegistry.getAuthJsonKey(name);
        const registryModels = (engine.availableModels || []).filter(
          (model) => model.provider === name || model.provider === authKey,
        );
        if (registryModels.length > 0) {
          const normalized = normalizeRegistryModels(registryModels);
          saveToCache(name, normalized);
          return c.json({ source: "registry", models: normalized });
        }

        return c.json({
          error: `Pi registry has no available models for provider "${name}" yet. Please finish login or re-login, then try again.`,
          models: [],
        });
      } catch (err) {
        return c.json({ error: errorMessage(err), models: [] });
      }
    }

    if (!base_url) {
      return c.json({ error: "base_url is required for remote model fetch" }, 400);
    }

    // 解析 api_key：显式传入 > providers 块 > auth.json OAuth token
    let key = api_key || "";
    if (!key && name) {
      key = savedKey;
    }
    // OAuth provider fallback：从 AuthStorage 获取 token
    if (!key && name) {
      try {
        key = await engine.authStorage.getApiKey(name) || "";
      } catch {
        // Missing stored credentials simply fall through to unauthenticated model listing.
      }
    }

    // Anthropic 格式没有 /models 端点，从 Pi SDK registry 或 default-models.json 返回
    if (effectiveApi === "anthropic-messages") {
      const registryModels = engine.modelRegistry
        ? engine.modelRegistry.getAll().filter((m) => m.provider === name)
        : [];
      if (registryModels.length > 0) {
        const normalized = normalizeRegistryModels(registryModels);
        saveToCache(name, normalized);
        return c.json({ source: "registry", models: normalized });
      }
      // fallback：从 default-models.json 返回默认模型列表
      const defaults = engine.providerRegistry?.getDefaultModels(name) || [];
      if (defaults.length > 0) {
        const builtinModels = defaults.map(id => ({ id, name: id, context: null, maxOutput: null }));
        saveToCache(name, builtinModels);
        return c.json({ source: "builtin", models: builtinModels });
      }
      return c.json({ error: "No built-in models found for this provider", models: [] });
    }

    try {
      const url = effectiveBaseUrl.replace(/\/+$/, "") + "/models";
      let headers: HeadersInit = { "Content-Type": "application/json" };
      if (key || allowMissingApiKey) {
        if (!effectiveApi) {
          return c.json({ error: "api is required", models: [] });
        }
        headers = buildProviderAuthHeaders(effectiveApi, key, {
          allowMissingApiKey,
          method: "GET",
          pathname: "/models",
        }) as HeadersInit;
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const fallback = buildFetchFallback(name);
        if (fallback) return c.json(fallback);
        return c.json({ error: `HTTP ${res.status}: ${res.statusText}`, models: [] });
      }

      const data = await res.json() as {
        data?: Array<{
          id: string;
          context_length?: number;
          context_window?: number;
          max_context_length?: number;
          max_completion_tokens?: number;
          max_output_tokens?: number;
        }>;
      };
      // OpenAI 兼容格式：{ data: [{ id, ... }] }
      // 尝试从返回里抓取上下文长度和最大输出（各 provider 扩展字段不同）
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        context: m.context_length || m.context_window || m.max_context_length || null,
        maxOutput: m.max_completion_tokens || m.max_output_tokens || null,
      }));

      if (models.length === 0) {
        const fallback = buildFetchFallback(name);
        if (fallback) return c.json(fallback);
      }

      saveToCache(name, models);
      return c.json({ models });
    } catch (err) {
      const fallback = buildFetchFallback(name);
      if (fallback) return c.json(fallback);
      return c.json({ error: errorMessage(err), models: [] });
    }
  });

  /**
   * 读取供应商已发现但尚未添加的模型（缓存）
   * GET /api/providers/:name/discovered-models
   */
  route.get("/providers/:name/discovered-models", (c) => {
    const providerName = c.req.param("name");
    const cache = readModelsCache(engine);
    const entry = cache[providerName];
    if (!entry) return c.json({ models: [], fetchedAt: null });
    return c.json({ models: entry.models || [], fetchedAt: entry.fetchedAt || null });
  });

  /**
   * 测试供应商连接
   * body: { base_url, api, api_key }
   */
  route.post("/providers/test", async (c) => {
    const body = await safeJson<ProviderTestBody>(c);
    const { name } = body;
    const base_url = String(body.base_url || "").trim();
    const explicitApi = String(body.api || "").trim();
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const explicitApiKey = sanitizeExplicitApiKey(body.api_key);
    const savedProvider: RawProviderConfig = name ? (() => {
      const cred = engine.providerRegistry.getCredentials(name);
      if (!cred) return {};
      return { api_key: cred.apiKey, base_url: cred.baseUrl, api: cred.api };
    })() : {};
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    const sameSavedBase = effectiveBaseUrl.replace(/\/+$/, "") === String(savedProvider.base_url || "").replace(/\/+$/, "");
    let effectiveApiKey = explicitApiKey || (sameSavedBase ? savedProvider.api_key : "") || "";
    if (!effectiveBaseUrl) {
      return c.json({ error: "base_url is required" }, 400);
    }

    try {
      const allowMissingApiKey = resolveAllowMissingApiKey(name, effectiveBaseUrl);
      if (!effectiveApiKey && name && sameSavedBase) {
        try {
          effectiveApiKey = await engine.authStorage.getApiKey(name) || "";
        } catch {
          // Missing stored credentials simply fall through to explicit credentials.
        }
      }
      const probe = buildProbeUrl(effectiveBaseUrl, effectiveApi);
      const pathname = (() => {
        try {
          return new URL(probe.url).pathname || "/models";
        } catch {
          return probe.method === "POST" ? "/v1/messages" : "/models";
        }
      })();

      if (effectiveApi === "anthropic-messages") {
        const smoke = await runProviderChatSmoke({
          baseUrl: effectiveBaseUrl,
          api: effectiveApi,
          apiKey: effectiveApiKey,
          allowMissingApiKey,
          modelId: resolveProviderSmokeModel(name, body),
        });
        if (smoke) {
          return c.json(smoke.ok
            ? { ok: true, status: smoke.status, model: smoke.model }
            : { ok: false, status: smoke.status, model: smoke.model, error: smoke.message });
        }
        return c.json({ ok: false, error: "No model available for smoke test" });
      }

      let headers: HeadersInit = {};
      if (effectiveApiKey || allowMissingApiKey) {
        if (!effectiveApi) {
          return c.json({ error: "api is required when api_key is present" }, 400);
        }
        headers = buildProviderAuthHeaders(effectiveApi, effectiveApiKey, {
          allowMissingApiKey,
          method: probe.method,
          pathname,
        }) as HeadersInit;
      }
      const res = await fetch(probe.url, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      // /models 返回 401/403 说明 key 无效
      if (res.status === 401 || res.status === 403) {
        return c.json({ ok: false, status: res.status });
      }
      if (res.ok) {
        const smoke = await runProviderChatSmoke({
          baseUrl: effectiveBaseUrl,
          api: effectiveApi,
          apiKey: effectiveApiKey,
          allowMissingApiKey,
          modelId: resolveProviderSmokeModel(name, body),
        });
        if (smoke) {
          return c.json(smoke.ok
            ? { ok: true, status: smoke.status, model: smoke.model }
            : { ok: false, status: smoke.status, model: smoke.model, error: smoke.message });
        }
        return c.json({ ok: true, status: res.status });
      }
      // /models 端点不存在或不可用（404/405/500 等），回退到 chat completions 探测
      if (effectiveApi === "openai-completions" || effectiveApi === "openai-responses") {
        try {
          const smoke = await runProviderChatSmoke({
            baseUrl: effectiveBaseUrl,
            api: effectiveApi,
            apiKey: effectiveApiKey,
            allowMissingApiKey,
            modelId: resolveProviderSmokeModel(name, body),
          });
          if (smoke) {
            return c.json(smoke.ok
              ? { ok: true, status: smoke.status, model: smoke.model }
              : { ok: false, status: smoke.status, model: smoke.model, error: smoke.message });
          }
        } catch {
          // 回退探测也失败，返回原始 /models 结果
        }
      }
      return c.json({ ok: res.ok, status: res.status });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) });
    }
  });

  return route;
}
