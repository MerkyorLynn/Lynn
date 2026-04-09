import {
  BRAIN_CHAT_MODEL_ID,
  BRAIN_PROVIDER_ID,
  BRAIN_UTILITY_LARGE_MODEL_ID,
  BRAIN_UTILITY_MODEL_ID,
  getBrainDisplayName,
  isBrainModelRef,
} from "./brain-provider.js";
import { findModel } from "./model-ref.js";

const VALID_ASSISTANT_ROLES = new Set(["lynn", "hanako", "butter"]);
const VALID_MODEL_PURPOSES = new Set(["chat", "review", "utility", "utility_large"]);

function _d(encoded) {
  try {
    const raw = typeof atob === "function"
      ? atob(encoded)
      : Buffer.from(encoded, "base64").toString("utf-8");
    return raw.split("").reverse().join("");
  } catch {
    return "";
  }
}

function _ref(providerEncoded, idEncoded) {
  return Object.freeze({
    provider: providerEncoded === BRAIN_PROVIDER_ID ? BRAIN_PROVIDER_ID : _d(providerEncoded),
    id: _d(idEncoded),
  });
}

export const USER_FACING_MODEL_LABELS = Object.freeze({
  lynn: "默认对话模型",
  hanako: "默认复查模型",
  butter: "默认复查模型",
  review: "默认复查模型",
  utility: "默认工具模型",
  utility_large: "默认执行模型",
  brain: getBrainDisplayName(),
});

export const ASSISTANT_ROLE_MODEL_FALLBACKS = Object.freeze({
  lynn: Object.freeze([
    Object.freeze({ provider: BRAIN_PROVIDER_ID, id: BRAIN_CHAT_MODEL_ID }),
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
  ]),
  hanako: Object.freeze([
    _ref("dXBpaHo=", "aHNhbGYtNC1tbGc="),
    _ref("a2Vlc3BlZWQ=", "dGFoYy1rZWVzcGVlZA=="),
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

export function normalizeAssistantRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "ming") return "lynn";
  return VALID_ASSISTANT_ROLES.has(value) ? value : null;
}

function normalizePurpose(purpose) {
  const value = String(purpose || "").trim().toLowerCase();
  return VALID_MODEL_PURPOSES.has(value) ? value : null;
}

export function getAssistantRoleFromConfig(agentConfig) {
  return normalizeAssistantRole(agentConfig?.agent?.yuan);
}

export function getRoleDefaultModelRefs(roleOrPurpose, purpose) {
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

export function resolveRoleDefaultModel(availableModels, roleOrPurpose, purpose) {
  const refs = getRoleDefaultModelRefs(roleOrPurpose, purpose);
  for (const ref of refs) {
    const match = findModel(availableModels, ref.id, ref.provider);
    if (match) return match;
  }
  return null;
}

export function getUserFacingRoleModelLabel(roleOrPurpose, purpose) {
  const normalizedRole = normalizeAssistantRole(roleOrPurpose);
  const normalizedPurpose = normalizePurpose(purpose)
    || (normalizedRole ? normalizedRole : normalizePurpose(roleOrPurpose));

  if (normalizedPurpose === "review") return USER_FACING_MODEL_LABELS.review;
  if (normalizedPurpose && USER_FACING_MODEL_LABELS[normalizedPurpose]) {
    return USER_FACING_MODEL_LABELS[normalizedPurpose];
  }
  if (normalizedRole && USER_FACING_MODEL_LABELS[normalizedRole]) {
    return USER_FACING_MODEL_LABELS[normalizedRole];
  }
  return null;
}

function modelMatchesAnyRef(modelId, provider, refs) {
  return refs.some((ref) => ref.id === modelId && (!ref.provider || !provider || ref.provider === provider));
}

export function getUserFacingModelAlias({ modelId, provider, role, purpose } = {}) {
  const id = String(modelId || "").trim();
  const normalizedProvider = String(provider || "").trim();
  if (!id) return null;

  const normalizedRole = normalizeAssistantRole(role);
  const normalizedPurpose = normalizePurpose(purpose);
  const refs = getRoleDefaultModelRefs(normalizedRole || normalizedPurpose, normalizedPurpose || undefined);
  const label = getUserFacingRoleModelLabel(normalizedRole || normalizedPurpose, normalizedPurpose || undefined);

  if (normalizedPurpose && label && modelMatchesAnyRef(id, normalizedProvider, refs)) return label;
  if (normalizedRole && label && modelMatchesAnyRef(id, normalizedProvider, refs)) return label;

  if (isBrainModelRef(id, normalizedProvider)) {
    if (normalizedPurpose === "review") return USER_FACING_MODEL_LABELS.review;
    if (normalizedPurpose === "utility") return USER_FACING_MODEL_LABELS.utility;
    if (normalizedPurpose === "utility_large") return USER_FACING_MODEL_LABELS.utility_large;
    if (normalizedRole && USER_FACING_MODEL_LABELS[normalizedRole]) return USER_FACING_MODEL_LABELS[normalizedRole];
    return USER_FACING_MODEL_LABELS.brain;
  }

  return null;
}
