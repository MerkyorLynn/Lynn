/**
 * onboarding-actions.ts — API call logic for the onboarding wizard
 */

import { AGENT_ID } from './constants';

export type OnboardingFetch = (path: string, opts?: RequestInit) => Promise<Response>;

// ── Test connection ──

interface TestConnectionParams {
  onboardingFetch: OnboardingFetch;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

export async function testConnection({ onboardingFetch, providerUrl, providerApi, apiKey }: TestConnectionParams): Promise<TestResult> {
  const res = await onboardingFetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    return { ok: true, text: t('onboarding.provider.testSuccess') };
  }
  const detail = data.error || data.message || '';
  const failText = t('onboarding.provider.testFailed');
  return { ok: false, text: detail ? `${failText}: ${detail}` : failText };
}

// ── Save provider ──

interface SaveProviderParams {
  onboardingFetch: OnboardingFetch;
  providerName: string;
  providerUrl: string;
  apiKey: string;
  providerApi: string;
}

export async function saveProvider({ onboardingFetch, providerName, providerUrl, apiKey, providerApi }: SaveProviderParams): Promise<void> {
  await onboardingFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api: { provider: providerName },
      providers: {
        [providerName]: {
          base_url: providerUrl,
          api_key: apiKey,
          api: providerApi,
        },
      },
    }),
  });
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
  const models: Record<string, string> = {
    chat: selectedModel,
    summarizer: selectedModel,
    compiler: selectedModel,
    utility: selectedModel,
    utility_large: selectedModel,
  };

  await onboardingFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  });

  const modelIds = fetchedModels.map(m => m.id);
  await onboardingFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providers: { [providerName]: { models: modelIds } },
    }),
  });
}

// ── Save locale ──

export async function saveLocale(onboardingFetch: OnboardingFetch, locale: string): Promise<void> {
  await onboardingFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
}

// ── Save user name ──

export async function saveUserName(onboardingFetch: OnboardingFetch, name: string): Promise<void> {
  await onboardingFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { name } }),
  });
}

// ── Save workspace ──

export async function saveHomeFolder(onboardingFetch: OnboardingFetch, folder: string): Promise<void> {
  await onboardingFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desk: { home_folder: folder } }),
  });
}
