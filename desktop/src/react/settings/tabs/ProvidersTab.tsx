import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSettingsStore, type ProviderSummary, type SettingsConfig } from '../store';
import { hanaFetch } from '../api';
import { t, PROVIDER_PRESETS } from '../helpers';
import { loadSettingsConfig } from '../actions';
import { ProviderDetail } from './providers/ProviderDetail';
import { AddCustomButton } from './providers/ProviderList';
import { BRAIN_PROVIDER_ID, BRAIN_PROVIDER_LABEL, buildBrainProviderConfig } from '../../../../../shared/brain-provider.js';
import styles from '../Settings.module.css';

const OAUTH_PROVIDER_ORDER = [
  'openai-codex-oauth',
  'minimax-oauth',
];

const CODING_PROVIDER_ORDER = [
  'minimax-coding',
  'zhipu-coding',
  'stepfun-coding',
  'tencent-coding',
  'dashscope-coding',
  'kimi-coding',
  'volcengine-coding',
];

const API_PROVIDER_ORDER = [
  BRAIN_PROVIDER_ID,
  'minimax',
  'zhipu',
  'stepfun',
  'hunyuan',
  'siliconflow',
  'dashscope',
  'openai',
  'deepseek',
  'volcengine',
  'moonshot',
  'groq',
  'mistral',
  'openrouter',
  'mimo',
  'ollama',
];

function sortByPriority(ids: string[], order: string[]) {
  return [...ids].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right, 'zh-Hans-CN');
  });
}

function resolvePreferredProviderId(settingsConfig: SettingsConfig | null): string | null {
  if (!settingsConfig) return null;

  const chatRaw = settingsConfig.models?.chat;
  if (chatRaw && typeof chatRaw === 'object' && typeof chatRaw.provider === 'string' && chatRaw.provider.trim()) {
    return chatRaw.provider.trim();
  }

  const apiProvider = typeof settingsConfig.api?.provider === 'string'
    ? settingsConfig.api.provider.trim()
    : '';
  if (apiProvider) return apiProvider;

  const chatModelId = typeof chatRaw === 'string'
    ? chatRaw.trim()
    : (chatRaw && typeof chatRaw === 'object' && typeof chatRaw.id === 'string' ? chatRaw.id.trim() : '');
  if (!chatModelId) return null;

  const providers = settingsConfig.providers || {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if ((providerConfig?.models || []).includes(chatModelId)) return providerId;
  }

  return null;
}

function buildPresetSummary(id: string): ProviderSummary | null {
  if (id === BRAIN_PROVIDER_ID) {
    const cfg = buildBrainProviderConfig();
    return {
      type: 'none',
      display_name: cfg.display_name,
      base_url: cfg.base_url,
      api: cfg.api,
      api_key: '',
      models: cfg.models || [],
      custom_models: [],
      has_credentials: true,
      supports_oauth: false,
      can_delete: false,
    };
  }

  const preset = PROVIDER_PRESETS.find(p => p.value === id);
  if (!preset) return null;
  return {
    type: (preset.noKey || preset.local) ? 'none' as const : 'api-key' as const,
    display_name: preset.label,
    base_url: preset.url || '',
    api: preset.api || '',
    api_key: '',
    models: preset.defaultModelId ? [preset.defaultModelId] : [],
    custom_models: [],
    has_credentials: !!preset.noKey || !!preset.local,
    supports_oauth: false,
    can_delete: false,
  };
}

export function ProvidersTab() {
  const { providersSummary, selectedProviderId, preferredProviderId, settingsConfig } = useSettingsStore();
  const providers = settingsConfig?.providers || {};
  const [addingProvider, setAddingProvider] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/providers/summary');
      const data = await res.json();
      useSettingsStore.setState({ providersSummary: data.providers || {} });
    } catch { /* swallow */ }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  useEffect(() => {
    if (!selectedProviderId) {
      useSettingsStore.setState({ selectedProviderId: BRAIN_PROVIDER_ID });
    }
  }, [selectedProviderId]);

  const providerIds = useMemo(() => Object.keys(providersSummary), [providersSummary]);
  const summaryLoaded = providerIds.length > 0;
  const visibleOauthProviderIds = useMemo(() => sortByPriority(
    providerIds.filter((id) => providersSummary[id].supports_oauth && OAUTH_PROVIDER_ORDER.includes(id)),
    OAUTH_PROVIDER_ORDER,
  ), [providerIds, providersSummary]);
  const visibleCodingProviderIds = useMemo(() => sortByPriority(
    providerIds.filter((id) => !providersSummary[id].supports_oauth && providersSummary[id].is_coding_plan),
    CODING_PROVIDER_ORDER,
  ), [providerIds, providersSummary]);
  const visibleRegisteredApiIds = useMemo(
    () => providerIds.filter((id) => !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan),
    [providerIds, providersSummary],
  );
  const visibleProviderIds = useMemo(() => [
    ...visibleOauthProviderIds,
    ...visibleCodingProviderIds,
    ...visibleRegisteredApiIds,
  ], [visibleCodingProviderIds, visibleOauthProviderIds, visibleRegisteredApiIds]);
  const resolvedPreferredProviderId = resolvePreferredProviderId(settingsConfig) || preferredProviderId;

  useEffect(() => {
    if (!summaryLoaded) return;
    const hasSelected = !!selectedProviderId && visibleProviderIds.includes(selectedProviderId);
    if (hasSelected) return;

    const preferred = resolvedPreferredProviderId && (
      visibleProviderIds.includes(resolvedPreferredProviderId) ||
      PROVIDER_PRESETS.some((preset) => preset.value === resolvedPreferredProviderId)
    )
      ? resolvedPreferredProviderId
      : null;
    const fallback = preferred || visibleProviderIds[0] || PROVIDER_PRESETS[0]?.value || null;
    if (fallback && fallback !== selectedProviderId) {
      useSettingsStore.setState({ selectedProviderId: fallback });
    }
  }, [resolvedPreferredProviderId, selectedProviderId, summaryLoaded, visibleProviderIds]);
  const selected = selectedProviderId || BRAIN_PROVIDER_ID;

  // 分组：OAuth / Coding Plan / API Key
  const oauthProviders = visibleOauthProviderIds;
  const codingPlanProviders = visibleCodingProviderIds;
  const registeredApiKey = visibleRegisteredApiIds;
  const registeredSet = new Set(providerIds);

  const unregisteredPresets = PROVIDER_PRESETS.filter(p =>
    !registeredSet.has(p.value) && !oauthProviders.includes(p.value)
  );
  const presetValues = new Set(PROVIDER_PRESETS.map(p => p.value));
  const customProviders = sortByPriority(
    registeredApiKey.filter(id => !presetValues.has(id)),
    API_PROVIDER_ORDER,
  );
  const presetProviders = sortByPriority(
    registeredApiKey.filter(id => presetValues.has(id)),
    API_PROVIDER_ORDER,
  );
  const selectProvider = (id: string) => {
    useSettingsStore.setState({ selectedProviderId: id });
  };

  const getProviderLabel = (id: string, p?: ProviderSummary) => {
    if (id === BRAIN_PROVIDER_ID) return BRAIN_PROVIDER_LABEL;
    const preset = PROVIDER_PRESETS.find(pr => pr.value === id);
    return preset?.label || p?.display_name || id;
  };

  const renderRegistered = (id: string) => {
    const p = providersSummary[id];
    const modelCount = (p.models || []).length;
    return (
      <button
        key={id}
        className={`${styles['pv-list-item']}${selected === id  ? ' ' + styles['selected'] : ''}`}
        onClick={() => selectProvider(id)}
      >
        <span className={`${styles['pv-status-dot']}${p.has_credentials  ? ' ' + styles['on'] : ''}`} />
        <span className={styles['pv-list-item-name']}>{getProviderLabel(id, p)}</span>
        <span className={styles['pv-list-item-count']}>{modelCount}</span>
      </button>
    );
  };

  const renderUnregistered = (preset: typeof PROVIDER_PRESETS[0]) => (
    <button
      key={preset.value}
      className={`${styles['pv-list-item']} ${styles['dim']}${selected === preset.value ? ' ' + styles['selected'] : ''}`}
      onClick={() => selectProvider(preset.value)}
    >
      <span className={styles['pv-status-dot']} />
      <span className={styles['pv-list-item-name']}>{preset.label}</span>
    </button>
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="providers">
      <div className={styles['pv-layout']}>
        {/* ── 左栏 ── */}
        <div className={styles['pv-list']}>
          {oauthProviders.length > 0 && (
            <>
              <div className={styles['pv-list-section-title']}>OAuth</div>
              {oauthProviders.map(renderRegistered)}
            </>
          )}

          {codingPlanProviders.length > 0 && (
            <>
              <div className={styles['pv-list-section-title']}>Coding Plan</div>
              {codingPlanProviders.map(renderRegistered)}
            </>
          )}

          <div className={styles['pv-list-section-title']}>API</div>
          {presetProviders.map(renderRegistered)}
          {unregisteredPresets.map(renderUnregistered)}
          {customProviders.map(renderRegistered)}

          <AddCustomButton
            adding={addingProvider}
            onToggle={() => setAddingProvider(!addingProvider)}
            onDone={() => { setAddingProvider(false); loadSummary(); }}
            onCancel={() => setAddingProvider(false)}
          />
        </div>

        {/* ── 右栏：Provider 详情 ── */}
        <div className={styles['pv-detail']}>
          {selected ? (() => {
            const existing = providersSummary[selected];
            const preset = PROVIDER_PRESETS.find(p => p.value === selected);
            const summary = existing || buildPresetSummary(selected);
            if (!summary) {
              return (
                <div className={styles['pv-empty']}>
                  {summaryLoaded ? t('settings.providers.selectHint') : '正在读取供应商配置...'}
                </div>
              );
            }
            return (
              <ProviderDetail
                providerId={selected}
                summary={summary}
                providerConfig={providers[selected]}
                isPresetSetup={!existing && !!preset}
                presetInfo={preset}
                onRefresh={async () => { await loadSettingsConfig(); await loadSummary(); }}
              />
            );
          })() : (
            <div className={styles['pv-empty']}>
              {t('settings.providers.selectHint')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
