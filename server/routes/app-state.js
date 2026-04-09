import { Hono } from "hono";
import { buildReviewConfig } from "./review.js";
import { loadProjectInstructions } from "../../lib/project-instructions.js";

function toModelRef(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, provider: null } : null;
  }
  if (typeof value === "object" && value !== null) {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) return null;
    const provider = typeof value.provider === "string" && value.provider.trim()
      ? value.provider.trim()
      : null;
    return { id, provider };
  }
  return null;
}

function resolvePreferredProviderId(engine, currentModel) {
  if (currentModel?.provider) return currentModel.provider;

  const config = engine.config || {};
  const apiProvider = typeof config.api?.provider === "string" ? config.api.provider.trim() : "";
  if (apiProvider) return apiProvider;

  const chatModel = toModelRef(config.models?.chat);
  const chatModelId = chatModel?.id || "";
  if (!chatModelId) return null;

  const providers = config.providers || {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (Array.isArray(providerConfig?.models) && providerConfig.models.includes(chatModelId)) {
      return providerId;
    }
  }

  return null;
}

function buildTaskSnapshot(taskRuntime) {
  if (!taskRuntime || typeof taskRuntime.listTasks !== "function") return null;
  const tasks = taskRuntime.listTasks();
  const active = tasks.filter((task) => ["pending", "running", "waiting_approval"].includes(task.status));
  return {
    activeCount: active.length,
    waitingApprovalCount: active.filter((task) => task.status === "waiting_approval").length,
    runningCount: active.filter((task) => task.status === "running").length,
    pendingCount: active.filter((task) => task.status === "pending").length,
    recent: active
      .slice(0, 5)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        currentLabel: task.progress?.currentLabel || null,
        snapshot: task.snapshot || null,
      })),
  };
}

function buildCapabilitySnapshot(engine) {
  const allSkills = engine.getAllSkills?.(engine.currentAgentId) || [];
  const enabledSkills = allSkills.filter((skill) => skill.enabled && !skill.hidden);
  const learnedSkills = enabledSkills.filter((skill) => skill.source === "learned").length;
  const externalSkills = enabledSkills.filter((skill) => skill.source === "external").length;
  const mcpManager = engine.mcpManager || null;
  const cwd = engine.cwd || null;
  const instructions = cwd ? loadProjectInstructions(cwd) : { layers: [] };

  return {
    enabledSkills: enabledSkills.length,
    learnedSkills,
    externalSkills,
    mcp: {
      servers: mcpManager?.serverCount || 0,
      tools: mcpManager?.toolCount || 0,
    },
    projectInstructions: {
      layers: Array.isArray(instructions.layers) ? instructions.layers.length : 0,
      files: Array.isArray(instructions.layers)
        ? instructions.layers.map((layer) => layer.file)
        : [],
    },
  };
}

export function createAppStateRoute(engine, { taskRuntime } = {}) {
  const route = new Hono();

  route.get("/app-state", async (c) => {
    try {
      const currentModel = engine.currentModel
        ? {
            id: engine.currentModel.id || null,
            name: engine.currentModel.name || engine.currentModel.id || null,
            provider: engine.currentModel.provider || null,
          }
        : null;
      const sharedModels = engine.getSharedModels?.() || {};
      const search = engine.getSearchConfig?.() || {};
      const review = buildReviewConfig(engine);

      return c.json({
        agent: {
          currentAgentId: engine.currentAgentId || null,
          primaryAgentId: engine.preferences?.getPrimaryAgent?.() || null,
          name: engine.agentName || null,
          yuan: engine.agent?.config?.agent?.yuan || engine.agent?.yuan || null,
        },
        model: {
          current: currentModel,
          utility: toModelRef(sharedModels.utility),
          utilityLarge: toModelRef(sharedModels.utility_large),
          preferredProviderId: resolvePreferredProviderId(engine, currentModel),
        },
        review,
        security: {
          mode: engine.getSecurityMode?.() || engine.securityMode || "authorized",
          planMode: !!engine.planMode,
        },
        desk: {
          homeFolder: engine.getHomeFolder?.() || null,
          trustedRoots: engine.getTrustedRoots?.() || [],
        },
        search: {
          provider: search.provider || null,
          configured: !!(
            search.provider && (
              (search.provider === "searxng" && search.base_url)
              || search.api_key
            )
          ),
        },
        capabilities: buildCapabilitySnapshot(engine),
        tasks: buildTaskSnapshot(taskRuntime),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
