import { findModel } from "../shared/model-ref.js";
import { getUserFacingRoleModelLabel, resolveRoleDefaultModel } from "../shared/assistant-role-models.js";

type AnyRecord = Record<string, any>;
type ToolLike = AnyRecord & { name: string };

function shouldExposeVerboseModelRouting() {
  const flag = String(process?.env?.LYNN_DEBUG_MODELS || process?.env?.DEBUG_MODEL_ROUTING || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || process?.env?.NODE_ENV === "development";
}

export function resolveSessionContextModel(agentConfig: AnyRecord, opts: {
  models: AnyRecord;
  log: Pick<Console, "log" | "error">;
  t: (key: string, vars?: AnyRecord) => string;
}) {
  const { models, log, t } = opts;
  const chatRef = agentConfig?.models?.chat;
  const agentRole = agentConfig?.agent?.yuan || null;
  const roleLabel = getUserFacingRoleModelLabel(agentRole, "chat") || "角色默认模型";
  const id = typeof chatRef === "object" ? chatRef?.id : chatRef;
  const provider = typeof chatRef === "object" ? chatRef?.provider : undefined;

  // 非 active agent 可能没有配 models.chat（模板默认为空），回退到全局默认模型
  if (!id) {
    const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
    if (roleDefaultModel) {
      log.log(`[resolveModel] agentConfig 未指定 models.chat，按角色回退到 ${roleLabel}`);
      return roleDefaultModel;
    }
    if (models.defaultModel) {
      log.log("[resolveModel] agentConfig 未指定 models.chat，回退到默认模型");
      return models.defaultModel;
    }
    log.error("[resolveModel] agentConfig 未指定 models.chat，也没有默认模型");
    throw new Error(t("error.resolveModelNoChatModel"));
  }

  const found = findModel(models.availableModels, id, provider);
  if (found) return found;

  // 模型 ID 在可用列表中找不到，尝试回退到默认模型
  const roleDefaultModel = resolveRoleDefaultModel(models.availableModels, agentRole);
  if (roleDefaultModel) {
    log.log(`[resolveModel] 已配置聊天模型暂不可用，按角色回退到 ${roleLabel}`);
    return roleDefaultModel;
  }
  if (models.defaultModel) {
    log.log("[resolveModel] 已配置聊天模型暂不可用，回退到默认模型");
    return models.defaultModel;
  }
  if (shouldExposeVerboseModelRouting()) {
    const available = models.availableModels.map((m: AnyRecord) => `${m.provider}/${m.id}`).join(", ");
    const hasAuth = models.modelRegistry
      ? `hasAuth("${models.inferModelProvider?.(id) || "?"}")=unknown`
      : "no registry";
    log.error(`[resolveModel] 找不到模型 "${id}"。availableModels=[${available}]。${hasAuth}`);
  } else {
    log.error("[resolveModel] 找不到可用聊天模型，且默认回退链不可用");
  }
  throw new Error(t("error.resolveModelNotAvailable", { id }));
}

export function createSessionContextFactory(opts: {
  models: AnyRecord;
  skills: AnyRecord;
  resourceLoader: AnyRecord;
  buildTools: (cwd: string, customTools?: unknown, opts?: AnyRecord) => { tools: ToolLike[]; customTools: ToolLike[] };
  log: Pick<Console, "log" | "error">;
  t: (key: string, vars?: AnyRecord) => string;
}) {
  return {
    authStorage: opts.models.authStorage,
    modelRegistry: opts.models.modelRegistry,
    resourceLoader: opts.resourceLoader,
    allSkills: opts.skills.allSkills,
    getSkillsForAgent: (agent: AnyRecord) => opts.skills.getSkillsForAgent?.(agent) || [],
    buildTools: (cwd: string, customTools?: unknown, buildOpts?: AnyRecord) => opts.buildTools(cwd, customTools, buildOpts),
    resolveModel: (agentConfig: AnyRecord) => resolveSessionContextModel(agentConfig, {
      models: opts.models,
      log: opts.log,
      t: opts.t,
    }),
  };
}
