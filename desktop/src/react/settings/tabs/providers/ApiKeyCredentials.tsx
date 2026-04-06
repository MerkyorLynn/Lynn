import React, { useState, useEffect } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { SelectWidget } from '../../widgets/SelectWidget';
import { KeyInput } from '../../widgets/KeyInput';
import {
  BRAIN_PROVIDER_ID,
  BRAIN_PROVIDER_LABEL,
  getBrainComplianceNote,
  getBrainDisplayName,
  getBrainDisplayMetaLabel,
  getBrainUserNotice,
} from '../../../../../../shared/brain-provider.js';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function ApiKeyCredentials({ providerId, summary, providerConfig: _providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean; noKey?: boolean; defaultModelId?: string };
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [keyVal, setKeyVal] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const hasSavedKey = !!summary.api_key;
  const derivedBaseUrl = summary.base_url || presetInfo?.url || '';
  const [urlVal, setUrlVal] = useState(derivedBaseUrl);
  const [urlEdited, setUrlEdited] = useState(false);
  const api = summary.api || presetInfo?.api || '';
  const requiresKey = summary.type === 'api-key' && !presetInfo?.local;
  const isDefaultModelProvider = providerId === BRAIN_PROVIDER_ID;
  const [connStatus, setConnStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>(isDefaultModelProvider ? 'ok' : 'idle');

  // 未编辑时，从 summary 同步 base_url
  useEffect(() => {
    if (!urlEdited) setUrlVal(derivedBaseUrl);
  }, [derivedBaseUrl, urlEdited]);

  useEffect(() => {
    if (isDefaultModelProvider) setConnStatus('ok');
  }, [isDefaultModelProvider]);

  const verifyAndSave = async (btn: HTMLButtonElement) => {
    if (requiresKey && !keyEdited) return;
    const key = keyVal.trim();
    if (requiresKey && !key) return;
    btn.classList.add(styles['spinning']);
    try {
      const effectiveUrl = urlVal.trim() || derivedBaseUrl;
      const testRes = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: providerId, base_url: effectiveUrl, api, api_key: key }),
      });
      const testData = await testRes.json();
      if (!testData.ok) {
        showToast(t('settings.providers.verifyFailed'), 'error');
        return;
      }
      const payload: Record<string, unknown> = isPresetSetup
        ? {
            base_url: effectiveUrl,
            ...(requiresKey ? { api_key: key } : {}),
            api,
            models: summary.models?.length
              ? [...summary.models]
              : (presetInfo?.defaultModelId ? [presetInfo.defaultModelId] : []),
          }
        : (requiresKey ? { api_key: key } : {});
      // 如果 base_url 也被编辑过，一并保存
      if (urlEdited && !isPresetSetup) payload.base_url = effectiveUrl;
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: payload } }),
      });
      showToast(t('settings.providers.verifySuccess'), 'success');
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      setKeyEdited(false);
      if (urlEdited) setUrlEdited(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  const verifyOnly = async (btn: HTMLButtonElement) => {
    setConnStatus('testing');
    btn.classList.add(styles['spinning']);
    try {
      const testRes = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: providerId,
          base_url: urlVal.trim() || derivedBaseUrl,
          api,
          api_key: requiresKey ? (keyVal.trim() || undefined) : undefined,
        }),
      });
      const testData = await testRes.json();
      setConnStatus(testData.ok ? 'ok' : 'fail');
      showToast(testData.ok ? t('settings.providers.verifySuccess') : t('settings.providers.verifyFailed'), testData.ok ? 'success' : 'error');
    } catch {
      setConnStatus('fail');
      showToast(t('settings.providers.verifyFailed'), 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      {isDefaultModelProvider && (
        <div className={styles['pv-default-model-card']} style={{ marginBottom: 10 }}>
          <div className={styles['pv-default-model-title']}>{getBrainDisplayName()}</div>
          <div className={styles['pv-default-model-desc']}>{getBrainDisplayMetaLabel()}</div>
          <div className={styles['pv-default-model-hint']}>
            {t('settings.providers.defaultModelReadyHint') || '这条链路已经内置好，日常直接使用即可。只有在你主动更换其他供应商时，才需要再做额外配置。'}
          </div>
          <div className={styles['pv-default-model-hint']}>
            {getBrainComplianceNote()}
          </div>
          <div className={styles['pv-default-model-hint']} style={{ opacity: 0.78 }}>
            {getBrainUserNotice()}
          </div>
        </div>
      )}
      {requiresKey ? (
        <div className={styles['pv-cred-row']}>
          <span className={styles['pv-cred-label']}>{t('settings.api.apiKey')}</span>
          <div className={styles['pv-cred-key-row']}>
            <KeyInput
              value={keyVal}
              onChange={(v) => { setKeyVal(v); setKeyEdited(true); setConnStatus('idle'); }}
              placeholder={
                hasSavedKey
                  ? (t('settings.providers.savedKeyPlaceholder') || '已保存，留空则保持不变')
                  : (isPresetSetup ? t('settings.providers.setupHint') : '')
              }
            />
            <button
              className={`${styles['pv-cred-conn-icon']} ${styles[connStatus] || ''}`}
              title={t('settings.providers.verifyConnection')}
              onClick={(e) => {
                if (keyEdited && keyVal.trim()) {
                  verifyAndSave(e.currentTarget);
                } else {
                  verifyOnly(e.currentTarget);
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className={styles['pv-cred-row']}>
          <span className={styles['pv-cred-label']}>{t('settings.providers.authLabel') || '授权'}</span>
          <div className={styles['pv-cred-key-row']}>
            <input
              className={styles['settings-input']}
              type="text"
              value={isDefaultModelProvider ? `${BRAIN_PROVIDER_LABEL} 内置设备签名` : 'Lynn signed device token'}
              readOnly
            />
            {isDefaultModelProvider ? (
              <span className={`${styles['pv-cred-inline-status']} ${styles.ok}`}>
                {t('settings.providers.ready') || '已就绪'}
              </span>
            ) : (
              <button
                className={`${styles['pv-cred-conn-icon']} ${styles[connStatus] || ''}`}
                title={t('settings.providers.verifyConnection')}
                onClick={(e) => verifyAndSave(e.currentTarget)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.baseUrlLabel') || 'Base URL'}</span>
        <div className={styles['pv-cred-url-row']}>
          <input
            className={styles['settings-input']}
            type="text"
            value={urlVal}
            onChange={(e) => { setUrlVal(e.target.value); setUrlEdited(true); }}
            onBlur={async () => {
              if (!urlEdited || isPresetSetup) return;
              const trimmed = urlVal.trim();
              if (trimmed === derivedBaseUrl) { setUrlEdited(false); return; }
              try {
                await hanaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { base_url: trimmed } } }),
                });
                showToast(t('settings.saved'), 'success');
                setUrlEdited(false);
                await onRefresh();
              } catch { /* swallow */ }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="https://api.example.com/v1"
            readOnly={!!isPresetSetup || isDefaultModelProvider}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.apiType')}</span>
        <div className={styles['pv-cred-select-wrapper']}>
            <SelectWidget
              options={API_FORMAT_OPTIONS}
              value={api || ''}
            onChange={async (val) => {
              if (isPresetSetup || isDefaultModelProvider) return;
              try {
                await hanaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { api: val } } }),
                });
                showToast(t('settings.saved'), 'success');
                await onRefresh();
              } catch { /* swallow */ }
            }}
            placeholder="API Format"
            disabled={!!isPresetSetup || isDefaultModelProvider}
          />
        </div>
      </div>
    </div>
  );
}
