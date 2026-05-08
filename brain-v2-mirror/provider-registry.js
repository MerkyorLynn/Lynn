// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import 'dotenv/config';

const env = (k, d) => process.env[k] || d;

export const PROVIDERS = {
  'mimo': {
    id: 'mimo',
    endpoint: env('MIMO_SEARCH_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_SEARCH_KEY', ''),
    model: env('MIMO_SEARCH_MODEL', 'mimo-v2.5-pro'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: true },
    wire: 'mimo',
    cooldown_ms: 300_000,
  },
  'qwen3.6-35b-a3b': {
    id: 'qwen3.6-35b-a3b',
    endpoint: env('QWEN_LOCAL_BASE_FALLBACK', 'http://127.0.0.1:18002/v1'),
    apiKey: 'none',
    model: env('QWEN_LOCAL_MODEL_FALLBACK', 'Qwen3.6-35B-A3B-FP8'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'sglang',
    cooldown_ms: 300_000,
  },
  'deepseek-chat': {
    id: 'deepseek-chat',
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  'deepseek-pro': {
    id: 'deepseek-pro',
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: env('DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  'glm-5-turbo': {
    id: 'glm-5-turbo',
    endpoint: env('ZHIPU_BASE', 'https://open.bigmodel.cn/api/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: env('ZHIPU_MODEL', 'glm-5-turbo'),
    capability: { vision: false, audio: false, tools: true, thinking: false, native_search: true },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  // [glm-coding v1] Year-paid coding plan endpoint, used as VERIFIER_PROVIDER (NOT in universalOrder)
  'glm-coding': {
    id: 'glm-coding',
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: env('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
};

// universalOrder — 单一兜底链路,不按 prompt 内容分支
export const universalOrder = [
  'mimo',                  // 头位:enable_search:true 内置搜索 + thinking
  'qwen3.6-35b-a3b',       // DGX SGLang FP8 备链
  'deepseek-chat',         // 云兜底 V4-flash
  'deepseek-pro',          // 云兜底 V4-pro
  'glm-5-turbo',           // 末位
];

// 健康/cooldown 状态(in-memory,不持久化)
const cooldownState = new Map(); // providerId → { unhealthyUntil: timestamp }

export function isInCooldown(providerId) {
  const s = cooldownState.get(providerId);
  if (!s) return false;
  return Date.now() < s.unhealthyUntil;
}
export function markUnhealthy(providerId, reason = '') {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  cooldownState.set(providerId, { unhealthyUntil: Date.now() + provider.cooldown_ms, reason });
}
export function clearUnhealthy(providerId) {
  cooldownState.delete(providerId);
}
export function getProvider(id) { return PROVIDERS[id] || null; }
