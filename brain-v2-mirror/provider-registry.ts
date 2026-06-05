// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import './env-loader.js';
import { envModel, providerId, type Provider, type ProviderId, type ProviderIdLiteral } from './types.js';

const env = (k: string, d: string): string => process.env[k] || d;

type ProviderRegistry = Record<ProviderIdLiteral, Provider>;

const PROVIDER_DEFS = {
  'apex-spark-i-balanced': {
    id: providerId('apex-spark-i-balanced'),
    endpoint: env('APEX_SPARK_BASE', 'http://127.0.0.1:18098/v1'),
    apiKey: 'none',
    // 2026-05-25: 实际 Spark llama-server `-a` alias 是 qwen36-35b-a3b-apex-mtp
    // (lynn-apex-mtp-llamacpp.service)。之前 default 'apex-i-balanced' 跟 server alias
    // mismatch,fallback 触发就 404。
    model: envModel('APEX_SPARK_MODEL', 'qwen36-35b-a3b-apex-mtp'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 300_000,
    health_path: '/health',
    health_probe_ms: 2_500,
    // 2026-05-25: 默认 thinking-off。短 max_tokens 工况下避免 35B 长思考
    // 把 reasoning_content 吃光、content 空、用户拿到空答案。client 通过 reasoning_effort
    // (非 'off' / 'none')显式 opt-in 才走 thinking-on。
    default_thinking: false,
    thinking_control: 'qwen_chat_template',
  },
  // [step-3.7-flash v1] StepFun 云 198B-MoE/11B-A(step_plan 端点),文本兜底头位。
  // reasoning-always(low/med/high 三档,无真 off);wire=openai(content + tools)。
  'step-3.7-flash': {
    id: providerId('step-3.7-flash'),
    endpoint: env('STEP37_BASE', 'https://api.stepfun.com/step_plan/v1'),
    apiKey: env('STEP37_KEY', ''),
    model: envModel('STEP37_MODEL', 'step-3.7-flash'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: false,
    default_reasoning_effort: 'high',
    max_tokens: 32_768,
  },
  'deepseek-chat': {
    id: providerId('deepseek-chat'),
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: envModel('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  'deepseek-pro': {
    id: providerId('deepseek-pro'),
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: envModel('DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  'glm-5-turbo': {
    id: providerId('glm-5-turbo'),
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: envModel('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: false, native_search: true },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  // [glm-coding v1] Year-paid coding plan endpoint, used as VERIFIER_PROVIDER (NOT in universalOrder)
  'glm-coding': {
    id: providerId('glm-coding'),
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: envModel('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
} satisfies ProviderRegistry;

export const PROVIDERS: Record<string, Provider> = PROVIDER_DEFS;

// universalOrder — 单一兜底链路,不按 prompt 内容分支
export const universalOrder = [
  providerId('step-3.7-flash'),        // 头位:StepFun 3.7 Flash high+32K,高 TPS + 推理/编码
  providerId('apex-spark-i-balanced'), // 第二位:本地零成本/隐私 fallback,Spark llama.cpp APEX-I-Balanced
  providerId('deepseek-chat'),         // 云兜底 V4-flash
  providerId('deepseek-pro'),          // 云兜底 V4-pro
  providerId('glm-5-turbo'),           // 末位
] as const satisfies readonly ProviderId[];

export function providerOrderForCapability(capabilityRequired?: { vision?: boolean; audio?: boolean; video?: boolean }): readonly ProviderId[] {
  // 当前 build 无任何 vision/audio/video provider,多模态无供应商。
  // 仍返回 universalOrder;下游 capability gate(router.run pre-flight)会发现没有
  // capable provider 并抛 CAPABILITY_NOT_SUPPORTED 友好错误,不会崩。
  if (capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video) {
    return universalOrder;
  }
  return universalOrder;
}

// 健康/cooldown 状态(in-memory,不持久化)
type CooldownState = { unhealthyUntil: number; reason: string };
const cooldownState = new Map<ProviderId, CooldownState>(); // providerId → { unhealthyUntil: timestamp }

export function isInCooldown(providerId: ProviderId): boolean {
  const s = cooldownState.get(providerId);
  if (!s) return false;
  return Date.now() < s.unhealthyUntil;
}
export function markUnhealthy(providerId: ProviderId, reason = '', cooldownMs: number | null = null): void {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  const duration = Number.isFinite(cooldownMs) && cooldownMs !== null && cooldownMs > 0
    ? cooldownMs
    : provider.cooldown_ms;
  cooldownState.set(providerId, { unhealthyUntil: Date.now() + duration, reason });
}
export function clearUnhealthy(providerId: ProviderId): void {
  cooldownState.delete(providerId);
}
export function getProvider(id: ProviderId | string): Provider | null { return PROVIDERS[id as ProviderId] || null; }

export type ProviderCredentialStatus = 'set' | 'missing' | 'not_required';

export interface ProviderStatusSnapshotEntry {
  id: string;
  model: string;
  endpoint: string;
  wire: string;
  capability: Provider['capability'];
  credential: ProviderCredentialStatus;
  configured: boolean;
  local: boolean;
  inRoute: boolean;
}

export interface ProviderStatusSnapshot {
  ok: true;
  route: string[];
  providers: ProviderStatusSnapshotEntry[];
}

function credentialStatus(provider: Provider): ProviderCredentialStatus {
  if (provider.apiKey === 'none' || provider.health_path) return 'not_required';
  return provider.apiKey ? 'set' : 'missing';
}

export function getProviderStatusSnapshot(capabilityRequired?: { vision?: boolean; audio?: boolean; video?: boolean }): ProviderStatusSnapshot {
  const route = providerOrderForCapability(capabilityRequired).map(String);
  const routeSet = new Set(route);
  return {
    ok: true,
    route,
    providers: Object.values(PROVIDERS).map((provider) => {
      const credential = credentialStatus(provider);
      return {
        id: String(provider.id),
        model: String(provider.model),
        endpoint: provider.endpoint,
        wire: provider.wire,
        capability: provider.capability,
        credential,
        configured: credential !== 'missing',
        local: provider.apiKey === 'none' || Boolean(provider.health_path),
        inRoute: routeSet.has(String(provider.id)),
      };
    }),
  };
}

// C21: snapshot for /v2/state metrics endpoint
export function getCooldownState(): Record<string, { remainingMs: number; reason: string }> {
  const now = Date.now();
  const out: Record<string, { remainingMs: number; reason: string }> = {};
  for (const [id, st] of cooldownState.entries()) {
    if (st.unhealthyUntil > now) {
      out[id] = { remainingMs: st.unhealthyUntil - now, reason: st.reason || '' };
    }
  }
  return out;
}
