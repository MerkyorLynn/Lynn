/**
 * ProviderStep.tsx — Step 2: Provider configuration + connection test
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { PROVIDER_PRESETS, QUICK_START_PROVIDER } from '../constants';
import type { ProviderPreset } from '../constants';
import {
  testConnection,
  saveProvider as saveProviderAction,
  loadRuntimeProviderInfo,
} from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';
import { getBrainComplianceNote, getBrainUserNotice } from '../../../../../shared/brain-provider.js';

// ── SVG Icons (local to this step) ──

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

interface ProviderStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onProviderReady: (providerName: string, providerUrl: string, providerApi: string, apiKey: string) => void;
  track: 'quick' | 'advanced';
}

export function ProviderStep({
  preview, onboardingFetch, goToStep, showError, onProviderReady,
  track,
}: ProviderStepProps) {
  // ── Provider state ──
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [isLocalProvider, setIsLocalProvider] = useState(false);
  const [connectionTested, setConnectionTested] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: '' | 'loading' | 'success' | 'error'; text: string }>({ type: '', text: '' });
  const [showKey, setShowKey] = useState(false);

  // ── Custom provider fields ──
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState('openai-completions');

  const isZh = i18n.locale?.startsWith('zh');
  const isQuickTrack = track === 'quick';
  const siliconflowPreset = useMemo(
    () => PROVIDER_PRESETS.find((preset) => preset.value === QUICK_START_PROVIDER.providerName) || null,
    [],
  );
  const activePreset = useMemo(
    () => PROVIDER_PRESETS.find((preset) => preset.value === selectedPreset) || null,
    [selectedPreset],
  );

  const copyText = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);

  // ── Preset selection ──
  const selectPreset = useCallback((preset: ProviderPreset) => {
    setSelectedPreset(preset.value);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });

    if (preset.custom) {
      setProviderName(customName.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(customUrl.trim());
      setProviderApi(customApi);
      setIsLocalProvider(false);
    } else {
      setProviderName(preset.value);
      setProviderUrl(preset.url);
      setProviderApi(preset.api);
      setIsLocalProvider(!!preset.local || !!preset.noKey);
      if (preset.local || preset.noKey) setApiKey('');
    }
  }, [customName, customUrl, customApi]);

  useEffect(() => {
    if (!isQuickTrack || selectedPreset || !siliconflowPreset) return;
    selectPreset(siliconflowPreset);
  }, [isQuickTrack, selectedPreset, siliconflowPreset, selectPreset]);

  useEffect(() => {
    let cancelled = false;
    const shouldResolveRuntimeDefault = isQuickTrack || selectedPreset === QUICK_START_PROVIDER.providerName;
    if (!shouldResolveRuntimeDefault) return;

    void loadRuntimeProviderInfo(onboardingFetch, QUICK_START_PROVIDER.providerName).then((runtimeInfo) => {
      if (cancelled || !runtimeInfo) return;
      setProviderName(runtimeInfo.providerName);
      setProviderUrl(runtimeInfo.providerUrl);
      setProviderApi(runtimeInfo.providerApi);
      setIsLocalProvider(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isQuickTrack, onboardingFetch, selectedPreset]);

  // ── Custom input sync ──
  const onCustomInput = useCallback((name: string, url: string, api: string) => {
    setCustomName(name);
    setCustomUrl(url);
    setCustomApi(api);
    if (selectedPreset === '_custom') {
      setProviderName(name.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(url.trim());
      setProviderApi(api);
      setConnectionTested(false);
      setTestStatus({ type: '', text: '' });
    }
  }, [selectedPreset]);

  // ── API key input ──
  const onApiKeyInput = useCallback((val: string) => {
    const cleaned = val.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleaned);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });
  }, []);

  // ── Button states ──
  const hasKey = !!apiKey || isLocalProvider;
  const hasProvider = !!providerName;
  const hasUrl = !!providerUrl;
  const testBtnDisabled = preview ? false : !(hasProvider && hasUrl && hasKey);
  const nextDisabled = preview ? false : !(hasProvider && hasUrl && hasKey && (isQuickTrack || connectionTested));

  const runConnectionTest = useCallback(async () => {
    if (preview) {
      setTestStatus({ type: 'success', text: t('onboarding.provider.testSuccess') });
      setConnectionTested(true);
      return true;
    }
    setTestStatus({ type: 'loading', text: t('onboarding.provider.testing') });
    try {
      const result = await testConnection({ onboardingFetch, providerName, providerUrl, providerApi, apiKey });
      if (result.ok) {
        setTestStatus({ type: 'success', text: result.text });
        setConnectionTested(true);
        return true;
      }
      setTestStatus({ type: 'error', text: result.text });
      setConnectionTested(false);
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestStatus({ type: 'error', text: msg });
      setConnectionTested(false);
      return false;
    }
  }, [preview, onboardingFetch, providerName, providerUrl, providerApi, apiKey]);

  // ── Test connection ──
  const onTest = useCallback(async () => {
    await runConnectionTest();
  }, [runConnectionTest]);

  // ── Next ──
  const onNext = useCallback(async () => {
    if (preview) { goToStep(isQuickTrack ? 5 : 3); return; }
    if (!connectionTested) {
      const ok = await runConnectionTest();
      if (!ok) return;
    }
    try {
      await saveProviderAction({
        onboardingFetch,
        providerName,
        providerUrl,
        apiKey,
        providerApi,
        defaultModelId: isQuickTrack ? (activePreset?.defaultModelId || QUICK_START_PROVIDER.defaultModelId) : null,
      });
      onProviderReady(providerName, providerUrl, providerApi, apiKey);
      goToStep(isQuickTrack ? 5 : 3);
    } catch (err) {
      console.error('[onboarding] save provider failed:', err);
      showError(t('onboarding.provider.testFailed'));
    }
  }, [preview, connectionTested, isQuickTrack, runConnectionTest, onboardingFetch, providerName, providerUrl, apiKey, providerApi, goToStep, showError, onProviderReady, activePreset]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.provider.title')}</h1>
        <Multiline
        className="onboarding-subtitle"
        text={isQuickTrack
          ? copyText(
              '默认模型已经内置好。\n不用注册，不用填 Key，下一步就会直接启用默认免费模型。',
              'The default model is built in.\nNo signup and no API key are required. The next step will enable the default free model directly.',
            )
          : t('onboarding.provider.subtitle')}
      />

      {isQuickTrack && (
        <div className="ob-step-banner">
          <div className="ob-step-banner-title">
            {copyText('默认模型已准备好', 'The default model is ready')}
          </div>
          <div className="ob-step-banner-desc" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
            <Multiline
              text={copyText(
                'Lynn 会直接使用内置的默认免费模型。\n如果你之后想换成自己的供应商，再到设置里补充其他 Provider 就可以。',
                'Lynn will use the built-in default free model directly.\nIf you want your own provider later, you can add it in Settings afterwards.',
              )}
            />
            <div className="ob-step-banner-meta" style={{ opacity: 0.78, fontSize: 12, lineHeight: 1.6 }}>
              {getBrainComplianceNote()}
            </div>
            <div className="ob-step-banner-meta" style={{ opacity: 0.62, fontSize: 12, lineHeight: 1.6 }}>
              {getBrainUserNotice()}
            </div>
          </div>
        </div>
      )}

      <div className="provider-grid">
        {PROVIDER_PRESETS.map(preset => (
          <div
            key={preset.value}
            className={`provider-card${selectedPreset === preset.value ? ' selected' : ''}`}
            onClick={() => selectPreset(preset)}
          >
            {preset.custom
              ? t('onboarding.provider.custom')
              : (isZh && 'labelZh' in preset && preset.labelZh ? preset.labelZh : preset.label)
            }
          </div>
        ))}
      </div>

      {/* Custom provider fields */}
      {selectedPreset === '_custom' && (
        <div className="custom-provider-row">
          <div className="custom-provider-fields">
            <div className="custom-field">
              <span className="ob-field-label">{t('onboarding.provider.customName')}</span>
              <input
                className="ob-input"
                type="text"
                placeholder={t('onboarding.provider.customNamePlaceholder')}
                value={customName}
                onChange={e => onCustomInput(e.target.value, customUrl, customApi)}
                autoComplete="off"
              />
            </div>
            <div className="custom-field">
              <span className="ob-field-label">{t('onboarding.provider.customUrl')}</span>
              <input
                className="ob-input"
                type="text"
                placeholder={t('onboarding.provider.customUrlPlaceholder')}
                value={customUrl}
                onChange={e => onCustomInput(customName, e.target.value, customApi)}
                autoComplete="off"
              />
            </div>
            <div className="custom-field">
              <select
                className="ob-input"
                value={customApi}
                onChange={e => onCustomInput(customName, customUrl, e.target.value)}
              >
                <option value="openai-completions">{t('onboarding.provider.apiOpenai') || 'OpenAI Compatible'}</option>
                <option value="anthropic-messages">{t('onboarding.provider.apiAnthropic') || 'Anthropic Messages'}</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* API Key */}
      {!isLocalProvider && (
        <>
          <span className="ob-field-label">{t('onboarding.provider.keyLabel')}</span>
          <div className="ob-key-row">
            <input
              className="ob-input"
              type={showKey ? 'text' : 'password'}
              placeholder={apiKeyHint(selectedPreset) || t('onboarding.provider.keyPlaceholder')}
              value={apiKey}
              onChange={e => onApiKeyInput(e.target.value)}
              autoComplete="off"
            />
            <button className="ob-key-toggle" onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </>
      )}

      {/* Test connection */}
      <div className="ob-test-row">
        <button
          className="ob-test-btn"
          disabled={testBtnDisabled}
          onClick={onTest}
        >
          {t('onboarding.provider.test')}
        </button>
        {testStatus.text && (
          <span className={`ob-status ${testStatus.type}`}>{testStatus.text}</span>
        )}
      </div>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(1)}>
          {t('onboarding.provider.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={nextDisabled}
          onClick={onNext}
        >
          {isQuickTrack
            ? copyText('保存并继续', 'Save and continue')
            : t('onboarding.provider.next')}
        </button>
      </div>
    </StepContainer>
  );
}

/** Provider-specific API key format hints */
function apiKeyHint(preset: string | null): string {
  switch (preset) {
    case 'openai':      return 'sk-...';
    case 'deepseek':    return 'sk-...';
    case 'dashscope':   return 'sk-...';
    case 'moonshot':    return 'sk-...';
    case 'siliconflow': return 'sk-...';
    case 'zhipu':       return '...  (zhipu open platform key)';
    case 'groq':        return 'gsk_...';
    case 'mistral':     return '...';
    default:            return '';
  }
}
