import { describe, it, expect } from 'vitest';
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps StepFun high+32K in the intended universal fallback head position', () => {
    expect(universalOrder.map(String).slice(0, 4)).toEqual([
      'step-3.7-flash',
      'apex-spark-i-balanced',
      'deepseek-chat',
      'deepseek-pro',
    ]);
  });

  it('no longer registers the removed MiMo provider', () => {
    expect(getProvider('mimo')).toBeNull();
    expect(universalOrder.map(String)).not.toContain('mimo');
    expect(Object.keys(PROVIDERS)).not.toContain('mimo');
  });

  it('registers StepFun as a cloud text/tools fallback without native search', () => {
    const step = getProvider('step-3.7-flash');
    expect(step).toBeTruthy();
    expect(String(step.id)).toBe('step-3.7-flash');
    expect(step.endpoint).toBe('https://api.stepfun.com/step_plan/v1');
    expect(String(step.model)).toBe('step-3.7-flash');
    expect(step.wire).toBe('openai');
    expect(step.cooldown_ms).toBe(60_000);
    expect(step.default_thinking).toBe(false);
    expect(step.default_reasoning_effort).toBe('high');
    expect(step.max_tokens).toBe(32_768);
    expect(step.thinking_control).toBeUndefined();
    expect(step.capability).toMatchObject({
      vision: false,
      audio: false,
      video: false,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('keeps Qwen chat-template thinking control scoped to Spark only', () => {
    expect(getProvider('apex-spark-i-balanced').thinking_control).toBe('qwen_chat_template');
    expect(getProvider('step-3.7-flash').thinking_control).toBeUndefined();
    expect(getProvider('deepseek-chat').thinking_control).toBeUndefined();
  });

  it('keeps StepFun as the text head and exposes no multimodal-capable provider after MiMo removal', () => {
    // No provider declares vision/audio/video anymore. The capability path still
    // returns universalOrder (router.run pre-flight raises CAPABILITY_NOT_SUPPORTED),
    // but the capable-after-gate set is empty.
    const visionOrder = providerOrderForCapability({ vision: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    expect(visionOrder).toEqual([]);
    expect(universalOrder.map(String).slice(0, 3)).toEqual(['step-3.7-flash', 'apex-spark-i-balanced', 'deepseek-chat']);
    // capability path does not crash and returns the universal cascade unchanged
    expect(providerOrderForCapability({ vision: true }).map(String)).toEqual(universalOrder.map(String));
    expect(Object.values(PROVIDERS).every((p) => !p.capability.vision && !p.capability.audio && !p.capability.video)).toBe(true);
  });

  it('exposes a sanitized provider status snapshot without leaking keys', () => {
    const snapshot = getProviderStatusSnapshot();
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 3)).toEqual(['step-3.7-flash', 'apex-spark-i-balanced', 'deepseek-chat']);
    expect(step).toMatchObject({ id: 'step-3.7-flash', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({ credential: 'not_required', configured: true, local: true });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
