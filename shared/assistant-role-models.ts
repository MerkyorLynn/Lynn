import {
  BRAIN_CHAT_MODEL_ID,
  BRAIN_PROVIDER_ID,
  BRAIN_UTILITY_LARGE_MODEL_ID,
  BRAIN_UTILITY_MODEL_ID,
  getBrainDisplayName,
  isBrainModelRef,
} from "./brain-provider.js";
import { findModel } from "./model-ref.js";

export type AssistantRole = "lynn" | "hanako" | "butter";
export type ModelPurpose = "chat" | "review" | "utility" | "utility_large";
export type ModelRef = { provider: string; id: string };
export type AvailableModelRef = { id: string; provider?: string | null };

type AgentRoleConfig = {
  agent?: {
    yuan?: string | null;
  } | null;
} | null | undefined;

const VALID_ASSISTANT_ROLES = new Set<string>(["lynn", "hanako", "butter"]);
const VALID_MODEL_PURPOSES = new Set<string>(["chat", "review", "utility", "utility_large"]);

function _d(encoded: string): string {
  try {
    const raw = typeof atob === "function"
      ? atob(encoded)
      : Buffer.from(encoded, "base64").toString("utf-8");
    return raw.split("").reverse().join("");
  } catch {
    return "";
  }
}

/** Anything that is not a Chinese locale gets English copy. */
function prefersEnglish(locale?: string | null): boolean {
  const value = String(locale ?? "").trim().toLowerCase();
  if (!value) return false;
  return !value.startsWith("zh");
}

function _ref(providerEncoded: string, idEncoded: string): Readonly<ModelRef> {
  return Object.freeze({
    provider: providerEncoded === BRAIN_PROVIDER_ID ? BRAIN_PROVIDER_ID : _d(providerEncoded),
    id: _d(idEncoded),
  });
}

export const USER_FACING_MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  lynn: "默认工作模型",
  hanako: "Hanako · GLM-5.3-Flash",
  butter: "Hanako · GLM-5.3-Flash",
  review: "Hanako · GLM-5.3-Flash",
  utility: "默认工具模型",
  utility_large: "默认执行模型",
  brain: getBrainDisplayName(),
});

/**
 * English twins of {@link USER_FACING_MODEL_LABELS}.
 *
 * Model ids stay the same in every language; only the role wording changes.
 */
export const USER_FACING_MODEL_LABELS_EN: Readonly<Record<string, string>> = Object.freeze({
  lynn: "Default work model",
  hanako: "Hanako · GLM-5.3-Flash",
  butter: "Hanako · GLM-5.3-Flash",
  review: "Hanako · GLM-5.3-Flash",
  utility: "Default tool model",
  utility_large: "Default execution model",
  brain: getBrainDisplayName("en"),
});

/** Resolve a role/purpose label for the given locale (Chinese by default). */
export function getUserFacingRoleModelLabels(locale?: string | null): Readonly<Record<string, string>> {
  return prefersEnglish(locale) ? USER_FACING_MODEL_LABELS_EN : USER_FACING_MODEL_LABELS;
}

export const ASSISTANT_ROLE_MODEL_FALLBACKS: Readonly<Record<string, readonly ModelRef[]>> = Object.freeze({
  lynn: Object.freeze([
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: BRAIN_CHAT_MODEL_ID }),
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
  ]),
  hanako: Object.freeze([
    Object.freeze({ provider: "zhipu-coding", id: "glm-5.3-flash" }),
    Object.freeze({ provider: "zhipu", id: "glm-5.3-flash" }),
    Object.freeze({ provider: "deepseek", id: "deepseek-v4-flash-vision-exp" }),
    Object.freeze({ provider: "deepseek", id: "deepseek-v4-flash" }),
    Object.freeze({ provider: "mimo", id: "mimo-v2.5-pro" }),
    Object.freeze({ provider: "xiaomi", id: "mimo-v2.5-pro" }),
    Object.freeze({ provider: "xiaomi-mimo", id: "mimo-v2.5-pro" }),
    Object.freeze({ provider: "token-plan", id: "mimo-v2.5-pro" }),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: BRAIN_CHAT_MODEL_ID }),
  ]),
  butter: Object.freeze([
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: _d("YjgtM25ld3E=") }),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
  ]),
  utility: Object.freeze([
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: BRAIN_UTILITY_MODEL_ID }),
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
  ]),
  utility_large: Object.freeze([
    _ref("eGFtaW5pbQ==", "Ny4yTS14YU1pbmlN"),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: BRAIN_UTILITY_LARGE_MODEL_ID }),
  ]),
});

export function normalizeAssistantRole(role?: string | null): AssistantRole | null {
  const value = String(role || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "ming") return "lynn";
  return VALID_ASSISTANT_ROLES.has(value) ? value as AssistantRole : null;
}

function normalizePurpose(purpose?: string | null): ModelPurpose | null {
  const value = String(purpose || "").trim().toLowerCase();
  return VALID_MODEL_PURPOSES.has(value) ? value as ModelPurpose : null;
}

export function getAssistantRoleFromConfig(agentConfig: AgentRoleConfig): AssistantRole | null {
  return normalizeAssistantRole(agentConfig?.agent?.yuan);
}

export function getRoleDefaultModelRefs(
  roleOrPurpose?: string | null,
  purpose?: ModelPurpose | null,
): ModelRef[] {
  const normalizedRole = normalizeAssistantRole(roleOrPurpose);
  const normalizedPurpose = normalizePurpose(purpose)
    || (normalizedRole ? normalizedRole : normalizePurpose(roleOrPurpose));

  if (normalizedPurpose === "review") {
    if (normalizedRole && ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedRole]) {
      return [...ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedRole]];
    }
    return [
      ...ASSISTANT_ROLE_MODEL_FALLBACKS.hanako,
      ...ASSISTANT_ROLE_MODEL_FALLBACKS.butter,
    ];
  }
  if (normalizedPurpose && ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedPurpose]) {
    return [...ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedPurpose]];
  }
  if (normalizedRole && ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedRole]) {
    return [...ASSISTANT_ROLE_MODEL_FALLBACKS[normalizedRole]];
  }
  return [];
}

export function resolveRoleDefaultModel(
  availableModels: readonly AvailableModelRef[],
  roleOrPurpose?: string | null,
  purpose?: ModelPurpose | null,
): AvailableModelRef | null {
  const refs = getRoleDefaultModelRefs(roleOrPurpose, purpose);
  for (const ref of refs) {
    const match = findModel(availableModels, ref.id, ref.provider) as AvailableModelRef | null | undefined;
    if (match) return match;
  }
  return null;
}

export function getUserFacingRoleModelLabel(
  roleOrPurpose?: string | null,
  purpose?: ModelPurpose | null,
  locale?: string | null,
): string | null {
  const normalizedRole = normalizeAssistantRole(roleOrPurpose);
  const normalizedPurpose = normalizePurpose(purpose)
    || (normalizedRole ? normalizedRole : normalizePurpose(roleOrPurpose));
  const labels = getUserFacingRoleModelLabels(locale);

  if (normalizedPurpose === "review") return labels.review;
  if (normalizedPurpose && labels[normalizedPurpose]) {
    return labels[normalizedPurpose];
  }
  if (normalizedRole && labels[normalizedRole]) {
    return labels[normalizedRole];
  }
  return null;
}

function modelMatchesAnyRef(modelId: string, provider: string, refs: readonly ModelRef[]): boolean {
  return refs.some((ref) => ref.id === modelId && (!ref.provider || !provider || ref.provider === provider));
}

export function getUserFacingModelAlias({
  modelId,
  provider,
  role,
  purpose,
  locale,
}: {
  modelId?: string | null;
  provider?: string | null;
  role?: string | null;
  purpose?: ModelPurpose | null;
  locale?: string | null;
} = {}): string | null {
  const id = String(modelId || "").trim();
  const normalizedProvider = String(provider || "").trim();
  if (!id) return null;

  const normalizedRole = normalizeAssistantRole(role);
  const normalizedPurpose = normalizePurpose(purpose);
  const refs = getRoleDefaultModelRefs(normalizedRole || normalizedPurpose, normalizedPurpose || undefined);
  const labels = getUserFacingRoleModelLabels(locale);
  const label = getUserFacingRoleModelLabel(
    normalizedRole || normalizedPurpose,
    normalizedPurpose || undefined,
    locale,
  );

  if (normalizedPurpose && label && modelMatchesAnyRef(id, normalizedProvider, refs)) return label;
  if (normalizedRole && label && modelMatchesAnyRef(id, normalizedProvider, refs)) return label;

  if (isBrainModelRef(id, normalizedProvider)) {
    if (normalizedPurpose === "review") return labels.review;
    if (normalizedPurpose === "utility") return labels.utility;
    if (normalizedPurpose === "utility_large") return labels.utility_large;
    if (normalizedRole && labels[normalizedRole]) return labels[normalizedRole];
    return labels.brain;
  }

  return null;
}
