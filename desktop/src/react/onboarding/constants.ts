/**
 * constants.ts — Onboarding wizard constants
 */

import {
  BRAIN_PROVIDER_ID,
  BRAIN_DEFAULT_DISPLAY_NAME,
  BRAIN_DEFAULT_DISPLAY_NAME_EN,
  BRAIN_PROVIDER_BASE_URL,
  BRAIN_PROVIDER_API,
  BRAIN_DEFAULT_MODEL_ID,
} from '../../../../shared/brain-provider.js';

export const AGENT_ID = 'lynn';
export const TOTAL_STEPS = 6;

export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja',    label: '日本語' },
  { value: 'ko',    label: '한국어' },
  { value: 'en',    label: 'English' },
] as const;

export interface ProviderPreset {
  value: string;
  label: string;
  labelZh?: string;
  url: string;
  api: string;
  group?: 'standard' | 'coding-plan';
  /**
   * Tier controls onboarding visibility:
   *   - 'primary'  : shown by default (top 8 most-used)
   *   - 'secondary': hidden behind the "more providers" disclosure
   * Custom entry (`_custom`) is always primary so users can still type a
   * provider name without expanding the secondary list.
   */
  tier?: 'primary' | 'secondary';
  defaultModelId?: string;
  signupUrl?: string;
  local?: boolean;
  noKey?: boolean;
  custom?: boolean;
}

export const QUICK_START_PROVIDER = {
  providerName: BRAIN_PROVIDER_ID,
  providerUrl: BRAIN_PROVIDER_BASE_URL,
  providerApi: BRAIN_PROVIDER_API,
  defaultModelId: BRAIN_DEFAULT_MODEL_ID,
} as const;

/**
 * Quick-local track wires the user straight into the server-side local Qwen
 * provider. The provider id and endpoint name stay legacy-compatible, while the
 * default downloadable model is Qwen3.8-27B Coder390 Q3.
 * 16GB and above defaults to Q3; below 16GB uses Q2.
 */
export const QUICK_LOCAL_PROVIDER = {
  providerName: 'local-qwen35-9b-q4km-imatrix',
  providerUrl: 'http://127.0.0.1:18099/v1',
  providerApi: 'openai-completions',
  defaultModelId: 'qwen38-27b-coder390-q3-lynnstyle',
} as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // Primary (top 8 most-used) — shown by default in onboarding.
  { value: BRAIN_PROVIDER_ID, label: BRAIN_DEFAULT_DISPLAY_NAME_EN, labelZh: BRAIN_DEFAULT_DISPLAY_NAME, url: QUICK_START_PROVIDER.providerUrl, api: QUICK_START_PROVIDER.providerApi, defaultModelId: QUICK_START_PROVIDER.defaultModelId, noKey: true, group: 'standard', tier: 'primary' },
  { value: QUICK_LOCAL_PROVIDER.providerName, label: 'Lynn Local (Qwen3.8-27B)', labelZh: 'Lynn 本地 (Qwen3.8-27B)', url: QUICK_LOCAL_PROVIDER.providerUrl, api: QUICK_LOCAL_PROVIDER.providerApi, local: true, noKey: true, defaultModelId: QUICK_LOCAL_PROVIDER.defaultModelId, group: 'standard', tier: 'primary' },
  { value: 'openai',      label: 'OpenAI',               url: 'https://api.openai.com/v1', api: 'openai-completions', group: 'standard', tier: 'primary' },
  { value: 'deepseek',    label: 'DeepSeek',             url: 'https://api.deepseek.com/v1', api: 'openai-completions', group: 'standard', tier: 'primary' },
  { value: 'dashscope',   label: 'DashScope (Qwen)',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', group: 'standard', tier: 'primary' },
  { value: 'moonshot',    label: 'Moonshot (Kimi)',      url: 'https://api.moonshot.cn/v1', api: 'openai-completions', group: 'standard', tier: 'primary' },
  { value: 'zhipu',       label: 'Zhipu (GLM)',          url: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', group: 'standard', tier: 'primary' },
  { value: 'volcengine',  label: 'Volcengine (Doubao)',  labelZh: 'Volcengine (豆包)',    url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions', group: 'standard', tier: 'primary' },

  // Secondary — collapsed behind the "more providers" disclosure.
  { value: 'ollama',      label: 'Ollama (Local)',       labelZh: 'Ollama (本地)',        url: 'http://localhost:11434/v1', api: 'openai-completions', local: true, group: 'standard', tier: 'secondary' },
  { value: 'siliconflow', label: 'SiliconFlow',          url: 'https://api.siliconflow.cn/v1', api: 'openai-completions', defaultModelId: 'THUDM/GLM-Z1-9B-0414', signupUrl: 'https://cloud.siliconflow.cn/i/OmAO8v3e', group: 'standard', tier: 'secondary' },
  { value: 'groq',        label: 'Groq',                 url: 'https://api.groq.com/openai/v1', api: 'openai-completions', group: 'standard', tier: 'secondary' },
  { value: 'mistral',     label: 'Mistral',              url: 'https://api.mistral.ai/v1', api: 'openai-completions', group: 'standard', tier: 'secondary' },
  { value: 'minimax',     label: 'MiniMax',              url: 'https://api.minimaxi.com/v1', api: 'openai-completions', group: 'standard', tier: 'secondary' },

  // Coding-plan tier (all secondary — surfaced via the existing tab switch).
  { value: 'minimax-coding',   label: 'MiniMax Coding Plan',      labelZh: 'MiniMax Coding Plan',      url: 'https://api.minimaxi.com/v1', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },
  { value: 'kimi-coding',      label: 'Kimi Coding Plan',         labelZh: 'Kimi Coding Plan',         url: 'https://api.kimi.com/coding/', api: 'anthropic-messages', group: 'coding-plan', tier: 'secondary' },
  { value: 'zhipu-coding',     label: 'Zhipu Coding Plan',        labelZh: '智谱 Coding Plan',         url: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },
  { value: 'stepfun-coding',   label: 'StepFun Coding Plan',      labelZh: '阶跃星辰 Coding Plan',     url: 'https://api.stepfun.com/step_plan/v1', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },
  { value: 'tencent-coding',   label: 'Tencent Coding Plan',      labelZh: '腾讯云 Coding Plan',       url: 'https://api.lkeap.cloud.tencent.com/coding/v3', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },
  { value: 'volcengine-coding',label: 'Volcengine Coding Plan',   labelZh: '火山引擎 Coding Plan',     url: 'https://ark.cn-beijing.volces.com/api/coding/v1', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },
  { value: 'dashscope-coding', label: 'DashScope Coding Plan',    labelZh: '百炼 Coding Plan',         url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', group: 'coding-plan', tier: 'secondary' },

  // Custom is always visible (no tier filter applied).
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true, group: 'standard', tier: 'primary' },
];

export const OB_THEMES = [
  'warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma',
  'contemplation', 'absolutely', 'delve', 'deep-think',
] as const;

/**
 * Primary themes shown on first paint of ThemeStep. The remaining four
 * (contemplation / absolutely / delve / deep-think) are tucked behind a
 * "more themes" toggle to keep the onboarding card scannable.
 */
export const OB_PRIMARY_THEMES = [
  'warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma',
] as const;

export const OB_ADVANCED_THEMES = [
  'contemplation', 'absolutely', 'delve', 'deep-think',
] as const;

export function themeKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
