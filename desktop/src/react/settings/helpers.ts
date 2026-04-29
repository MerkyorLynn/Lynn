/**
 * Settings 共享工具函数
 */
import {
  BRAIN_PROVIDER_ID,
  BRAIN_PROVIDER_LABEL,
  BRAIN_PROVIDER_BASE_URL,
  BRAIN_PROVIDER_API,
  BRAIN_DEFAULT_MODEL_ID,
} from '../../../../shared/brain-provider.js';
import { useSettingsStore } from './store';
import type { ProviderConfig } from './store';
import { hanaFetch } from './api';
import knownModels from '../../../../lib/known-models.json';

const platform = window.platform;

type ModelMeta = Record<string, unknown> & {
  _source?: string | null;
  displayName?: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function t(key: string, params?: Record<string, string | number>): string {
  return window.t?.(key, params) ?? key;
}

export function escapeHtml(str: string): string {
  // eslint-disable-next-line no-restricted-syntax -- escapeHtml utility, not React rendering
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function formatContext(n: number): string {
  if (!n) return '';
  if (n >= 1000000) {
    const m = n / 1000000;
    return (Number.isInteger(m) ? m : +m.toFixed(1)) + 'M';
  }
  const k = n / 1024;
  if (Number.isInteger(k)) return k + 'K';
  return Math.round(n / 1000) + 'K';
}

export function resolveProviderForModel(modelId: string): string | null {
  const config = useSettingsStore.getState().settingsConfig;
  if (!modelId || !config) return null;
  const providers = config.providers || {};
  for (const [name, p] of Object.entries(providers) as [string, ProviderConfig][]) {
    if ((p.models || []).includes(modelId)) return name;
  }
  return null;
}

function lookupReferenceModelMeta(modelId: string): ModelMeta | null {
  if (!modelId) return null;
  const dict = knownModels as unknown as Record<string, ModelMeta>;

  if (dict[modelId]) {
    return { ...dict[modelId], _source: 'reference' };
  }

  const lowerId = modelId.toLowerCase();
  const candidates = Object.entries(dict)
    .filter(([key]) => key !== '_comment' && lowerId.startsWith(key.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length);

  if (candidates.length === 0) return null;
  return { ...candidates[0][1], _source: 'reference' };
}

export function lookupModelMeta(modelId: string): ModelMeta | null {
  const { settingsConfig } = useSettingsStore.getState();
  if (!modelId) return null;
  const reference = lookupReferenceModelMeta(modelId);
  const override = settingsConfig?.models?.overrides?.[modelId];
  const overrideRecord = isRecord(override) ? override : null;
  if (!reference && !override) return null;
  return {
    ...(reference || {}),
    ...(overrideRecord || {}),
    _source: overrideRecord ? 'override' : reference?._source || null,
  };
}

function resolveSettingsTargetAgentId(store: ReturnType<typeof useSettingsStore.getState>): string | null {
  const requestedAgentId = store.getSettingsAgentId();
  if (requestedAgentId) return requestedAgentId;
  if (store.currentAgentId) return store.currentAgentId;
  return store.agents[0]?.id || null;
}

/** 通用 per-agent 自动保存 */
export async function autoSaveConfig(
  partial: Record<string, unknown>,
  opts: { silent?: boolean; refreshModels?: boolean } = {},
) {
  const store = useSettingsStore.getState();
  try {
    const agentId = resolveSettingsTargetAgentId(store);
    if (!agentId) throw new Error('no valid agent selected');
    const res = await hanaFetch(`/api/agents/${agentId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    // 刷新 config 快照，保留 _identity / _ishiki / _userProfile
    const cfgRes = await hanaFetch(`/api/agents/${agentId}/config`);
    const newConfig = await cfgRes.json();
    const prev = useSettingsStore.getState().settingsConfig || {};
    for (const k of ['_identity', '_ishiki', '_userProfile']) {
      if (k in prev && !(k in newConfig)) newConfig[k] = prev[k];
    }
    useSettingsStore.setState({ settingsConfig: newConfig, settingsConfigAgentId: agentId });
    const nextAgentId = agentId;
    if (partial.models || partial.api || partial.providers || opts.refreshModels) {
      platform?.settingsChanged?.('models-changed', { agentId: nextAgentId });
    }
    if (partial.desk) {
      platform?.settingsChanged?.('desk-config-changed', {
        homeFolder: newConfig?.desk?.home_folder || null,
        trustedRoots: Array.isArray(newConfig?.desk?.trusted_roots) ? newConfig.desk.trusted_roots : [],
      });
    }
  } catch (err: unknown) {
    store.showToast(t('settings.saveFailed') + ': ' + errorMessage(err), 'error');
  }
}

/** 全局模型自动保存 */
export async function autoSaveGlobalModels(
  partial: Record<string, unknown>,
  opts: { silent?: boolean } = {},
) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!opts.silent) store.showToast(t('settings.autoSaved'), 'success');
    const refreshRes = await hanaFetch('/api/preferences/models');
    const newGlobal = await refreshRes.json();
    useSettingsStore.setState({ globalModelsConfig: newGlobal });
    platform?.settingsChanged?.('models-changed', { scope: 'global-model-preferences' });
  } catch (err: unknown) {
    store.showToast(t('settings.saveFailed') + ': ' + errorMessage(err), 'error');
  }
}

let _savePinsTimer: ReturnType<typeof setTimeout> | null = null;
export function savePins() {
  if (_savePinsTimer) clearTimeout(_savePinsTimer);
  _savePinsTimer = setTimeout(async () => {
    const store = useSettingsStore.getState();
    try {
      const agentId = resolveSettingsTargetAgentId(store);
      if (!agentId) throw new Error('no valid agent selected');
      const res = await hanaFetch(`/api/agents/${agentId}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: store.currentPins }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      store.showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      store.showToast(t('settings.saveFailed') + ': ' + errorMessage(err), 'error');
    }
  }, 300);
}

export const PROVIDER_PRESETS = [
  { value: BRAIN_PROVIDER_ID, label: BRAIN_PROVIDER_LABEL, url: BRAIN_PROVIDER_BASE_URL, api: BRAIN_PROVIDER_API, noKey: true, defaultModelId: BRAIN_DEFAULT_MODEL_ID },
  { value: 'minimax', label: 'MiniMax', url: 'https://api.minimaxi.com/v1', api: 'openai-completions' },
  { value: 'zhipu', label: 'Zhipu (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  { value: 'stepfun', label: '阶跃星辰 (StepFun)', url: 'https://api.stepfun.com/v1', api: 'openai-completions' },
  { value: 'hunyuan', label: '腾讯混元', url: 'https://api.hunyuan.cloud.tencent.com/v1', api: 'openai-completions' },
  { value: 'ollama', label: 'Ollama (Local)', url: 'http://localhost:11434/v1', api: 'openai-completions', local: true },
  { value: 'dashscope', label: 'DashScope (Qwen)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  { value: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', api: 'openai-completions' },
  { value: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { value: 'volcengine', label: (window.i18n?.locale?.startsWith?.('zh') ? 'Volcengine (豆包)' : 'Volcengine (Doubao)'), url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', url: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  { value: 'minimax-coding', label: 'MiniMax Coding Plan', url: 'https://api.minimaxi.com/v1', api: 'openai-completions' },
  { value: 'kimi-coding', label: 'Kimi Coding Plan', url: 'https://api.kimi.com/coding/', api: 'anthropic-messages' },
  { value: 'zhipu-coding', label: '智谱 Coding Plan', url: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions' },
  { value: 'stepfun-coding', label: '阶跃星辰 Coding Plan', url: 'https://api.stepfun.com/step_plan/v1', api: 'openai-completions' },
  { value: 'tencent-coding', label: '腾讯云 Coding Plan', url: 'https://api.lkeap.cloud.tencent.com/coding/v3', api: 'openai-completions' },
  { value: 'siliconflow', label: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
  { value: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { value: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  { value: 'mimo', label: 'Xiaomi (MiMo)', url: 'https://api.xiaomimimo.com/v1', api: 'openai-completions' },
];

export const API_FORMAT_OPTIONS = [
  { value: 'openai-completions', label: t('onboarding.provider.apiOpenai') || 'OpenAI Compatible' },
  { value: 'anthropic-messages', label: t('onboarding.provider.apiAnthropic') || 'Anthropic Messages' },
  { value: 'openai-responses', label: t('settings.providers.apiResponses') || 'OpenAI Responses' },
  { value: 'openai-codex-responses', label: t('settings.providers.apiCodex') || 'ChatGPT Codex (Plus/Pro)' },
];

export const CONTEXT_PRESETS = [
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
  { label: '200K', value: 200000 },
  { label: '256K', value: 262144 },
  { label: '1M', value: 1048576 },
];

export const OUTPUT_PRESETS = [
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
];

export const VALID_THEMES = ['warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma', 'contemplation', 'absolutely', 'delve', 'deep-think'];
