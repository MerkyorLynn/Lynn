import { describe, expect, it, vi } from 'vitest';
import { saveHomeFolder, saveLocale, saveModel, saveProvider, saveUserName } from '../../onboarding/onboarding-actions';
import { BRAIN_DEFAULT_MODEL_ID, BRAIN_DEFAULT_MODEL_IDS, BRAIN_ROLE_MODEL_IDS } from '../../../../../shared/brain-provider.js';

describe('onboarding-actions', () => {
  it('saves quick-start provider setup through /api/config with a default model', async () => {
    const onboardingFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await saveProvider({
      onboardingFetch,
      providerName: 'brain',
      providerUrl: 'http://82.156.182.240/api/v1',
      apiKey: '',
      providerApi: 'openai-completions',
      defaultModelId: BRAIN_DEFAULT_MODEL_ID,
    });

    expect(onboardingFetch).toHaveBeenNthCalledWith(1, '/api/config', expect.objectContaining({
      method: 'PUT',
    }));
    expect(onboardingFetch).toHaveBeenNthCalledWith(2, '/api/models/set', expect.objectContaining({
      method: 'POST',
    }));

    const firstCall = onboardingFetch.mock.calls[0] as unknown as [string, RequestInit];
    const request = firstCall[1];
    const body = JSON.parse(String(request?.body || '{}'));
    expect(body.api).toEqual({ provider: 'brain' });
    expect(body.providers.brain).toEqual(expect.objectContaining({
      base_url: 'http://82.156.182.240/api/v1',
      api_key: '',
      api: 'openai-completions',
      models: BRAIN_DEFAULT_MODEL_IDS,
    }));
    expect(body.models.chat).toEqual({
      id: BRAIN_ROLE_MODEL_IDS.chat,
      provider: 'brain',
    });
    expect(body.models.utility).toEqual({
      id: BRAIN_ROLE_MODEL_IDS.utility,
      provider: 'brain',
    });

    const secondCall = onboardingFetch.mock.calls[1] as unknown as [string, RequestInit];
    const secondBody = JSON.parse(String(secondCall[1]?.body || '{}'));
    expect(secondBody).toEqual({
      modelId: BRAIN_DEFAULT_MODEL_ID,
      provider: 'brain',
    });
  });

  it('saves selected models through /api/config with provider-qualified refs', async () => {
    const onboardingFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await saveModel({
      onboardingFetch,
      selectedModel: 'THUDM/GLM-Z1-9B-0414',
      fetchedModels: [
        { id: 'THUDM/GLM-Z1-9B-0414' },
        { id: 'Qwen/Qwen3-8B' },
      ],
      providerName: 'siliconflow',
    });

    expect(onboardingFetch).toHaveBeenNthCalledWith(1, '/api/config', expect.objectContaining({
      method: 'PUT',
    }));
    expect(onboardingFetch).toHaveBeenNthCalledWith(2, '/api/models/set', expect.objectContaining({
      method: 'POST',
    }));

    const firstCall = onboardingFetch.mock.calls[0] as unknown as [string, RequestInit];
    const request = firstCall[1];
    const body = JSON.parse(String(request?.body || '{}'));
    expect(body.models.utility_large).toEqual({
      id: 'THUDM/GLM-Z1-9B-0414',
      provider: 'siliconflow',
    });
    expect(body.providers.siliconflow.models).toEqual([
      'THUDM/GLM-Z1-9B-0414',
      'Qwen/Qwen3-8B',
    ]);

    const secondCall = onboardingFetch.mock.calls[1] as unknown as [string, RequestInit];
    const secondBody = JSON.parse(String(secondCall[1]?.body || '{}'));
    expect(secondBody).toEqual({
      modelId: 'THUDM/GLM-Z1-9B-0414',
      provider: 'siliconflow',
    });
  });

  it('notifies the app to refresh models after onboarding provider/model saves', async () => {
    const settingsChanged = vi.fn();
    vi.stubGlobal('window', { platform: { settingsChanged } });

    const onboardingFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await saveProvider({
      onboardingFetch,
      providerName: 'brain',
      providerUrl: 'http://82.156.182.240/api/v1',
      apiKey: '',
      providerApi: 'openai-completions',
      defaultModelId: BRAIN_DEFAULT_MODEL_ID,
    });

    await saveModel({
      onboardingFetch,
      selectedModel: 'THUDM/GLM-Z1-9B-0414',
      fetchedModels: [{ id: 'THUDM/GLM-Z1-9B-0414' }],
      providerName: 'siliconflow',
    });

    expect(settingsChanged).toHaveBeenCalledTimes(2);
    expect(settingsChanged).toHaveBeenNthCalledWith(1, 'models-changed');
    expect(settingsChanged).toHaveBeenNthCalledWith(2, 'models-changed');

    vi.unstubAllGlobals();
  });

  it('saves the onboarding workspace together with trusted roots', async () => {
    const onboardingFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await saveHomeFolder(onboardingFetch, '/Users/me/Desktop/Lynn', [
      '/Users/me/Desktop',
      '/Users/me/openhanako',
      '/Users/me/Desktop/Lynn',
    ]);

    expect(onboardingFetch).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      method: 'PUT',
    }));

    const firstCall = onboardingFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(firstCall[1]?.body || '{}'));
    expect(body.desk).toEqual({
      home_folder: '/Users/me/Desktop/Lynn',
      trusted_roots: [
        '/Users/me/Desktop',
        '/Users/me/openhanako',
        '/Users/me/Desktop/Lynn',
      ],
    });
  });

  it('saves locale and user name to the current onboarding agent instead of a hard-coded id', async () => {
    const onboardingFetch = vi.fn(async (path: string) => {
      if (path === '/api/agents') {
        return new Response(JSON.stringify({
          agents: [
            { id: 'hanako', isPrimary: true, isCurrent: true },
            { id: 'agent-reviewer', isPrimary: false, isCurrent: false },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await saveLocale(onboardingFetch, 'zh-CN');
    await saveUserName(onboardingFetch, 'Lynn');

    expect(onboardingFetch).toHaveBeenNthCalledWith(1, '/api/agents');
    expect(onboardingFetch).toHaveBeenNthCalledWith(2, '/api/agents/hanako/config', expect.objectContaining({
      method: 'PUT',
    }));
    expect(onboardingFetch).toHaveBeenNthCalledWith(3, '/api/agents');
    expect(onboardingFetch).toHaveBeenNthCalledWith(4, '/api/agents/hanako/config', expect.objectContaining({
      method: 'PUT',
    }));
  });
});
