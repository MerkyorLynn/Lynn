/**
 * 供应商管理 REST 路由
 */
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { buildProviderAuthHeaders, buildProbeUrl } from "../../lib/llm/provider-client.js";

// ── Models-cache helpers ──

function getCachePath(engine) {
  return path.join(engine.lynnHome, "models-cache.json");
}

function readModelsCache(engine) {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(engine), "utf-8"));
  } catch {
    return {};
  }
}

/** Atomic write: tmp + rename to avoid partial reads */
function writeModelsCache(engine, cache) {
  const target = getCachePath(engine);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + os.EOL);
  fs.renameSync(tmp, target);
}

export function createProvidersRoute(engine) {
  const route = new Hono();

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function resolveAllowMissingApiKey(name, baseUrl) {
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
  function saveToCache(providerName, models) {
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
    const providers = {};
    for (const [name, p] of Object.entries(rawProviders)) {
      const entry = engine.providerRegistry.get(name);
      providers[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api_key: p.api_key || "",
        api: p.api || entry?.api || "",
        auth_type: p.auth_type || entry?.authType || "api-key",
        models: p.models || [],
      };
    }

    // ProviderRegistry 是 OAuth 判断的唯一权威
    // 只有在 ProviderRegistry 中注册为 authType:"oauth" 的 provider 才是 OAuth provider
    // Pi SDK 内置的危险 OAuth（anthropic/github-copilot 等）不在 Registry 中，不会泄露
    const provRegistry = engine.providerRegistry;

    // OAuth provider 登录状态（Pi SDK AuthStorage，key 是 authJsonKey）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    // OAuth 自定义模型
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    // SDK 可用模型（含 OAuth 注入的）
    const sdkModels = engine.availableModels || [];
    const sdkByProvider = new Map();
    for (const m of sdkModels) {
      if (!sdkByProvider.has(m.provider)) sdkByProvider.set(m.provider, []);
      sdkByProvider.get(m.provider).push(m.id);
    }

    const result = {};

    // OAuth 登录信息查找（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      const authKey = provRegistry.getAuthJsonKey(name);
      if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      return null;
    }

    // 先处理 added-models.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = provRegistry.isOAuth(name);
      const oauthInfo = getOAuthLoginInfo(name);
      const sdkIds = sdkByProvider.get(name) || [];
      const defaultModels = provRegistry.getDefaultModels(name) || [];
      const allModels = [...new Set([...(p.models || []), ...defaultModels, ...sdkIds])];
      const customModels = oauthCustom[name] || [];

      result[name] = {
        type: isOAuth ? "oauth" : ((p.auth_type || provRegistry.get(name)?.authType) === "none" ? "none" : "api-key"),
        display_name: oauthInfo?.name || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key: p.api_key || "",
        models: allModels,
        custom_models: customModels,
        has_credentials: ((p.auth_type || provRegistry.get(name)?.authType) === "none")
          ? !!(p.base_url || provRegistry.get(name)?.baseUrl)
          : !!(p.api_key || (isOAuth && oauthInfo?.loggedIn)),
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth,
        is_coding_plan: name.endsWith("-coding"),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
    }

    // 追加 OAuth-only provider（有 auth.json 但没在 added-models.yaml 里）
    // 遍历已注册的 OAuth plugin，用 authJsonKey 查 oauthLoginMap
    for (const oauthId of provRegistry.getOAuthProviderIds()) {
      if (result[oauthId]) continue;
      const authKey = provRegistry.getAuthJsonKey(oauthId);
      const loginInfo = oauthLoginMap.get(authKey);
      if (!loginInfo) continue;
      const sdkIds = sdkByProvider.get(authKey) || sdkByProvider.get(oauthId) || [];
      const customModels = oauthCustom[authKey] || oauthCustom[oauthId] || [];
      result[oauthId] = {
        type: "oauth",
        display_name: loginInfo.name || oauthId,
        base_url: "",
        api: "",
        api_key: "",
        models: sdkIds,
        custom_models: customModels,
        has_credentials: !!loginInfo.loggedIn,
        logged_in: !!loginInfo.loggedIn,
        supports_oauth: true,
        is_coding_plan: false,
        can_delete: false,
      };
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        const sdkIds = sdkByProvider.get(id) || [];
        const defaultModels = provRegistry.getDefaultModels(id) || [];
        result[id] = {
          type: entry.authType === "none" ? "none" : "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key: "",
          models: [...new Set([...defaultModels, ...sdkIds])],
          custom_models: [],
          has_credentials: entry.authType === "none" ? !!entry.baseUrl : false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: id.endsWith("-coding"),
          can_delete: false,
        };
      }
    }

    return c.json({ providers: result });
  });

  function buildBuiltinFallbackModels(providerName) {
    if (!providerName) return [];
    const defaults = engine.providerRegistry?.getDefaultModels?.(providerName) || [];
    return defaults.map((id) => ({
      id,
      name: id,
      context: null,
      maxOutput: null,
    }));
  }

  function buildFetchFallback(providerName) {
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

  function normalizeModelId(value) {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "object" && typeof value.id === "string") return value.id.trim();
    return String(value).trim();
  }

  function resolveProviderSmokeModel(providerName, body = {}) {
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

  async function runProviderChatSmoke({ baseUrl, api, apiKey, allowMissingApiKey, modelId }) {
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
    });
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
    let payload = null;
    try {
      const text = await res.text();
      payload = text ? JSON.parse(text) : null;
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

  function normalizeRegistryModels(models) {
    return models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      context: model.contextWindow ?? model.context ?? null,
      maxOutput: model.maxOutputTokens ?? model.maxOutput ?? null,
    }));
  }

  /**
   * 从供应商的 /v1/models (OpenAI 兼容) 端点拉取模型列表
   * body: { name, base_url, api, api_key? }
   */
  route.post("/providers/fetch-models", async (c) => {
    const body = await safeJson(c);
    const { name, base_url, api: explicitApi, api_key } = body;
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
    }

    const savedProvider = name ? (() => {
      const cred = engine.providerRegistry.getCredentials(name);
      if (!cred) return {};
      return { api_key: cred.apiKey, base_url: cred.baseUrl, api: cred.api };
    })() : {};
    const savedKey = savedProvider.api_key || "";
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    const allowMissingApiKey = resolveAllowMissingApiKey(name, effectiveBaseUrl);
    const hasExplicitRemoteConfig = !!(effectiveBaseUrl && effectiveApi && (api_key || savedKey));

    const isOAuthProvider = !!name && engine.providerRegistry.isOAuth(name);

    if (isOAuthProvider && !hasExplicitRemoteConfig) {
      try {
        await engine.refreshAvailableModels();
        // Pi SDK 用 authJsonKey 作为 model.provider，需要两个 ID 都匹配
        const authKey = engine.providerRegistry.getAuthJsonKey(name);
        const registryModels = engine.availableModels.filter(
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
        return c.json({ error: err.message, models: [] });
      }
    }

    if (!base_url) {
      return c.json({ error: "base_url is required for remote model fetch" }, 400);
    }

    // 解析 api_key：显式传入 > providers 块 > auth.json OAuth token
    let key = api_key || "";
    let api = explicitApi || "";
    if (!key && name) {
      key = savedKey;
      api = api || savedProvider.api || "";
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
      let headers = { "Content-Type": "application/json" };
      if (key || allowMissingApiKey) {
        if (!effectiveApi) {
          return c.json({ error: "api is required", models: [] });
        }
        headers = buildProviderAuthHeaders(effectiveApi, key, {
          allowMissingApiKey,
          method: "GET",
          pathname: "/models",
        });
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

      const data = await res.json();
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
      return c.json({ error: err.message, models: [] });
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
    const body = await safeJson(c);
    const { name } = body;
    const base_url = String(body.base_url || "").trim();
    const explicitApi = String(body.api || "").trim();
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const explicitApiKey = (body.api_key || "").replace(/[^\x20-\x7E]/g, "").trim();
    const savedProvider = name ? (() => {
      const cred = engine.providerRegistry.getCredentials(name);
      if (!cred) return {};
      return { api_key: cred.apiKey, base_url: cred.baseUrl, api: cred.api };
    })() : {};
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    let effectiveApiKey = explicitApiKey || savedProvider.api_key || "";
    if (!effectiveBaseUrl) {
      return c.json({ error: "base_url is required" }, 400);
    }

    try {
      const allowMissingApiKey = resolveAllowMissingApiKey(name, effectiveBaseUrl);
      if (!effectiveApiKey && name) {
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

      let headers = {};
      if (effectiveApiKey || allowMissingApiKey) {
        if (!effectiveApi) {
          return c.json({ error: "api is required when api_key is present" }, 400);
        }
        headers = buildProviderAuthHeaders(effectiveApi, effectiveApiKey, {
          allowMissingApiKey,
          method: probe.method,
          pathname,
        });
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
      return c.json({ ok: false, error: err.message });
    }
  });

  return route;
}
