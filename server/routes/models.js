/**
 * 模型管理 REST 路由
 */
import { readFileSync } from "fs";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { supportsXhigh } from "@mariozechner/pi-ai";
import { t } from "../i18n.js";
import { fromRoot } from "../../shared/hana-root.js";
import { findModel, modelRefEquals, parseModelRef } from "../../shared/model-ref.js";

const _knownModels = JSON.parse(readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(id, sdkName, overrides) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  if (_knownModels[id]?.name) return _knownModels[id].name;
  return sdkName || id;
}

export function createModelsRoute(engine) {
  const route = new Hono();

  // 列出可用模型
  route.get("/models", async (c) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;
      const models = engine.availableModels.map(m => ({
        id: m.id,
        name: resolveModelName(m.id, m.name, overrides),
        provider: m.provider,
        isCurrent: modelRefEquals(m, cur),
      }));
      return c.json({ models, current: cur?.id || null });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 收藏模型列表（给聊天页面用，直接读 favorites，和设置页同源）
  route.get("/models/favorites", async (c) => {
    try {
      const favorites = engine.readFavorites();
      const available = engine.availableModels;
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;

      const result = [];
      for (const item of favorites) {
        const { id: modelId, provider: hintProvider } = parseModelRef(item);
        if (!modelId) continue;
        const m = findModel(available, modelId, hintProvider);
        const provider = hintProvider || m?.provider || "";
        if (!m && !hintProvider) continue;
        result.push({
          id: modelId,
          name: resolveModelName(modelId, m?.name, overrides),
          provider,
          isCurrent: modelRefEquals({ id: modelId, provider }, cur),
          reasoning: m ? !!m.reasoning : false,
          xhigh: m ? supportsXhigh(m) : false,
          vision: provider ? (engine.providerRegistry.get(provider)?.capabilities?.vision !== false) : true,
        });
      }

      return c.json({
        models: result,
        current: cur?.id || null,
        hasFavorites: favorites.length > 0,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });


  // 健康检测：发一个最小请求测试模型连通性
  route.post("/models/health", async (c) => {
    try {
      const body = await safeJson(c);
      const { modelId } = body;
      if (!modelId) return c.json({ error: "modelId required" }, 400);

      const { provider } = body;
      const model = findModel(engine.availableModels, modelId, provider);
      if (!model) return c.json({ error: `model "${modelId}" not found` }, 404);

      // 凭证解析：providers.yaml → auth.json OAuth（含 resourceUrl）→ 模型对象自带 baseUrl
      const creds = engine.resolveProviderCredentials(model.provider);

      // OAuth provider 可能有 resourceUrl（实际使用的域名，可能和内置不同）
      const oauthCred = engine.authStorage.get(model.provider);
      const oauthBaseUrl = oauthCred?.type === "oauth" ? oauthCred.resourceUrl : "";

      const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
      if (!baseUrl) return c.json({ ok: false, error: "no base_url" });

      let apiKey = creds.api_key;
      if (!apiKey) {
        try { apiKey = await engine.authStorage.getApiKey(model.provider); } catch {}
      }
      if (!apiKey) return c.json({ ok: false, error: "no api_key" });

      const { buildProviderAuthHeaders, buildProbeUrl } = await import("../../lib/llm/provider-client.js");
      const api = creds.api || model.api || "openai-completions";

      // OpenAI Codex Responses API：无法通过简单请求检测（Cloudflare 反爬），跳过
      if (api === "openai-codex-responses") {
        return c.json({ ok: true, status: 0, provider: model.provider, skipped: t("error.codexNoHealthCheck") });
      }

      const probe = buildProbeUrl(baseUrl, api);
      const headers = buildProviderAuthHeaders(api, apiKey);

      if (api === "anthropic-messages") {
        const res = await fetch(probe.url, {
          method: probe.method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
          signal: AbortSignal.timeout(10000),
        });
        return c.json({ ok: res.ok || res.status === 400, status: res.status, provider: model.provider });
      }

      const res = await fetch(probe.url, { headers, signal: AbortSignal.timeout(10000) });
      return c.json({ ok: res.ok, status: res.status, provider: model.provider });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  // 切换模型
  route.post("/models/set", async (c) => {
    try {
      const body = await safeJson(c);
      const { modelId, provider } = body;
      if (!modelId) {
        return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      }
      await engine.setModel(modelId, provider);
      return c.json({ ok: true, model: engine.currentModel?.name });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
