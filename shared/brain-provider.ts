export const BRAIN_PROVIDER_ID = "brain";
export const BRAIN_PROVIDER_LABEL = "默认模型";

export type BrainProviderId = typeof BRAIN_PROVIDER_ID;
export type BrainProviderApi = "openai-completions";
export type BrainRole =
  | "chat"
  | "utility"
  | "utility_large"
  | "summarizer"
  | "compiler";

export interface BrainProviderConfig {
  display_name: string;
  base_url: string;
  api: BrainProviderApi;
  auth_type: "none";
  models: string[];
}

function normalizeApiRoot(rawValue: unknown, fallbackValue: string): string {
  const normalized = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!normalized) return fallbackValue;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `https://${normalized}`;
}

function resolveProcessEnvValue(key: string): string {
  if (typeof process === "undefined" || !process?.env) return "";
  return process.env[key] || "";
}

// ── 运行时端点解析（混淆） ──
// Endpoint names are public configuration; encoding is not a security boundary.
function _d(encoded: string): string {
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

// A backup must preserve HTTPS. Deployments may configure a separate TLS domain.
const _BRAIN_BACKUP_FALLBACK = _BRAIN_FALLBACK;

// 对外入口优先走完整 root URL；只有缺失时才退回 host。
const _brainApiRootUrl = resolveProcessEnvValue("BRAIN_API_ROOT_URL");
const _brainHost = resolveProcessEnvValue("BRAIN_API_HOST");
const _brainLegacyApiRootUrl = resolveProcessEnvValue("BRAIN_LEGACY_API_ROOT_URL");
const _brainLegacyHost = resolveProcessEnvValue("BRAIN_LEGACY_HOST");

// v0.79 policy:
// The built-in default model enters through Brain v2. These deprecated lists are
// used by settings/onboarding code to recognize older first-party Brain URLs;
// custom/BYOK provider URLs are not affected.
export const BRAIN_API_ROOT = normalizeApiRoot(
  _brainApiRootUrl,
  normalizeApiRoot(_brainHost, _BRAIN_FALLBACK) + "/api/v2",
);

// 容灾 API Root（当主地址不可达时使用）
export const BRAIN_BACKUP_API_ROOT = normalizeApiRoot(
  resolveProcessEnvValue("BRAIN_BACKUP_API_ROOT_URL"),
  normalizeApiRoot(resolveProcessEnvValue("BRAIN_BACKUP_HOST"), _BRAIN_BACKUP_FALLBACK) + "/api/v2",
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
export const BRAIN_DEPRECATED_API_ROOTS = [
  "https://api.merkyorlynn.com/api",
  "http://82.156.182.240/api",
];
export const BRAIN_DEPRECATED_PROVIDER_BASE_URLS = [
  "https://api.merkyorlynn.com/api/v1",
  "http://82.156.182.240/api/v1",
];
export const BRAIN_PROVIDER_API = "openai-completions";
const _BRAIN_MODEL_PRIMARY_ENCODED = "MzA2Mi1oc2FsZi01LjMtcGV0cw==";
const _BRAIN_MODEL_UTILITY_ENCODED = "NDE0MC1iOS0xei1tbGc=";
const _BRAIN_MODEL_AUX_1_ENCODED = "YjgtM25ld3E=";
const _BRAIN_MODEL_AUX_2_ENCODED = "NDE0MC1iOS00LW1sZw==";
const _BRAIN_MODEL_STEP5_ENCODED = "d2VpdmVycC01LXBldHM=";
const _BRAIN_MODEL_ROUTER_ENCODED = "cmV0dW9yLW5pYXJiLW5ueWw=";
const _BRAIN_MODEL_LEGACY_ENCODED = "YjctbmV3cS1sbGl0c2lkLTFyLWtlZXNwZWVk";

// User-facing default roles request Step 5. The router ID stays accepted so
// existing GUI/CLI configs keep resolving to the same Brain default route.
export const BRAIN_CHAT_MODEL_ID = _d(_BRAIN_MODEL_STEP5_ENCODED);
export const BRAIN_UTILITY_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_UTILITY_LARGE_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_SUMMARIZER_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_COMPILER_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_DEFAULT_MODEL_ID = BRAIN_CHAT_MODEL_ID;
export const BRAIN_DEFAULT_DISPLAY_NAME = "默认模型";
export const BRAIN_DEFAULT_META_LABEL = "第三方已备案 AI 模型";
export const BRAIN_COMPLIANCE_NOTE = "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度对话、推理与工具执行链路。";
export const BRAIN_USER_NOTICE = "继续使用默认模型，即表示你知悉 Lynn 会为对话、推理、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export const BRAIN_LEGACY_MODEL_IDS: readonly string[] = [
  _d(_BRAIN_MODEL_ROUTER_ENCODED),
  _d(_BRAIN_MODEL_LEGACY_ENCODED),
];
export const BRAIN_DEFAULT_MODEL_IDS: readonly string[] = [
  _d(_BRAIN_MODEL_STEP5_ENCODED),
  _d(_BRAIN_MODEL_ROUTER_ENCODED),
  _d(_BRAIN_MODEL_PRIMARY_ENCODED),
  _d(_BRAIN_MODEL_UTILITY_ENCODED),
  _d(_BRAIN_MODEL_AUX_1_ENCODED),
  _d(_BRAIN_MODEL_AUX_2_ENCODED),
];
export const BRAIN_ROLE_MODEL_IDS: Readonly<Record<BrainRole, string>> = {
  chat: BRAIN_CHAT_MODEL_ID,
  utility: BRAIN_UTILITY_MODEL_ID,
  utility_large: BRAIN_UTILITY_LARGE_MODEL_ID,
  summarizer: BRAIN_SUMMARIZER_MODEL_ID,
  compiler: BRAIN_COMPILER_MODEL_ID,
};

export function isBrainProvider(provider: string | null | undefined): provider is BrainProviderId {
  return String(provider || "").trim() === BRAIN_PROVIDER_ID;
}

export function isBrainModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || "").trim();
  return BRAIN_DEFAULT_MODEL_IDS.includes(id) || BRAIN_LEGACY_MODEL_IDS.includes(id);
}

export function isBrainModelRef(modelId: string | null | undefined, provider: string | null | undefined): boolean {
  return isBrainProvider(provider) && isBrainModelId(modelId);
}

export function getBrainDisplayName(): typeof BRAIN_DEFAULT_DISPLAY_NAME {
  return BRAIN_DEFAULT_DISPLAY_NAME;
}

export function getBrainDisplayMetaLabel(): typeof BRAIN_DEFAULT_META_LABEL {
  return BRAIN_DEFAULT_META_LABEL;
}

export function getBrainComplianceNote(): typeof BRAIN_COMPLIANCE_NOTE {
  return BRAIN_COMPLIANCE_NOTE;
}

export function getBrainUserNotice(): typeof BRAIN_USER_NOTICE {
  return BRAIN_USER_NOTICE;
}

export function sanitizeBrainIdentityDisclosureText(raw: unknown): string {
  return String(raw || "");
}

export function buildBrainProviderConfig(): BrainProviderConfig {
  return {
    display_name: BRAIN_PROVIDER_LABEL,
    base_url: BRAIN_PROVIDER_BASE_URL,
    api: BRAIN_PROVIDER_API,
    auth_type: "none",
    models: [...BRAIN_DEFAULT_MODEL_IDS],
  };
}

function normalizeComparableUrl(value: unknown): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function isDeprecatedBrainApiRoot(value: string | null | undefined): boolean {
  const normalized = normalizeComparableUrl(value);
  return normalized ? BRAIN_DEPRECATED_API_ROOTS.includes(normalized) : false;
}

export function isDeprecatedBrainProviderBaseUrl(value: string | null | undefined): boolean {
  const normalized = normalizeComparableUrl(value);
  return normalized ? BRAIN_DEPRECATED_PROVIDER_BASE_URLS.includes(normalized) : false;
}

// 设备注册令牌（混淆存储，运行时解码）
const _BRAIN_REG_TOKEN_ENCODED = "MWFhZTdhODhkYzdhOGIzYzk3YmRkMzg3ZjI3NTkwZTgtZ2VyLW5pYXJiLW5ueWw=";
export function getBrainRegistrationToken(): string {
  return _d(_BRAIN_REG_TOKEN_ENCODED);
}
