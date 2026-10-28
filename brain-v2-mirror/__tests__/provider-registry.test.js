import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => {
  process.env.STEP37_MODEL = 'step-5-preview';
});
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, providerOrderForReviewArbitration, universalOrder, markUnhealthy, clearUnhealthy, isRecoveryProbeAllowed } from '../provider-registry.js';

function withSavedEnv(keys, fn) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

describe('provider registry', () => {
  it('reports effective Step billing channel and stream deadlines without credentials', () => {
    const step = getProvider('step-3.7-flash');
    const previousEndpoint = step.endpoint;
    try {
      step.endpoint = 'https://api.stepfun.com/step_plan/v1';
      let status = getProviderStatusSnapshot().providers.find(entry => entry.id === step.id);
      expect(status.billingChannel).toBe('step-plan');
      expect(status.timeoutPolicy).toEqual({ firstChunkMs: 600_000, idleMs: 600_000, totalMs: 0 });
      expect(status).not.toHaveProperty('apiKey');
      step.endpoint = 'https://api.stepfun.com/v1';
      status = getProviderStatusSnapshot().providers.find(entry => entry.id === step.id);
      expect(status.billingChannel).toBe('pay-as-you-go');
    } finally { step.endpoint = previousEndpoint; }
  });

  it('does not allow recovery probes to bypass active billing or auth cooldowns', () => {
    const id = 'deepseek-chat';
    try {
      markUnhealthy(id, 'error-billing: insufficient balance', 1000);
      expect(isRecoveryProbeAllowed(id)).toBe(false);
      expect(getProviderStatusSnapshot().providers.find(entry => entry.id === id).cooldown).toMatchObject({ reasonCode: 'error-billing' });
      markUnhealthy(id, 'error-auth: unavailable', 1000);
      expect(isRecoveryProbeAllowed(id)).toBe(false);
      markUnhealthy(id, 'error-timeout: idle', 1000);
      expect(isRecoveryProbeAllowed(id)).toBe(true);
      clearUnhealthy(id);
      expect(isRecoveryProbeAllowed(id)).toBe(true);
    } finally { clearUnhealthy(id); }
  });
  it('keeps production text routing on StepFun, then GLM-5.3-Flash, then DS V4 Flash', () => {
    expect(universalOrder.map(String).slice(0, 7)).toEqual([
      'step-3.7-flash',
      'glm-coding',
      'deepseek-chat',
      'mimo-token-plan-pro',
      'apex-spark-i-balanced',
      'deepseek-pro',
      'glm-5-turbo',
    ]);
    expect(universalOrder.map(String)).not.toContain('mimo-ultraspeed');
  });

  it('uses a bounded GLM -> DS -> MiMo recovery chain for automatic review', () => {
    expect(providerOrderForReviewArbitration('glm-coding')).toEqual({
      providerOrder: ['glm-coding', 'deepseek-chat', 'mimo-token-plan-pro'],
      strictProviderOrder: false,
    });
    expect(providerOrderForReviewArbitration('mimo-token-plan-pro')).toEqual({
      providerOrder: ['mimo-token-plan-pro'],
      strictProviderOrder: true,
    });
    expect(providerOrderForReviewArbitration('unknown')).toBeNull();
  });

  it('registers GLM-5.3-Flash on Coding Plan as the multimodal takeover and review lane', () => {
    const glm = getProvider('glm-coding');
    expect(glm).toBeTruthy();
    expect(glm.endpoint).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(String(glm.model)).toBe(process.env.ZHIPU_CODING_FLASH_MODEL || 'GLM-5.3-Flash');
    expect(glm.timeout_ms).toBe(35_000);
    expect(glm.default_reasoning_effort).toBe('low');
    expect(glm.capability).toMatchObject({ vision: true, audio: false, video: false, tools: true, thinking: true });
  });

  it('registers MiMo ordinary API UltraSpeed separately from Token Plan', () => {
    const fast = getProvider('mimo-ultraspeed');
    expect(fast).toBeTruthy();
    expect(String(fast.id)).toBe('mimo-ultraspeed');
    expect(fast.endpoint).toBe('https://api.xiaomimimo.com/v1');
    expect(String(fast.model)).toBe('mimo-v2.5-pro-ultraspeed');
    expect(fast.apiKey).toBe(process.env.MIMO_ULTRASPEED_KEY || '');
    expect(fast.wire).toBe('openai');
    expect(fast.default_reasoning_effort).toBe('low');
    expect(fast.max_tokens).toBe(16_384);
    expect(fast.timeout_ms).toBe(30_000);
    expect(fast.capability).toMatchObject({
      vision: false,
      audio: false,
      video: false,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('registers MiMo Token Plan Pro as the production MiMo route lane', () => {
    const tokenPlan = getProvider('mimo-token-plan-pro');
    expect(tokenPlan).toBeTruthy();
    expect(String(tokenPlan.id)).toBe('mimo-token-plan-pro');
    expect(tokenPlan.endpoint).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(String(tokenPlan.model)).toBe('mimo-v2.5-pro');
    expect(tokenPlan.apiKey).toBe(process.env.MIMO_TOKEN_PLAN_KEY || '');
    expect(tokenPlan.timeout_ms).toBe(15_000);
    expect(tokenPlan.capability.tools).toBe(true);
  });

  it('falls back to bounded MiMo timeouts when timeout env values are invalid', async () => {
    const savedUltraspeed = process.env.MIMO_ULTRASPEED_TIMEOUT_MS;
    const savedTokenPlan = process.env.MIMO_TOKEN_PLAN_TIMEOUT_MS;
    process.env.MIMO_ULTRASPEED_TIMEOUT_MS = '30s';
    process.env.MIMO_TOKEN_PLAN_TIMEOUT_MS = '0';

    try {
      const isolated = await import('../provider-registry.js?invalid-mimo-timeouts');
      expect(isolated.getProvider('mimo-ultraspeed').timeout_ms).toBe(30_000);
      expect(isolated.getProvider('mimo-token-plan-pro').timeout_ms).toBe(15_000);
    } finally {
      if (savedUltraspeed === undefined) delete process.env.MIMO_ULTRASPEED_TIMEOUT_MS;
      else process.env.MIMO_ULTRASPEED_TIMEOUT_MS = savedUltraspeed;
      if (savedTokenPlan === undefined) delete process.env.MIMO_TOKEN_PLAN_TIMEOUT_MS;
      else process.env.MIMO_TOKEN_PLAN_TIMEOUT_MS = savedTokenPlan;
    }
  });

  it('registers StepFun as a cloud text/tools fallback without native search', () => {
    const step = getProvider('step-3.7-flash');
    expect(step).toBeTruthy();
    expect(String(step.id)).toBe('step-3.7-flash');
    expect(step.endpoint).toBe('https://api.stepfun.com/step_plan/v1');
    expect(String(step.model)).toBe('step-5-preview');
    expect(step.wire).toBe('openai');
    expect(step.cooldown_ms).toBe(60_000);
    expect(step.default_thinking).toBe(false);
    expect(step.default_reasoning_effort).toBe('low');
    expect(step.max_tokens).toBe(49_152);
    expect(step.timeout_ms).toBe(35_000);
    expect(step.thinking_control).toBeUndefined();
    expect(step.capability).toMatchObject({
      vision: true,
      audio: false,
      video: true,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('bounds the production text fallback chain while giving DS V4 Vision Exp enough time to finish long-form answers', () => {
    expect(String(getProvider('deepseek-chat').model)).toBe(process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-vision-exp');
    expect(getProvider('deepseek-chat').capability.vision).toBe(true);
    expect(getProvider('deepseek-chat').timeout_ms).toBe(45_000);
    expect(getProvider('mimo-token-plan-pro').timeout_ms).toBe(15_000);
    expect(getProvider('apex-spark-i-balanced').timeout_ms).toBe(8_000);
    expect(getProvider('deepseek-pro').timeout_ms).toBe(10_000);
    expect(getProvider('glm-5-turbo').timeout_ms).toBe(12_000);
  });

  it('keeps Qwen chat-template thinking control scoped to Spark only', () => {
    expect(getProvider('apex-spark-i-balanced').thinking_control).toBe('qwen_chat_template');
    expect(getProvider('step-3.7-flash').thinking_control).toBeUndefined();
    expect(getProvider('deepseek-chat').thinking_control).toBeUndefined();
  });

  it('routes vision through StepFun, GLM-5.3-Flash, DS Vision Exp, then MiMo', () => {
    const visionOrder = providerOrderForCapability({ vision: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    expect(visionOrder[0]).toBe('step-3.7-flash');
    expect(visionOrder[1]).toBe('glm-coding');
    expect(visionOrder[2]).toBe('deepseek-chat');
    expect(visionOrder[3]).toBe('mimo-multimodal');
    expect(visionOrder).toContain('step-3.7-flash');
    expect(visionOrder).toContain('glm-coding');
    expect(visionOrder).toContain('mimo-multimodal');
    expect(universalOrder.map(String)[0]).toBe('step-3.7-flash');
    expect(universalOrder.map(String)[1]).toBe('glm-coding');
    expect(universalOrder.map(String)[2]).toBe('deepseek-chat');
    expect(universalOrder.map(String)[3]).toBe('mimo-token-plan-pro');
    expect(visionOrder).not.toContain('apex-spark-i-balanced');
    expect(visionOrder).toContain('deepseek-chat');
  });

  it('routes native audio to MiMo multimodal after filtering non-audio providers', () => {
    const audioCapableOrder = providerOrderForCapability({ audio: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.audio)
      .map((provider) => String(provider.id));

    expect(audioCapableOrder[0]).toBe('mimo-multimodal');
    expect(audioCapableOrder).toEqual(['mimo-multimodal']);
  });

  it('registers MiMo as native image/audio/video fallback without taking over text route', () => {
    const mimo = getProvider('mimo-multimodal');
    expect(mimo).toBeTruthy();
    expect(String(mimo.id)).toBe('mimo-multimodal');
    expect(mimo.endpoint).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(mimo.apiKey).toBe(process.env.MIMO_MULTIMODAL_KEY || '');
    expect(String(mimo.model)).toBe('mimo-v2.5');
    expect(mimo.wire).toBe('openai');
    expect(mimo.capability).toMatchObject({
      vision: true,
      audio: true,
      video: true,
      tools: false,
      thinking: true,
      native_search: false,
    });
    expect(universalOrder.map(String)).not.toContain('mimo-multimodal');
    expect(providerOrderForCapability({ audio: true }).map(String)).toContain('mimo-multimodal');
    expect(providerOrderForCapability({ video: true }).map(String)).toContain('mimo-multimodal');
  });

  it('exposes a sanitized provider status snapshot without leaking keys', () => {
    const snapshot = getProviderStatusSnapshot();
    const fast = snapshot.providers.find((provider) => provider.id === 'mimo-ultraspeed');
    const tokenPlan = snapshot.providers.find((provider) => provider.id === 'mimo-token-plan-pro');
    const ds = snapshot.providers.find((provider) => provider.id === 'deepseek-chat');
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 4)).toEqual(['step-3.7-flash', 'glm-coding', 'deepseek-chat', 'mimo-token-plan-pro']);
    expect(tokenPlan).toMatchObject({ id: 'mimo-token-plan-pro', routeRole: 'tail', inRoute: true });
    expect(fast).toMatchObject({ id: 'mimo-ultraspeed', inRoute: false });
    expect(ds).toMatchObject({ id: 'deepseek-chat', routeRole: 'escape', inRoute: true });
    expect(step).toMatchObject({ id: 'step-3.7-flash', routeRole: 'head', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({
      credential: 'not_required',
      configured: true,
      local: true,
      routeRole: 'local_single_slot_manager',
      localConcurrencyLimit: 1,
      busyFallbackProvider: 'deepseek-pro or glm-5-turbo',
    });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });

  it('only adds MiMo UltraSpeed to the text route behind an explicit eval switch', async () => {
    await withSavedEnv(['BRAIN_V2_ENABLE_MIMO_ULTRASPEED_ROUTE'], async () => {
      process.env.BRAIN_V2_ENABLE_MIMO_ULTRASPEED_ROUTE = '1';
      const isolated = await import('../provider-registry.js?mimo-ultraspeed-route-enabled');
      expect(isolated.providerOrderForCapability().map(String).slice(0, 4)).toEqual([
        'mimo-ultraspeed',
        'step-3.7-flash',
        'glm-coding',
        'deepseek-chat',
      ]);
    });
  });

  it('keeps p-fake absent from the default production registry and route', () => {
    expect(getProvider('p-fake')).toBeNull();
    expect(PROVIDERS['p-fake']).toBeUndefined();
    expect(providerOrderForCapability().map(String)).not.toContain('p-fake');
    expect(getProviderStatusSnapshot().route).not.toContain('p-fake');
  });

  it('adds p-fake as an env-gated text-route head without taking over multimodal routing', async () => {
    await withSavedEnv([
      'BRAIN_V2_ENABLE_P_FAKE',
      'BRAIN_V2_P_FAKE_BASE',
      'BRAIN_V2_P_FAKE_KEY',
      'BRAIN_V2_P_FAKE_MODEL',
    ], async () => {
      process.env.BRAIN_V2_ENABLE_P_FAKE = '1';
      process.env.BRAIN_V2_P_FAKE_BASE = 'http://127.0.0.1:4567/v1';
      process.env.BRAIN_V2_P_FAKE_KEY = 'none';
      process.env.BRAIN_V2_P_FAKE_MODEL = 'p-fake';

      const isolated = await import('../provider-registry.js?p-fake-enabled');
      const fake = isolated.getProvider('p-fake');
      const textRoute = isolated.providerOrderForCapability().map(String);
      const visionRoute = isolated.providerOrderForCapability({ vision: true }).map(String);
      const snapshot = isolated.getProviderStatusSnapshot();

      expect(fake).toBeTruthy();
      expect(fake.endpoint).toBe('http://127.0.0.1:4567/v1');
      expect(fake.apiKey).toBe('none');
      expect(String(fake.model)).toBe('p-fake');
      expect(fake.authType).toBe('none');
      expect(fake.health_path).toBe('/models');
      expect(textRoute.slice(0, 4)).toEqual([
        'p-fake',
        'step-3.7-flash',
        'glm-coding',
        'deepseek-chat',
      ]);
      expect(visionRoute[0]).toBe('step-3.7-flash');
      expect(visionRoute).not.toContain('p-fake');
      expect(snapshot.route[0]).toBe('p-fake');
      expect(snapshot.providers.find((provider) => provider.id === 'p-fake')).toMatchObject({
        credential: 'not_required',
        configured: true,
        local: true,
        inRoute: true,
        routeRole: 'head',
      });
    });
  });

  it('can reset cooldown state between route-level regression cases', async () => {
    await withSavedEnv(['BRAIN_V2_ENABLE_P_FAKE'], async () => {
      process.env.BRAIN_V2_ENABLE_P_FAKE = '1';
      const isolated = await import('../provider-registry.js?p-fake-cooldown');
      isolated.markUnhealthy('p-fake', 'test', 60_000);
      expect(isolated.getCooldownState()['p-fake']?.reason).toBe('test');
      isolated.resetCooldownStateForTests();
      expect(isolated.getCooldownState()).toEqual({});
    });
  });
});
