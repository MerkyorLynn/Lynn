// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import './env-loader.js';
import { positiveEnvNumber } from './env-utils.js';
import { providerTimeoutPolicy } from './provider-timeouts.js';
import { envModel, providerId, type Provider, type ProviderId, type ProviderIdLiteral } from './types.js';
const DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY = 1;

const env = (k: string, d: string): string => process.env[k] || d;

type StaticProviderIdLiteral = Exclude<ProviderIdLiteral, 'p-fake'>;
type ProviderRegistry = Record<StaticProviderIdLiteral, Provider>;

function pFakeEnabled(): boolean {
  return process.env.BRAIN_V2_ENABLE_P_FAKE === '1'
    || process.env.BRAIN_V2_REGRESSION_P_FAKE === '1';
}

const P_FAKE_ENABLED = pFakeEnabled();

function buildPFakeProvider(): Provider {
  return {
    id: providerId('p-fake'),
    endpoint: env('BRAIN_V2_P_FAKE_BASE', 'http://127.0.0.1:65535/v1'),
    apiKey: env('BRAIN_V2_P_FAKE_KEY', 'none'),
    model: envModel('BRAIN_V2_P_FAKE_MODEL', 'p-fake'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: positiveEnvNumber('BRAIN_V2_P_FAKE_COOLDOWN_MS', 1_000),
    health_path: '/models',
    health_probe_ms: positiveEnvNumber('BRAIN_V2_P_FAKE_HEALTH_PROBE_MS', 500),
    default_thinking: false,
    default_reasoning_effort: 'low',
    max_tokens: positiveEnvNumber('BRAIN_V2_P_FAKE_MAX_TOKENS', 4_096),
    timeout_ms: positiveEnvNumber('BRAIN_V2_P_FAKE_TIMEOUT_MS', 5_000),
    temperature: 0,
    authType: 'none',
  };
}

// NOTE: MiMo search is still owned by tool-exec/web_search.ts. Text/agent execution
// uses separate providers so Token Plan Pro and ordinary API UltraSpeed never share keys.
const PROVIDER_DEFS = {
  'apex-spark-i-balanced': {
    id: providerId('apex-spark-i-balanced'),
    endpoint: env('APEX_SPARK_BASE', 'http://127.0.0.1:18098/v1'),
    apiKey: 'none',
    // 2026-06-08: Spark fallback now points at the DS-V4-Pro thinking distilled
    // Q4_K_M orchestrator. Keep the provider id for env/backward compatibility.
    model: envModel('APEX_SPARK_MODEL', 'qwen36-35b-a3b-dsv4pro-distill-q4km-imatrix'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 300_000,
    health_path: '/health',
    health_probe_ms: 2_500,
    timeout_ms: positiveEnvNumber('APEX_SPARK_TIMEOUT_MS', 8_000),
    // 2026-05-25: 默认 thinking-off。短 max_tokens 工况下避免 35B 长思考
    // 把 reasoning_content 吃光、content 空、用户拿到空答案。client 通过 reasoning_effort
    // (非 'off' / 'none')显式 opt-in 才走 thinking-on。
    default_thinking: false,
    thinking_control: 'qwen_chat_template',
  },
  // MiMo ordinary API UltraSpeed is kept registered for explicit regression/eval
  // runs only. Production Brain text routing uses Token Plan Pro as the MiMo lane.
  'mimo-ultraspeed': {
    id: providerId('mimo-ultraspeed'),
    endpoint: env('MIMO_ULTRASPEED_BASE', 'https://api.xiaomimimo.com/v1'),
    apiKey: env('MIMO_ULTRASPEED_KEY', ''),
    model: envModel('MIMO_ULTRASPEED_MODEL', 'mimo-v2.5-pro-ultraspeed'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 30_000,
    default_thinking: true,
    default_reasoning_effort: 'low',
    max_tokens: 16_384,
    timeout_ms: positiveEnvNumber('MIMO_ULTRASPEED_TIMEOUT_MS', 30_000),
    temperature: 0.2,
  },
  // MiMo Token Plan Pro. Quality is usable, but Agent20 showed heavy 90s tail; keep it
  // separate and bounded so a single slow queue does not hold the whole Brain turn.
  'mimo-token-plan-pro': {
    id: providerId('mimo-token-plan-pro'),
    endpoint: env('MIMO_TOKEN_PLAN_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_TOKEN_PLAN_KEY', ''),
    model: envModel('MIMO_TOKEN_PLAN_MODEL', 'mimo-v2.5-pro'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    default_reasoning_effort: 'low',
    max_tokens: 16_384,
    timeout_ms: positiveEnvNumber('MIMO_TOKEN_PLAN_TIMEOUT_MS', 15_000),
    temperature: 0.2,
  },
  // [step-3.7-flash v1] StepFun 云 198B-MoE/11B-A(step_plan 端点)。
  // 2026-05-30 high+48K 评测反超旧文本头位(GPQA/MMLU/TPS),Brain 文本头位切 StepFun;
  // 多模态(vision)也由 StepFun 承接:vision_model=step-1o-turbo-vision,Spark 本地兜底。
  // reasoning-always(low/med/high 三档,无真 off);wire=openai(content + tools)。
  'step-3.7-flash': {
    id: providerId('step-3.7-flash'),
    endpoint: env('STEP37_BASE', 'https://api.stepfun.com/step_plan/v1'),
    apiKey: env('STEP37_KEY', ''),
    model: envModel('STEP37_MODEL', 'step-5-preview'),
    // StepFun covers vision too: text → model (step-3.7-flash), images → vision_model
    // (step-1o-turbo-vision) via the openai-compat adapter switch on image content.
    vision_model: env('STEP_VISION_MODEL', '') || env('STEP37_VISION_MODEL', ''),
    capability: { vision: true, audio: false, video: true, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: false,
    default_reasoning_effort: 'low',
    timeout_ms: positiveEnvNumber('STEP37_TIMEOUT_MS', 35_000),
    // 48K (was 32K): reasoning + answer + tool-call share this one output budget. At high
    // reasoning, hard tasks overflowed 32K mid-<think> → finish_reason=length → empty answer.
    max_tokens: 49_152,
  },
  // MiMo Token Plan multimodal fallback. Official docs expose image/audio/video understanding
  // through the OpenAI-compatible chat completions API; use it after StepFun for image/video,
  // and as the first native audio-capable provider in the multimodal route.
  'mimo-multimodal': {
    id: providerId('mimo-multimodal'),
    endpoint: env('MIMO_MULTIMODAL_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_MULTIMODAL_KEY', ''),
    model: envModel('MIMO_MULTIMODAL_MODEL', 'mimo-v2.5'),
    capability: { vision: true, audio: true, video: true, tools: false, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    timeout_ms: positiveEnvNumber('MIMO_MULTIMODAL_TIMEOUT_MS', 45_000),
    max_tokens: 8_192,
    temperature: 0.2,
  },
  'deepseek-chat': {
    id: providerId('deepseek-chat'),
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: envModel('DEEPSEEK_MODEL', 'deepseek-v4-flash-vision-exp'),
    capability: { vision: true, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    timeout_ms: positiveEnvNumber('DEEPSEEK_CHAT_TIMEOUT_MS', 45_000),
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
    timeout_ms: positiveEnvNumber('DEEPSEEK_PRO_TIMEOUT_MS', 10_000),
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
    timeout_ms: positiveEnvNumber('ZHIPU_CODING_TIMEOUT_MS', 12_000),
  },
  // GLM Coding Plan. GLM-5.3-Flash is the first cloud takeover after StepFun and
  // the primary multimodal review model. DS V4 Flash remains the immediate text fallback.
  'glm-coding': {
    id: providerId('glm-coding'),
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: envModel('ZHIPU_CODING_FLASH_MODEL', 'GLM-5.3-Flash'),
    capability: { vision: true, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    default_reasoning_effort: 'low',
    timeout_ms: positiveEnvNumber('ZHIPU_CODING_FLASH_TIMEOUT_MS', 35_000),
  },
} satisfies ProviderRegistry;

export const PROVIDERS: Record<string, Provider> = P_FAKE_ENABLED
  ? { 'p-fake': buildPFakeProvider(), ...PROVIDER_DEFS }
  : PROVIDER_DEFS;

function mimoUltraspeedRouteEnabled(): boolean {
  return process.env.BRAIN_V2_ENABLE_MIMO_ULTRASPEED_ROUTE === '1'
    || process.env.BRAIN_V2_TEST_MIMO_ULTRASPEED === '1';
}

const productionTextOrder = [
  providerId('step-3.7-flash'),        // 生产文本/工具主链路: StepFun 3.7 Flash
  providerId('glm-coding'),            // GLM Coding Plan 5.3 Flash:多模态接班/主复核
  providerId('deepseek-chat'),         // DS V4 Flash:GLM 后的文本兜底备胎
  providerId('mimo-token-plan-pro'),   // 生产 MiMo 只用 Token Plan Pro,不用 UltraSpeed 测试线
  providerId('apex-spark-i-balanced'), // 本地 A3B 单槽 manager/fallback;忙时 router 跳过,保护 GUI 交互
  providerId('deepseek-pro'),          // 云兜底 V4-pro
  providerId('glm-5-turbo'),           // 末位
] as const satisfies readonly ProviderId[];

// universalOrder — 文本/工具编排链路。
// UltraSpeed 只在显式评测/实验开关下进入 route,避免普通 Brain 请求误走测试 key/model。
export const universalOrder: readonly ProviderId[] = mimoUltraspeedRouteEnabled()
  ? [providerId('mimo-ultraspeed'), ...productionTextOrder]
  : productionTextOrder;

const glmReviewOrder = [
  providerId('glm-coding'),
  providerId('deepseek-chat'),
  providerId('mimo-token-plan-pro'),
] as const satisfies readonly ProviderId[];

/**
 * Review headers select a bounded lane rather than the ordinary StepFun-first route.
 * GLM review may recover through DS and MiMo; a MiMo second opinion stays MiMo-only
 * so the caller can distinguish arbitration from generic failover.
 */
export function providerOrderForReviewArbitration(requested: string): {
  providerOrder: readonly ProviderId[];
  strictProviderOrder: boolean;
} | null {
  if (requested === 'glm-coding') {
    return { providerOrder: glmReviewOrder, strictProviderOrder: false };
  }
  if (requested === 'mimo-token-plan-pro') {
    return { providerOrder: [providerId('mimo-token-plan-pro')], strictProviderOrder: true };
  }
  return null;
}

const multimodalOrder = [
  providerId('step-3.7-flash'),        // 多模态仍由 StepFun/vision_model 承接
  providerId('glm-coding'),            // GLM-5.3-Flash 图片理解/主复核
  providerId('deepseek-chat'),         // DS V4 Flash Vision Exp 多模态兜底备胎
  providerId('mimo-multimodal'),       // MiMo 原生图片/音频/视频兜底及异构仲裁;audio 首个可用 provider
  providerId('apex-spark-i-balanced'),
  providerId('deepseek-pro'),
  providerId('glm-5-turbo'),
] as const satisfies readonly ProviderId[];

export function providerOrderForCapability(capabilityRequired?: { vision?: boolean; audio?: boolean; video?: boolean }): readonly ProviderId[] {
  if (capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video) {
    // 多模态首位 = StepFun(step-3.7-flash,vision_model=step-1o-turbo-vision,capability.vision/video=true)。
    // MiMo follows as native image/audio/video fallback; audio requests land there when configured.
    return multimodalOrder;
  }
  if (P_FAKE_ENABLED) {
    return [providerId('p-fake'), ...universalOrder];
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
export function isRecoveryProbeAllowed(providerId: ProviderId): boolean {
  const state = cooldownState.get(providerId);
  return !state || Date.now() >= state.unhealthyUntil || !/^(?:error-auth|error-billing):/.test(state.reason);
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
export function resetCooldownStateForTests(): void {
  cooldownState.clear();
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
  routeRole?: 'head' | 'local_single_slot_manager' | 'escape' | 'tail';
  localConcurrencyLimit?: number;
  busyFallbackProvider?: string;
  timeoutPolicy: ReturnType<typeof providerTimeoutPolicy>;
  billingChannel?: 'step-plan' | 'pay-as-you-go' | 'custom';
  cooldown?: { remainingMs: number; reasonCode: string };
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
  const headProvider = route[0] || '';
  return {
    ok: true,
    route,
    providers: Object.values(PROVIDERS).map((provider) => {
      const credential = credentialStatus(provider);
      const state = cooldownState.get(provider.id);
      let billingChannel: ProviderStatusSnapshotEntry['billingChannel'];
      if (String(provider.id) === 'step-3.7-flash') {
        billingChannel = 'custom';
        try {
          const endpoint = new URL(provider.endpoint);
          if (endpoint.origin === 'https://api.stepfun.com') billingChannel = endpoint.pathname.replace(/\/$/, '') === '/step_plan/v1' ? 'step-plan' : 'pay-as-you-go';
        } catch {}
      }
      return {
        id: String(provider.id),
        model: String(provider.model),
        endpoint: provider.endpoint,
        wire: provider.wire,
        capability: provider.capability,
        credential,
        configured: credential !== 'missing',
        timeoutPolicy: providerTimeoutPolicy(provider, !!(capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video)),
        billingChannel,
        cooldown: state && state.unhealthyUntil > Date.now() ? { remainingMs: state.unhealthyUntil - Date.now(), reasonCode: state.reason.split(':')[0] } : undefined,
        local: provider.apiKey === 'none' || Boolean(provider.health_path),
        inRoute: routeSet.has(String(provider.id)),
        routeRole: String(provider.id) === headProvider
          ? 'head'
          : String(provider.id) === 'apex-spark-i-balanced'
            ? 'local_single_slot_manager'
            : String(provider.id) === 'step-3.7-flash' || String(provider.id) === 'deepseek-chat'
              ? 'escape'
              : 'tail',
        localConcurrencyLimit: String(provider.id) === 'apex-spark-i-balanced'
          ? DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY
          : undefined,
        busyFallbackProvider: String(provider.id) === 'apex-spark-i-balanced'
          ? 'deepseek-pro or glm-5-turbo'
          : undefined,
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
