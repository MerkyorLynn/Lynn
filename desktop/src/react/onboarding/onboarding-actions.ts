/**
 * onboarding-actions.ts — API call logic for the onboarding wizard
 */

import {
  BRAIN_PROVIDER_ID,
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_DEFAULT_MODEL_IDS,
  BRAIN_ROLE_MODEL_IDS,
} from '../../../../shared/brain-provider.js';

export type OnboardingFetch = (path: string, opts?: RequestInit) => Promise<Response>;

function notifyModelsChanged(): void {
  if (typeof window === 'undefined') return;
  window.platform?.settingsChanged?.('models-changed');
}

async function syncRuntimeModel(
  onboardingFetch: OnboardingFetch,
  modelId: string | null | undefined,
  provider: string,
): Promise<void> {
  if (!modelId) return;
  try {
    await onboardingFetch('/api/models/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, provider }),
    });
  } catch {
    // The persisted config is the source of truth; runtime sync is best-effort.
  }
}

// ── Test connection ──

interface TestConnectionParams {
  onboardingFetch: OnboardingFetch;
  providerName?: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

export interface RuntimeProviderInfo {
  providerName: string;
  providerUrl: string;
  providerApi: string;
}

function onboardingMessage(key: string, zh: string, en: string): string {
  try {
    if (typeof t === 'function') return t(key);
  } catch {
    // Fall through to locale-based fallback for tests and non-window contexts.
  }
  const locale = typeof window !== 'undefined'
    ? String(window.i18n?.locale || 'zh')
    : (typeof i18n !== 'undefined' ? String(i18n.locale || 'zh') : 'zh');
  return locale.startsWith('zh') ? zh : en;
}

export async function loadRuntimeProviderInfo(
  onboardingFetch: OnboardingFetch,
  providerName: string,
): Promise<RuntimeProviderInfo | null> {
  try {
    const res = await onboardingFetch('/api/providers/summary');
    const data = await res.json();
    const provider = data?.providers?.[providerName];
    const baseUrl = String(provider?.base_url || '').trim();
    const api = String(provider?.api || '').trim();
    if (!baseUrl || !api) return null;
    return {
      providerName,
      providerUrl: baseUrl,
      providerApi: api,
    };
  } catch {
    return null;
  }
}

export async function testConnection({ onboardingFetch, providerName, providerUrl, providerApi, apiKey }: TestConnectionParams): Promise<TestResult> {
  if (providerName === BRAIN_PROVIDER_ID) {
    return {
      ok: true,
      text: onboardingMessage('onboarding.provider.testSuccess', '连接成功', 'Connection successful'),
    };
  }
  const res = await onboardingFetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: providerName,
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    return {
      ok: true,
      text: onboardingMessage('onboarding.provider.testSuccess', '连接成功', 'Connection successful'),
    };
  }
  const detail = data.error || data.message || '';
  const failText = onboardingMessage('onboarding.provider.testFailed', '连接失败', 'Connection failed');
  return { ok: false, text: detail ? `${failText}: ${detail}` : failText };
}

// ── Save provider ──

interface SaveProviderParams {
  onboardingFetch: OnboardingFetch;
  providerName: string;
  providerUrl: string;
  apiKey: string;
  providerApi: string;
  defaultModelId?: string | null;
}

export async function saveProvider({
  onboardingFetch, providerName, providerUrl, apiKey, providerApi, defaultModelId = null,
}: SaveProviderParams): Promise<void> {
  const seededModelIds = providerName === BRAIN_PROVIDER_ID
    ? [...BRAIN_DEFAULT_MODEL_IDS]
    : (defaultModelId ? [defaultModelId] : []);
  const modelRef = defaultModelId
    ? { id: defaultModelId, provider: providerName }
    : null;
  const shouldActivateProvider = providerName === BRAIN_PROVIDER_ID || !!modelRef;
  const roleModels = providerName === BRAIN_PROVIDER_ID
    ? {
        chat: { id: BRAIN_ROLE_MODEL_IDS.chat, provider: BRAIN_PROVIDER_ID },
        summarizer: { id: BRAIN_ROLE_MODEL_IDS.summarizer, provider: BRAIN_PROVIDER_ID },
        compiler: { id: BRAIN_ROLE_MODEL_IDS.compiler, provider: BRAIN_PROVIDER_ID },
        utility: { id: BRAIN_ROLE_MODEL_IDS.utility, provider: BRAIN_PROVIDER_ID },
        utility_large: { id: BRAIN_ROLE_MODEL_IDS.utility_large, provider: BRAIN_PROVIDER_ID },
      }
    : (modelRef ? {
        chat: modelRef,
        summarizer: modelRef,
        compiler: modelRef,
        utility: modelRef,
        utility_large: modelRef,
      } : null);

  const configBody: Record<string, unknown> = {
    providers: {
      [providerName]: {
        base_url: providerUrl,
        api_key: apiKey,
        api: providerApi,
        ...(seededModelIds.length > 0 ? { models: seededModelIds } : {}),
      },
    },
  };

  if (shouldActivateProvider) {
    configBody.api = { provider: providerName };
  }
  if (roleModels) {
    configBody.models = roleModels;
  }

  await onboardingFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configBody),
  });

  if (shouldActivateProvider) {
    await syncRuntimeModel(onboardingFetch, providerName === BRAIN_PROVIDER_ID ? BRAIN_DEFAULT_MODEL_ID : defaultModelId, providerName);
  }
  notifyModelsChanged();
}

// ── Load models ──

interface LoadModelsParams {
  onboardingFetch: OnboardingFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface LoadModelsResult {
  models: { id: string }[];
  error?: string;
}

export async function loadModels({ onboardingFetch, providerName, providerUrl, providerApi, apiKey }: LoadModelsParams): Promise<LoadModelsResult> {
  const res = await onboardingFetch('/api/providers/fetch-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: providerName,
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.error) {
    return { models: [], error: data.error };
  }
  return { models: data.models || [] };
}

// ── Save model ──

interface SaveModelParams {
  onboardingFetch: OnboardingFetch;
  selectedModel: string;
  fetchedModels: { id: string }[];
  providerName: string;
}

export async function saveModel({ onboardingFetch, selectedModel, fetchedModels, providerName }: SaveModelParams): Promise<void> {
  const modelRef = {
    id: selectedModel,
    provider: providerName,
  };

  const modelIds = fetchedModels.map(m => m.id);
  await onboardingFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api: { provider: providerName },
      models: {
        chat: modelRef,
        summarizer: modelRef,
        compiler: modelRef,
        utility: modelRef,
        utility_large: modelRef,
      },
      providers: { [providerName]: { models: modelIds } },
    }),
  });

  await syncRuntimeModel(onboardingFetch, selectedModel, providerName);
  notifyModelsChanged();
}

async function resolveOnboardingAgentId(onboardingFetch: OnboardingFetch): Promise<string> {
  try {
    const res = await onboardingFetch('/api/agents');
    const data = await res.json();
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    const current = agents.find((agent: { isCurrent?: boolean }) => agent?.isCurrent);
    const primary = agents.find((agent: { isPrimary?: boolean }) => agent?.isPrimary);
    const fallback = agents[0];
    const resolved = current?.id || primary?.id || fallback?.id;
    if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
  } catch {
    // Fall through to legacy default below.
  }
  return 'lynn';
}

// ── Save locale ──

export async function saveLocale(onboardingFetch: OnboardingFetch, locale: string): Promise<void> {
  const agentId = await resolveOnboardingAgentId(onboardingFetch);
  await onboardingFetch(`/api/agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
}

// ── Save user name ──

export async function saveUserName(onboardingFetch: OnboardingFetch, name: string): Promise<void> {
  const agentId = await resolveOnboardingAgentId(onboardingFetch);
  await onboardingFetch(`/api/agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { name } }),
  });
}

// ── Save workspace ──

export async function saveHomeFolder(onboardingFetch: OnboardingFetch, folder: string, trustedRoots: string[] = []): Promise<void> {
  await onboardingFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      desk: {
        home_folder: folder,
        ...(trustedRoots.length > 0 ? { trusted_roots: trustedRoots } : {}),
      },
    }),
  });
}
