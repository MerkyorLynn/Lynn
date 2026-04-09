export const BRAIN_PROVIDER_ID: "brain";
export const BRAIN_PROVIDER_LABEL: "默认模型";
export const BRAIN_API_ROOT: string;
export const BRAIN_LEGACY_API_ROOT: string;
export const BRAIN_PROVIDER_BASE_URL: string;
export const BRAIN_BACKUP_API_ROOT: string;
export const BRAIN_BACKUP_PROVIDER_BASE_URL: string;
export const BRAIN_LEGACY_PROVIDER_BASE_URL: string;
export const BRAIN_API_ROOTS: string[];
export const BRAIN_PROVIDER_BASE_URLS: string[];
export const BRAIN_DEPRECATED_API_ROOTS: string[];
export const BRAIN_DEPRECATED_PROVIDER_BASE_URLS: string[];
export const BRAIN_PROVIDER_API: "openai-completions";
export const BRAIN_CHAT_MODEL_ID: string;
export const BRAIN_UTILITY_MODEL_ID: string;
export const BRAIN_UTILITY_LARGE_MODEL_ID: string;
export const BRAIN_SUMMARIZER_MODEL_ID: string;
export const BRAIN_COMPILER_MODEL_ID: string;
export const BRAIN_DEFAULT_MODEL_ID: string;
export const BRAIN_DEFAULT_DISPLAY_NAME: "默认模型";
export const BRAIN_DEFAULT_META_LABEL: "第三方已备案 AI 模型";
export const BRAIN_COMPLIANCE_NOTE: "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度对话、推理与工具执行链路。";
export const BRAIN_USER_NOTICE: "继续使用默认模型，即表示你知悉 Lynn 会为对话、推理、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export const BRAIN_LEGACY_MODEL_IDS: readonly string[];
export const BRAIN_DEFAULT_MODEL_IDS: readonly string[];
export const BRAIN_ROLE_MODEL_IDS: {
  readonly chat: string;
  readonly utility: string;
  readonly utility_large: string;
  readonly summarizer: string;
  readonly compiler: string;
};
export function isBrainProvider(provider: string | null | undefined): boolean;
export function isBrainModelId(modelId: string | null | undefined): boolean;
export function isBrainModelRef(modelId: string | null | undefined, provider: string | null | undefined): boolean;
export function getBrainDisplayName(): "默认模型";
export function getBrainDisplayMetaLabel(): "第三方已备案 AI 模型";
export function getBrainComplianceNote(): "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度对话、推理与工具执行链路。";
export function getBrainUserNotice(): "继续使用默认模型，即表示你知悉 Lynn 会为对话、推理、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export function isDeprecatedBrainApiRoot(value: string | null | undefined): boolean;
export function isDeprecatedBrainProviderBaseUrl(value: string | null | undefined): boolean;

export interface BrainProviderConfig {
  display_name: string;
  auth_type: "none";
  base_url: string;
  api: string;
  models: string[];
}

export function buildBrainProviderConfig(): BrainProviderConfig;
