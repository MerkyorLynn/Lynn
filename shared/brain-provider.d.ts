export const BRAIN_PROVIDER_ID: "brain";
export const BRAIN_PROVIDER_LABEL: "Brain";
export const BRAIN_API_ROOT: string;
export const BRAIN_LEGACY_API_ROOT: string;
export const BRAIN_PROVIDER_BASE_URL: string;
export const BRAIN_LEGACY_PROVIDER_BASE_URL: string;
export const BRAIN_PROVIDER_API: "openai-completions";
export const BRAIN_CHAT_MODEL_ID: "step-3.5-flash-2603";
export const BRAIN_UTILITY_MODEL_ID: "glm-z1-9b-0414";
export const BRAIN_UTILITY_LARGE_MODEL_ID: "step-3.5-flash-2603";
export const BRAIN_SUMMARIZER_MODEL_ID: "step-3.5-flash-2603";
export const BRAIN_COMPILER_MODEL_ID: "step-3.5-flash-2603";
export const BRAIN_DEFAULT_MODEL_ID: "step-3.5-flash-2603";
export const BRAIN_DEFAULT_DISPLAY_NAME: "默认模型";
export const BRAIN_DEFAULT_META_LABEL: "第三方已备案 AI 模型";
export const BRAIN_COMPLIANCE_NOTE: "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度。";
export const BRAIN_USER_NOTICE: "继续使用默认模型，即表示你知悉 Lynn 会为对话、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";
export const BRAIN_LEGACY_MODEL_IDS: readonly [
  "deepseek-r1-distill-qwen-7b",
];
export const BRAIN_DEFAULT_MODEL_IDS: readonly [
  "step-3.5-flash-2603",
  "glm-z1-9b-0414",
  "qwen3-8b",
  "glm-4-9b-0414",
  "lynn-brain-router",
];
export const BRAIN_ROLE_MODEL_IDS: {
  readonly chat: "step-3.5-flash-2603";
  readonly utility: "glm-z1-9b-0414";
  readonly utility_large: "step-3.5-flash-2603";
  readonly summarizer: "step-3.5-flash-2603";
  readonly compiler: "step-3.5-flash-2603";
};
export function isBrainProvider(provider: string | null | undefined): boolean;
export function isBrainModelId(modelId: string | null | undefined): boolean;
export function isBrainModelRef(modelId: string | null | undefined, provider: string | null | undefined): boolean;
export function getBrainDisplayName(): "默认模型";
export function getBrainDisplayMetaLabel(): "第三方已备案 AI 模型";
export function getBrainComplianceNote(): "默认模型服务接入第三方已备案 AI 模型，由 Lynn 统一调度。";
export function getBrainUserNotice(): "继续使用默认模型，即表示你知悉 Lynn 会为对话、摘要与工具协作向第三方已备案 AI 模型服务发起必要请求。你也可以在供应商设置中改用自己的模型服务。";

export interface BrainProviderConfig {
  display_name: string;
  auth_type: "none";
  base_url: string;
  api: string;
  models: string[];
}

export function buildBrainProviderConfig(): BrainProviderConfig;
