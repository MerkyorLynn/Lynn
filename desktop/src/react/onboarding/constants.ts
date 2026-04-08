/**
 * constants.ts — Onboarding wizard constants
 */

import {
  BRAIN_PROVIDER_ID,
  BRAIN_DEFAULT_DISPLAY_NAME,
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

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: BRAIN_PROVIDER_ID, label: BRAIN_DEFAULT_DISPLAY_NAME, labelZh: BRAIN_DEFAULT_DISPLAY_NAME, url: QUICK_START_PROVIDER.providerUrl, api: QUICK_START_PROVIDER.providerApi, defaultModelId: QUICK_START_PROVIDER.defaultModelId, noKey: true, group: 'standard' },
  { value: 'ollama',      label: 'Ollama (Local)',       labelZh: 'Ollama (本地)',        url: 'http://localhost:11434/v1', api: 'openai-completions', local: true, group: 'standard' },
  { value: 'dashscope',   label: 'DashScope (Qwen)',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', group: 'standard' },
  { value: 'openai',      label: 'OpenAI',               url: 'https://api.openai.com/v1', api: 'openai-completions', group: 'standard' },
  { value: 'deepseek',    label: 'DeepSeek',             url: 'https://api.deepseek.com/v1', api: 'openai-completions', group: 'standard' },
  { value: 'volcengine',  label: 'Volcengine (Doubao)',  labelZh: 'Volcengine (豆包)',    url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions', group: 'standard' },
  { value: 'moonshot',    label: 'Moonshot (Kimi)',      url: 'https://api.moonshot.cn/v1', api: 'openai-completions', group: 'standard' },
  { value: 'zhipu',       label: 'Zhipu (GLM)',          url: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', group: 'standard' },
  { value: 'siliconflow', label: 'SiliconFlow',          url: 'https://api.siliconflow.cn/v1', api: 'openai-completions', defaultModelId: 'THUDM/GLM-Z1-9B-0414', signupUrl: 'https://cloud.siliconflow.cn/i/OmAO8v3e', group: 'standard' },
  { value: 'groq',        label: 'Groq',                 url: 'https://api.groq.com/openai/v1', api: 'openai-completions', group: 'standard' },
  { value: 'mistral',     label: 'Mistral',              url: 'https://api.mistral.ai/v1', api: 'openai-completions', group: 'standard' },
  { value: 'minimax',     label: 'MiniMax',              url: 'https://api.minimaxi.com/v1', api: 'openai-completions', group: 'standard' },
  { value: 'minimax-coding',   label: 'MiniMax Coding Plan',      labelZh: 'MiniMax Coding Plan',      url: 'https://api.minimaxi.com/v1', api: 'openai-completions', group: 'coding-plan' },
  { value: 'kimi-coding',      label: 'Kimi Coding Plan',         labelZh: 'Kimi Coding Plan',         url: 'https://api.kimi.com/coding/', api: 'anthropic-messages', group: 'coding-plan' },
  { value: 'zhipu-coding',     label: 'Zhipu Coding Plan',        labelZh: '智谱 Coding Plan',         url: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions', group: 'coding-plan' },
  { value: 'stepfun-coding',   label: 'StepFun Coding Plan',      labelZh: '阶跃星辰 Coding Plan',     url: 'https://api.stepfun.com/step_plan/v1', api: 'openai-completions', group: 'coding-plan' },
  { value: 'tencent-coding',   label: 'Tencent Coding Plan',      labelZh: '腾讯云 Coding Plan',       url: 'https://api.lkeap.cloud.tencent.com/coding/v3', api: 'openai-completions', group: 'coding-plan' },
  { value: 'volcengine-coding',label: 'Volcengine Coding Plan',   labelZh: '火山引擎 Coding Plan',     url: 'https://ark.cn-beijing.volces.com/api/coding/v1', api: 'openai-completions', group: 'coding-plan' },
  { value: 'dashscope-coding', label: 'DashScope Coding Plan',    labelZh: '百炼 Coding Plan',         url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', group: 'coding-plan' },
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true, group: 'standard' },
];

export const OB_THEMES = [
  'warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma',
  'contemplation', 'absolutely', 'delve', 'deep-think',
] as const;

export function themeKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
