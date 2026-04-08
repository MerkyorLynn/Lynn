export const BRAIN_PROVIDER_ID = "brain";
export const BRAIN_PROVIDER_LABEL = "默认模型";

function normalizeApiRoot(rawValue, fallbackValue) {
  const normalized = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!normalized) return fallbackValue;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `http://${normalized}`;
}

function resolveProcessEnvValue(key) {
  if (typeof process === "undefined" || !process?.env) return "";
  return process.env[key] || "";
}

// ── 运行时端点解析（混淆） ──
// 构建时注入或运行时解码；源码不含明文地址。
function _d(encoded) {
  try {
    const r = typeof atob === "function"
      ? atob(encoded)
      : Buffer.from(encoded, "base64").toString("utf-8");
    return r.split("").reverse().join("");
  } catch { return ""; }
}
// 编码过程：原文 → 反转字符串 → base64
// "https://api.merkyorlynn.com" → "moc.nnylorykrem.ipa//:sptth" → base64
const _BRAIN_HOST_ENCODED = "bW9jLm5ueWxyb3lrcmVtLmlwYS8vOnNwdHRo";
const _BRAIN_FALLBACK = _d(_BRAIN_HOST_ENCODED);

// ── 容灾备用地址（直连 IP，域名不可用时兜底） ──
// "http://82.156.182.240" → base64
const _BRAIN_BACKUP_HOST_ENCODED = "MDQyLjI4MS42NTEuMjgvLzpwdHRo";
const _BRAIN_BACKUP_FALLBACK = _d(_BRAIN_BACKUP_HOST_ENCODED);

// 对外入口优先走完整 root URL；只有缺失时才退回 host。
const _brainApiRootUrl = resolveProcessEnvValue("BRAIN_API_ROOT_URL");
const _brainHost = resolveProcessEnvValue("BRAIN_API_HOST");
const _brainLegacyApiRootUrl = resolveProcessEnvValue("BRAIN_LEGACY_API_ROOT_URL");
const _brainLegacyHost = resolveProcessEnvValue("BRAIN_LEGACY_HOST");

export const BRAIN_API_ROOT = normalizeApiRoot(
  _brainApiRootUrl,
  normalizeApiRoot(_brainHost, _BRAIN_FALLBACK) + "/api",
);

// 容灾 API Root（当主地址不可达时使用）
export const BRAIN_BACKUP_API_ROOT = normalizeApiRoot(
  resolveProcessEnvValue("BRAIN_BACKUP_API_ROOT_URL"),
  normalizeApiRoot(resolveProcessEnvValue("BRAIN_BACKUP_HOST"), _BRAIN_BACKUP_FALLBACK) + "/api",
);
export const BRAIN_BACKUP_PROVIDER_BASE_URL = `${BRAIN_BACKUP_API_ROOT}/v1`;
export const BRAIN_LEGACY_API_ROOT = normalizeApiRoot(
  _brainLegacyApiRootUrl,
  normalizeApiRoot(_brainLegacyHost, "https://127.0.0.1") + "/lobster-farm/api",
);
export const BRAIN_PROVIDER_BASE_URL = `${BRAIN_API_ROOT}/v1`;
export const BRAIN_LEGACY_PROVIDER_BASE_URL = `${BRAIN_LEGACY_API_ROOT}/v1`;
export const BRAIN_API_ROOTS = [...new Set([BRAIN_API_ROOT, BRAIN_BACKUP_API_ROOT].filter(Boolean))];
export const BRAIN_PROVIDER_BASE_URLS = [...new Set([BRAIN_PROVIDER_BASE_URL, BRAIN_BACKUP_PROVIDER_BASE_URL].filter(Boolean))];
export const BRAIN_DEPRECATED_API_ROOTS = [...new Set([BRAIN_BACKUP_API_ROOT].filter(Boolean))];
export const BRAIN_DEPRECATED_PROVIDER_BASE_URLS = [...new Set([BRAIN_BACKUP_PROVIDER_BASE_URL].filter(Boolean))];
export const BRAIN_PROVIDER_API = "openai-completions";
export const BRAIN_CHAT_MODEL_ID = "step-3.5-flash-2603";
export const BRAIN_UTILITY_MODEL_ID = "glm-z1-9b-0414";
export const BRAIN_UTILITY_LARGE_MODEL_ID = "step-3.5-flash-2603";
export const BRAIN_SUMMARIZER_MODEL_ID = "step-3.5-flash-2603";
export const BRAIN_COMPILER_MODEL_ID = "step-3.5-flash-2603";
export const BRAIN_DEFAULT_MODEL_ID = BRAIN_CHAT_MODEL_ID;
export const BRAIN_DEFAULT_DISPLAY_NAME = "默认模型";
export const BRAIN_DEFAULT_META_LABEL = "第三方已备案 AI 模型";
export const BRAIN_COMPLIANCE_NOTE = "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度。";
export const BRAIN_USER_NOTICE = "继续使用默认模型，即表示你知悉 Lynn 会为对话、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export const BRAIN_LEGACY_MODEL_IDS = [
  "deepseek-r1-distill-qwen-7b",
];
export const BRAIN_DEFAULT_MODEL_IDS = [
  "step-3.5-flash-2603",
  "glm-z1-9b-0414",
  "qwen3-8b",
  "glm-4-9b-0414",
  "lynn-brain-router",
];
export const BRAIN_ROLE_MODEL_IDS = {
  chat: BRAIN_CHAT_MODEL_ID,
  utility: BRAIN_UTILITY_MODEL_ID,
  utility_large: BRAIN_UTILITY_LARGE_MODEL_ID,
  summarizer: BRAIN_SUMMARIZER_MODEL_ID,
  compiler: BRAIN_COMPILER_MODEL_ID,
};

export function isBrainProvider(provider) {
  return String(provider || "").trim() === BRAIN_PROVIDER_ID;
}

export function isBrainModelId(modelId) {
  const id = String(modelId || "").trim();
  return BRAIN_DEFAULT_MODEL_IDS.includes(id) || BRAIN_LEGACY_MODEL_IDS.includes(id);
}

export function isBrainModelRef(modelId, provider) {
  return isBrainProvider(provider) && isBrainModelId(modelId);
}

export function getBrainDisplayName() {
  return BRAIN_DEFAULT_DISPLAY_NAME;
}

export function getBrainDisplayMetaLabel() {
  return BRAIN_DEFAULT_META_LABEL;
}

export function getBrainComplianceNote() {
  return BRAIN_COMPLIANCE_NOTE;
}

export function getBrainUserNotice() {
  return BRAIN_USER_NOTICE;
}

export function buildBrainProviderConfig() {
  return {
    display_name: BRAIN_PROVIDER_LABEL,
    base_url: BRAIN_PROVIDER_BASE_URL,
    api: BRAIN_PROVIDER_API,
    auth_type: "none",
    models: [...BRAIN_DEFAULT_MODEL_IDS],
  };
}

function normalizeComparableUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function isDeprecatedBrainApiRoot(value) {
  const normalized = normalizeComparableUrl(value);
  return normalized ? BRAIN_DEPRECATED_API_ROOTS.includes(normalized) : false;
}

export function isDeprecatedBrainProviderBaseUrl(value) {
  const normalized = normalizeComparableUrl(value);
  return normalized ? BRAIN_DEPRECATED_PROVIDER_BASE_URLS.includes(normalized) : false;
}

// 设备注册令牌（混淆存储，运行时解码）
const _BRAIN_REG_TOKEN_ENCODED = "MWFhZTdhODhkYzdhOGIzYzk3YmRkMzg3ZjI3NTkwZTgtZ2VyLW5pYXJiLW5ueWw=";
export function getBrainRegistrationToken() {
  return _d(_BRAIN_REG_TOKEN_ENCODED);
}
