/**
 * ExpertManager — 专家管理器
 *
 * 负责加载预设专家、列出可用专家、实例化专家为 Agent。
 * 挂在 HanaEngine 上，与 AgentManager 协作。
 *
 * 设计原则：
 * - 平台不提供默认 AI 模型，所有 AI 调用均走用户自己的 API Key
 * - model_binding 仅作为推荐，实际使用用户已配置的模型
 * - 积分系统通过 CreditInterface 抽象，开源版为 noop
 */
import path from "path";
import { loadPresets, loadPresetBySlug } from "../lib/experts/expert-loader.js";
import { CreditInterface } from "../lib/credits/credit-interface.js";
import { createModuleLogger } from "../lib/debug-log.js";

const log = createModuleLogger("expert-mgr");

export class ExpertManager {
  /**
   * @param {object} deps
   * @param {string} deps.presetsDir - 专家预设目录 (lib/experts/presets/)
   * @param {() => import('./agent-manager.js').AgentManager} deps.getAgentManager
   * @param {() => import('./model-manager.js').ModelManager} deps.getModelManager
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkillManager
   * @param {CreditInterface} [deps.creditInterface] - 积分接口（默认 noop）
   */
  constructor(deps) {
    this._presetsDir = deps.presetsDir;
    this._getAgentMgr = deps.getAgentManager;
    this._getModelMgr = deps.getModelManager;
    this._getSkillMgr = deps.getSkillManager;
    this._creditInterface = deps.creditInterface || new CreditInterface();

    /** @type {Array<object>} 缓存的预设列表 */
    this._presets = [];
    this._presetsLoaded = false;
  }

  // ════════════════════════════
  //  预设加载
  // ════════════════════════════

  /**
   * 扫描并加载所有预设专家（启动时或首次访问时调用）
   */
  loadPresets() {
    this._presets = loadPresets(this._presetsDir);
    this._presetsLoaded = true;
    log.log(`加载了 ${this._presets.length} 个专家预设`);
    return this._presets;
  }

  /**
   * 确保预设已加载（懒加载）
   */
  _ensureLoaded() {
    if (!this._presetsLoaded) this.loadPresets();
  }

  // ════════════════════════════
  //  查询
  // ════════════════════════════

  /**
   * 列出所有可用专家预设
   * @param {string} [locale] - 可选语言代码，用于选择 name/description
   * @returns {Array<object>}
   */
  listExperts(locale) {
    this._ensureLoaded();
    const lang = locale?.startsWith("zh") ? "zh" : locale?.startsWith("ja") ? "ja" : "en";

    return this._presets.map(p => ({
      slug: p.slug,
      name: p.name[lang] || p.name.en || p.slug,
      nameI18n: p.name,
      icon: p.icon,
      category: p.category,
      tier: p.tier,
      model_binding: {
        preferred: p.model_binding.preferred,
        fallback: p.model_binding.fallback,
      },
      credit_cost: p.credit_cost,
      skills: p.skills,
      description: p.description[lang] || p.description.en || "",
      descriptionI18n: p.description,
    }));
  }

  /**
   * 获取单个专家详情
   * @param {string} slug
   * @param {string} [locale]
   * @returns {object|null}
   */
  getExpert(slug, locale) {
    this._ensureLoaded();
    const preset = this._presets.find(p => p.slug === slug);
    if (!preset) return null;

    const lang = locale?.startsWith("zh") ? "zh" : locale?.startsWith("ja") ? "ja" : "en";
    return {
      slug: preset.slug,
      name: preset.name[lang] || preset.name.en || preset.slug,
      nameI18n: preset.name,
      icon: preset.icon,
      category: preset.category,
      tier: preset.tier,
      model_binding: preset.model_binding,
      credit_cost: preset.credit_cost,
      skills: preset.skills,
      description: preset.description[lang] || preset.description.en || "",
      descriptionI18n: preset.description,
      identity: preset._identity || "",
      ishiki: preset._ishiki || "",
    };
  }

  /**
   * 获取专家积分消耗
   * @param {string} slug
   * @returns {object|null}
   */
  getExpertCost(slug) {
    this._ensureLoaded();
    const preset = this._presets.find(p => p.slug === slug);
    return preset?.credit_cost || null;
  }

  /**
   * 获取专家绑定的技能列表
   * @param {string} slug
   * @returns {string[]}
   */
  getExpertSkills(slug) {
    this._ensureLoaded();
    const preset = this._presets.find(p => p.slug === slug);
    return preset?.skills || [];
  }

  // ════════════════════════════
  //  模型解析
  // ════════════════════════════

  /**
   * 根据专家的 model_binding 解析实际可用的模型
   *
   * 注意：不提供默认模型。如果用户没有配置对应的 API Key，
   * 则降级到 fallback 模型；如果 fallback 也不可用，
   * 使用用户当前的默认模型。
   *
   * @param {string} slug
   * @returns {string|null} - 模型 ID 或 null
   */
  resolveModelForExpert(slug) {
    this._ensureLoaded();
    const preset = this._presets.find(p => p.slug === slug);
    if (!preset) return null;

    const modelMgr = this._getModelMgr();
    const available = modelMgr.availableModels || [];

    // 尝试首选模型
    const preferred = preset.model_binding.preferred;
    if (available.some(m => m.id === preferred)) {
      return preferred;
    }

    // 尝试降级模型
    const fallback = preset.model_binding.fallback;
    if (fallback && available.some(m => m.id === fallback)) {
      return fallback;
    }

    // 使用用户当前默认模型
    const defaultModel = modelMgr.defaultModel;
    return defaultModel?.id || null;
  }

  // ════════════════════════════
  //  专家实例化
  // ════════════════════════════

  /**
   * 基于预设创建 Agent 实例（spawn 专家）
   *
   * 流程：
   * 1. 检查积分（CreditInterface）
   * 2. 通过 AgentManager.createAgent() 创建 Agent
   * 3. 注入 expert 配置（tier、model_binding 等）
   * 4. 返回新创建的 agentId
   *
   * @param {string} slug - 专家 slug
   * @param {object} [opts]
   * @param {string} [opts.userId] - 用户 ID（计费用）
   * @param {boolean} [opts.persistent=true] - 是否持久化（默认是）
   * @returns {Promise<{agentId: string, name: string}>}
   */
  async spawnExpert(slug, opts = {}) {
    this._ensureLoaded();
    const preset = this._presets.find(p => p.slug === slug);
    if (!preset) throw new Error(`Expert not found: ${slug}`);

    // 积分检查
    const cost = preset.credit_cost.per_session;
    if (opts.userId && cost > 0) {
      const canAfford = await this._creditInterface.canAfford(opts.userId, cost);
      if (!canAfford) {
        throw new Error("Insufficient credits");
      }
    }

    const locale = "zh"; // 默认中文
    const expertName = preset.name[locale] || preset.name.en || slug;

    // 解析最佳可用模型
    const modelId = this.resolveModelForExpert(slug);

    // 通过 AgentManager 创建 Agent
    const agentMgr = this._getAgentMgr();
    const result = await agentMgr.createAgent({
      name: expertName,
      yuan: "hanako",  // 专家默认使用 hanako 模板，identity.md 会覆盖人格
    });

    // 注入 expert 配置到新创建的 agent
    const agent = agentMgr.getAgent(result.id);
    if (agent) {
      // 更新 agent config 添加 tier 和 expert 信息
      agent.updateConfig({
        agent: {
          tier: "expert",
        },
        expert: {
          slug: preset.slug,
          model_binding: preset.model_binding,
          credit_cost: preset.credit_cost,
          category: preset.category,
          icon: preset.icon,
        },
      });

      // 如果有模型绑定且用户有该模型，设置 chat 模型
      if (modelId) {
        agent.updateConfig({
          models: { chat: modelId },
        });
      }

      // 写入 identity.md 和 ishiki.md（覆盖默认模板）
      const fs = await import("fs");
      if (preset._identity) {
        fs.writeFileSync(
          path.join(agent.agentDir, "identity.md"),
          preset._identity,
          "utf-8"
        );
      }
      if (preset._ishiki) {
        fs.writeFileSync(
          path.join(agent.agentDir, "ishiki.md"),
          preset._ishiki,
          "utf-8"
        );
      }

      // 重建 system prompt
      agent._systemPrompt = agent.buildSystemPrompt();
    }

    // 扣费
    if (opts.userId && cost > 0) {
      await this._creditInterface.consume(
        opts.userId,
        cost,
        `expert:${slug}`
      );
    }

    log.log(`专家已 spawn: ${expertName} (${result.id}) from preset ${slug}`);
    return { agentId: result.id, name: expertName };
  }

  // ════════════════════════════
  //  积分系统
  // ════════════════════════════

  /** 替换积分接口（闭源插件注入用） */
  setCreditInterface(impl) {
    this._creditInterface = impl;
  }

  get creditInterface() {
    return this._creditInterface;
  }
}
