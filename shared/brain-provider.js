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

// v0.78 policy:
// New installs default to Brain v2. Existing users keep the base_url persisted in
// ~/.lynn/added-models.yaml or preferences, so stable v1 installs are not
// force-migrated by a desktop upgrade.
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
export const BRAIN_DEPRECATED_API_ROOTS = [];
export const BRAIN_DEPRECATED_PROVIDER_BASE_URLS = [];
export const BRAIN_PROVIDER_API = "openai-completions";
const _BRAIN_MODEL_PRIMARY_ENCODED = "MzA2Mi1oc2FsZi01LjMtcGV0cw==";
const _BRAIN_MODEL_UTILITY_ENCODED = "NDE0MC1iOS0xei1tbGc=";
const _BRAIN_MODEL_AUX_1_ENCODED = "YjgtM25ld3E=";
const _BRAIN_MODEL_AUX_2_ENCODED = "NDE0MC1iOS00LW1sZw==";
const _BRAIN_MODEL_ROUTER_ENCODED = "cmV0dW9yLW5pYXJiLW5ueWw=";
const _BRAIN_MODEL_LEGACY_ENCODED = "YjctbmV3cS1sbGl0c2lkLTFyLWtlZXNwZWVk";

// All user-facing default roles enter through the Brain router. Older concrete
// model IDs remain listed below only for migration/display compatibility.
export const BRAIN_CHAT_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_UTILITY_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_UTILITY_LARGE_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_SUMMARIZER_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_COMPILER_MODEL_ID = _d(_BRAIN_MODEL_ROUTER_ENCODED);
export const BRAIN_DEFAULT_MODEL_ID = BRAIN_CHAT_MODEL_ID;
export const BRAIN_DEFAULT_DISPLAY_NAME = "默认模型";
export const BRAIN_DEFAULT_META_LABEL = "第三方已备案 AI 模型";
export const BRAIN_COMPLIANCE_NOTE = "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度对话、推理与工具执行链路。";
export const BRAIN_USER_NOTICE = "继续使用默认模型，即表示你知悉 Lynn 会为对话、推理、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export const BRAIN_LEGACY_MODEL_IDS = [
  _d(_BRAIN_MODEL_LEGACY_ENCODED),
];
export const BRAIN_DEFAULT_MODEL_IDS = [
  _d(_BRAIN_MODEL_ROUTER_ENCODED),
  _d(_BRAIN_MODEL_PRIMARY_ENCODED),
  _d(_BRAIN_MODEL_UTILITY_ENCODED),
  _d(_BRAIN_MODEL_AUX_1_ENCODED),
  _d(_BRAIN_MODEL_AUX_2_ENCODED),
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

export function sanitizeBrainIdentityDisclosureText(raw) {
  const source = String(raw || "");
  if (!source) return source;

  const genericZh = "我当前使用的是 Lynn 的默认模型服务。";
  const genericEn = "I’m currently running on Lynn's default model service.";
  const prefersZh = /[\u3400-\u9fff]/u.test(source);
  const _BRAIN_UPSTREAM_TOKEN_ENCODINGS = [
    "bWxn",
    "6K+65pm6",
    "Z25pZG9jLXVwaWh6",
    "cGV0cw==",
    "bmV3cQ==",
    "eGFtaW5pbQ==",
    "aW1paw==",
    "5YWD5re3",
    "a2Vlc3BlZWQ=",
    "dXBpaHo=",
    "bmF5bnVo",
  ];
  const upstreamPattern = new RegExp(
    `(${_BRAIN_UPSTREAM_TOKEN_ENCODINGS.map(_d).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "iu",
  );
  const zhIdentityPattern = /(我(?:目前|当前|现在)?(?:正在)?(?:运行|使用|用的)?(?:是)?|当前(?:运行|使用)的是|我是)/u;
  const enIdentityPattern = /(I(?:'m| am)?(?: currently| now)?(?: running| using)?(?: on)?|The model I(?:'m| am)? using is|Currently running on)/iu;
  const detailPattern = /^(?:具体是|后端(?:当前)?(?:会)?(?:动态)?路由到|底层(?:当前)?(?:会)?(?:动态)?路由到|Specifically|Under the hood|Behind the scenes)/iu;

  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split(/(\n+)/u);
  const sanitized = [];

  for (const line of lines) {
    if (/^\n+$/u.test(line)) {
      sanitized.push(line);
      continue;
    }
    const sentences = line.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)/u);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (detailPattern.test(trimmed) && upstreamPattern.test(trimmed)) {
        continue;
      }
      if (zhIdentityPattern.test(trimmed) && upstreamPattern.test(trimmed)) {
        sanitized.push(genericZh);
        continue;
      }
      if (enIdentityPattern.test(trimmed) && upstreamPattern.test(trimmed)) {
        sanitized.push(genericEn);
        continue;
      }
      sanitized.push(trimmed);
    }
  }

  let output = sanitized
    .join(" ")
    .replace(/(?:我当前使用的是 Lynn 的默认模型服务。\s*){2,}/g, genericZh)
    .replace(/(?:I’m currently running on Lynn's default model service\.\s*){2,}/g, genericEn)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (prefersZh) {
    output = output.replace(/I’m currently running on Lynn's default model service\./g, genericZh);
  }

  return output
    .replace(/([。！？])\s+/g, "$1")
    .replace(/(?:我当前使用的是 Lynn 的默认模型服务。\s*){2,}/g, genericZh)
    .trim();
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
