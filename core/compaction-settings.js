import { lookupKnown } from "../shared/known-models.js";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const MIN_COMPACTION_KEEP_RECENT_TOKENS = 8_192;
export const MAX_COMPACTION_KEEP_RECENT_TOKENS = 65_536;

// 动态保留比例：小窗口模型保留更多近期上下文
function resolveKeepRecentRatio(contextWindow) {
  if (!contextWindow || contextWindow >= 64_000) return 0.20;
  if (contextWindow >= 32_000) return 0.25;
  if (contextWindow >= 16_000) return 0.30;
  return 0.40;
}

// 动态 reserve：小窗口模型减少输出预留
function resolveReserveTokens(contextWindow) {
  if (!contextWindow || contextWindow >= 32_000) return 16_384;
  if (contextWindow >= 16_000) return 8_192;
  return 4_096;
}

const KEEP_RECENT_GAP_TOKENS = 4_096;

function normalizePositiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function resolveModelContextWindow(model) {
  const direct = normalizePositiveInteger(model?.contextWindow);
  if (direct) return direct;

  const modelId = typeof model?.id === "string" ? model.id.trim() : "";
  if (!modelId) return null;

  const known = lookupKnown(model?.provider, modelId);
  return normalizePositiveInteger(known?.contextWindow || known?.context);
}

export function resolveCompactionSettings(model) {
  const contextWindow = resolveModelContextWindow(model);
  if (!contextWindow) {
    return {
      enabled: true,
      reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
    };
  }

  const reserveTokens = resolveReserveTokens(contextWindow);
  const keepRecentRatio = resolveKeepRecentRatio(contextWindow);
  const compactionThreshold = Math.max(4_096, contextWindow - reserveTokens);
  const maxKeepRecentTokens = Math.max(4_096, compactionThreshold - KEEP_RECENT_GAP_TOKENS);
  const minKeepRecentTokens = Math.min(MIN_COMPACTION_KEEP_RECENT_TOKENS, maxKeepRecentTokens);
  const ratioKeepRecentTokens = Math.round(contextWindow * keepRecentRatio);
  const keepRecentTokens = Math.max(
    minKeepRecentTokens,
    Math.min(MAX_COMPACTION_KEEP_RECENT_TOKENS, maxKeepRecentTokens, ratioKeepRecentTokens),
  );

  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens,
  };
}
