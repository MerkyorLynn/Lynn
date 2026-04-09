/**
 * ExecutionRouter -- per-agent 角色路由
 *
 * 职责：
 *   - 将 agent 的角色配置（chat/utility/embed 等）解析为执行所需的完整参数
 *   - 输入：role 名称 + agentConfig
 *   - 输出：{ modelId, providerId, api, apiKey, baseUrl }
 *   - 完全不参与模型注册逻辑（这是路由层，不是管理层）
 *
 * 角色路由配置存储格式（preferences.json / config.yaml）：
 *   models.chat           -> "provider/model" 或裸 modelId（向后兼容）
 *   models.utility        -> 同上
 *   models.utility_large  -> 同上
 *   models.embed          -> 同上
 *   models.summarizer     -> 同上
 *   models.compiler       -> 同上
 *
 * 设计来源：Lynn 自己的三通道 API 概念（两个参考项目都没有）
 */

import { t } from "../server/i18n.js";
import { isLocalBaseUrl } from "../shared/net-utils.js";
import { getAssistantRoleFromConfig, getRoleDefaultModelRefs } from "../shared/assistant-role-models.js";

// 角色名称 -> preferences 字段名（SHARED_MODEL_KEYS 兼容）
const ROLE_TO_PREF_KEY = {
  utility: "utility_model",
  utility_large: "utility_large_model",
  summarizer: "summarizer_model",
  compiler: "compiler_model",
};

export class ExecutionRouter {
  /**
   * @param {(ref: string) => object|null} resolveModel - 从 _availableModels 解析模型的函数
   * @param {import('./provider-registry.js').ProviderRegistry} providerRegistry
   */
  constructor(resolveModel, providerRegistry) {
    this._resolveModel = resolveModel;
    this._providerRegistry = providerRegistry;
  }

  /**
   * 解析角色 -> 完整执行参数
   *
   * @param {string} roleOrRef
   *   角色名（"chat"/"utility"/"utility_large"/"embed"/"summarizer"/"compiler"）
   *   或直接是模型引用（"provider/model" 或裸 modelId）
   * @param {object} agentConfig - agent config 对象（来自 config.yaml）
   * @param {object} [sharedModels] - 全局共享角色模型（来自 preferences）
   * @param {object} [utilApiOverride] - utility API 覆盖（来自 preferences）
   * @returns {{ modelId: string, providerId: string, api: string, apiKey: string, baseUrl: string }}
   * @throws 找不到模型或凭证时抛出
   */
  resolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const modelRef = this._resolveRef(roleOrRef, agentConfig, sharedModels);
    if (!modelRef) {
      throw new Error(t("error.noUtilityModel") + ` (role: ${roleOrRef})`);
    }

    const model = this._resolveModel(modelRef);
    if (!model) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    // utility API 覆盖：只在 utility/utility_large 角色时生效
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      }
      return {
        modelId: model.id,
        providerId: model.provider,
        api: model.api,
        apiKey: utilApiOverride.api_key,
        baseUrl: utilApiOverride.base_url || model.baseUrl,
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    if (!cred) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }
    if (!cred.api) {
      throw new Error(t("error.providerMissingApi", { provider: model.provider }));
    }
    const providerEntry = this._providerRegistry.get?.(model.provider);
    const allowMissingApiKey = providerEntry?.authType === "none";
    if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl) && !allowMissingApiKey)) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }

    return {
      modelId: model.id,
      providerId: model.provider,
      api: cred.api,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
    };
  }

  /**
   * 向后兼容的 resolveUtilityConfig 接口
   * 现有 6 处消费方（hub/channel-router, install-skill, llm-utils 等）都调这个
   * 返回结构与原 ModelManager.resolveUtilityConfig() 完全一致
   *
   * @param {object} agentConfig
   * @param {{ utility?: string, utility_large?: string, summarizer?: string, compiler?: string }} sharedModels
   * @param {{ provider?: string, api_key?: string, base_url?: string }} utilApiOverride
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApiOverride) {
    const cfg = agentConfig || {};
    const agentRole = getAssistantRoleFromConfig(cfg);
    const chatModelRef = cfg.models?.chat || null;
    const utilityRoleDefaults = getRoleDefaultModelRefs(agentRole, "utility")
      .map((ref) => ref.provider ? `${ref.provider}/${ref.id}` : ref.id);
    const utilityLargeRoleDefaults = getRoleDefaultModelRefs(agentRole, "utility_large")
      .map((ref) => ref.provider ? `${ref.provider}/${ref.id}` : ref.id);
    const utilityModelRef = sharedModels?.utility || cfg.models?.utility || chatModelRef;
    const largeModelRef = sharedModels?.utility_large || cfg.models?.utility_large || utilityModelRef || chatModelRef;
    const summarizerModelRef = sharedModels?.summarizer || cfg.models?.summarizer || chatModelRef;
    const compilerModelRef = sharedModels?.compiler || cfg.models?.compiler || chatModelRef;

    const utilityCandidates = this._buildCandidateConfigs([
      utilityModelRef,
      ...utilityRoleDefaults,
      largeModelRef,
      summarizerModelRef,
      compilerModelRef,
      chatModelRef,
    ], utilApiOverride);
    if (!utilityCandidates.length) throw new Error(t("error.noUtilityModel"));

    const largeCandidates = this._buildCandidateConfigs([
      largeModelRef,
      ...utilityLargeRoleDefaults,
      utilityModelRef,
      summarizerModelRef,
      compilerModelRef,
      chatModelRef,
    ], utilApiOverride);
    if (!largeCandidates.length) throw new Error(t("error.noUtilityLargeModel"));

    const primaryUtility = utilityCandidates[0];
    const primaryLarge = largeCandidates[0];

    return {
      utility: primaryUtility.model,
      utility_provider: primaryUtility.provider,
      utility_allow_missing_api_key: primaryUtility.allow_missing_api_key === true,
      utility_large: primaryLarge.model,
      utility_large_provider: primaryLarge.provider,
      utility_large_allow_missing_api_key: primaryLarge.allow_missing_api_key === true,
      api_key: primaryUtility.api_key,
      base_url: primaryUtility.base_url,
      api: primaryUtility.api,
      large_api_key: primaryLarge.api_key,
      large_base_url: primaryLarge.base_url,
      large_api: primaryLarge.api,
      utility_fallbacks: utilityCandidates.slice(1),
      utility_large_fallbacks: largeCandidates.slice(1),
    };
  }

  _buildCandidateConfigs(refs, utilApiOverride) {
    const seen = new Set();
    const candidates = [];
    for (const ref of refs) {
      const resolved = this._resolveCandidateConfig(ref, utilApiOverride);
      if (!resolved) continue;
      const key = `${resolved.provider}/${resolved.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(resolved);
    }
    return candidates;
  }

  _resolveCandidateConfig(modelRef, utilApiOverride) {
    if (!modelRef) return null;
    try {
      return this._resolveModelConfig(modelRef, utilApiOverride);
    } catch (err) {
      if (err?.code === "UTILITY_API_PROVIDER_MISMATCH") throw err;
      try {
        return this._resolveModelConfig(modelRef, null);
      } catch {
        return null;
      }
    }
  }

  _resolveModelConfig(modelRef, utilApiOverride) {
    const model = this._resolveModel(modelRef);
    if (!model) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    if (utilApiOverride?.provider && utilApiOverride.provider !== model.provider) {
      const err = new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      err.code = "UTILITY_API_PROVIDER_MISMATCH";
      throw err;
    }

    const canUseOverride = !!(utilApiOverride?.provider || utilApiOverride?.api_key || utilApiOverride?.base_url)
      && (!utilApiOverride.provider || utilApiOverride.provider === model.provider);
    if (canUseOverride) {
      const provCred = this._providerRegistry.getCredentials(model.provider);
      const api = provCred?.api || model.api;
      const apiKey = utilApiOverride.api_key || "";
      const baseUrl = utilApiOverride.base_url || "";
      const providerEntry = this._providerRegistry.get?.(model.provider);
      const allowMissingApiKey = providerEntry?.authType === "none";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: model.provider }));
      if (!baseUrl || (!apiKey && !isLocalBaseUrl(baseUrl) && !allowMissingApiKey)) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: model.provider }));
      }
      return {
        model: model.id,
        provider: model.provider,
        api,
        api_key: apiKey,
        base_url: baseUrl,
        allow_missing_api_key: allowMissingApiKey,
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    const providerEntry = this._providerRegistry.get?.(model.provider);
    const allowMissingApiKey = providerEntry?.authType === "none";
    if (!cred?.api) throw new Error(t("error.providerMissingApi", { provider: model.provider }));
    if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl) && !allowMissingApiKey)) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }

    return {
      model: model.id,
      provider: model.provider,
      api: cred.api,
      api_key: cred.apiKey,
      base_url: cred.baseUrl,
      allow_missing_api_key: allowMissingApiKey,
    };
  }

  /**
   * 将角色名或模型引用解析为实际模型 ref 字符串
   * @private
   */
  _resolveRef(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};

    // 内置角色名的查找顺序：sharedModels -> agentConfig.models
    switch (roleOrRef) {
      case "chat":
        return cfg.models?.chat || null;
      case "utility":
        return sharedModels?.utility || cfg.models?.utility || null;
      case "utility_large":
        return sharedModels?.utility_large || cfg.models?.utility_large || null;
      case "summarizer":
        return sharedModels?.summarizer || cfg.models?.summarizer || null;
      case "compiler":
        return sharedModels?.compiler || cfg.models?.compiler || null;
      case "embed":
        return cfg.embedding_api?.model || null;
      default:
        // 不是内置角色名，当作模型引用直接用
        return roleOrRef;
    }
  }
}
