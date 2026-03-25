import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import {
  t, formatContext, lookupModelMeta, favKey, parseFavKey,
  autoSaveConfig, autoSaveModels,
} from '../../helpers';
import { ModelEditPanel } from './ModelEditPanel';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function ProviderModelList({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const { pendingFavorites, pendingDefaultModel, showToast } = useSettingsStore();
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');

  const allModels = [...new Set([...(summary.models || []), ...(summary.custom_models || [])])];
  const query = search.toLowerCase();
  const filtered = query ? allModels.filter(m => m.toLowerCase().includes(query)) : allModels;

  const toggleFavorite = (mid: string) => {
    const key = favKey(providerId, mid);
    const next = new Set(pendingFavorites);
    if (next.has(key)) {
      next.delete(key);
      let nextDefault = pendingDefaultModel;
      if (key === pendingDefaultModel) {
        const firstRemaining = [...next][0] || '';
        nextDefault = firstRemaining;
        const { provider: p, id } = parseFavKey(firstRemaining);
        const partial: Record<string, unknown> = { models: { chat: id || '' } };
        if (p) partial.api = { provider: p };
        autoSaveConfig(partial, { refreshModels: true });
      }
      useSettingsStore.setState({ pendingFavorites: next, pendingDefaultModel: nextDefault });
    } else {
      next.add(key);
      const wasEmpty = pendingFavorites.size === 0;
      const updates: Record<string, unknown> = { pendingFavorites: next };
      if (wasEmpty) {
        (updates as Record<string, unknown>).pendingDefaultModel = key;
        const partial: Record<string, unknown> = { models: { chat: mid } };
        (partial as Record<string, unknown>).api = { provider: providerId };
        autoSaveConfig(partial, { refreshModels: true });
      }
      useSettingsStore.setState(updates as Partial<ReturnType<typeof useSettingsStore.getState>>);
    }
    autoSaveModels();
  };

  const addCustomModel = async () => {
    const id = customInput.trim();
    if (!id) return;
    try {
      if (summary.supports_oauth) {
        const res = await hanaFetch(`/api/auth/oauth/${providerId}/custom-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } else {
        const currentModels = summary.models || [];
        await hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: { [providerId]: { models: [...currentModels, id] } } }),
        });
      }
      setCustomInput('');
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    }
  };

  const [fetchHint, setFetchHint] = useState<{ msg: string; ok: boolean } | null>(null);
  const fetchHintTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const showFetchHint = (msg: string, ok: boolean) => {
    if (fetchHintTimer.current) clearTimeout(fetchHintTimer.current);
    setFetchHint({ msg, ok });
    fetchHintTimer.current = setTimeout(() => setFetchHint(null), 2500);
  };

  const fetchModels = async (btn: HTMLButtonElement | null) => {
    if (btn) btn.classList.add(styles['spinning']);
    try {
      const res = await hanaFetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: providerId, base_url: summary.base_url, api: summary.api }),
      });
      const data = await res.json();
      if (data.error) { showFetchHint(t('settings.providers.fetchFailed'), false); return; }
      const models = (data.models || []).map((m: { id?: string; name?: string }) => m.id || m.name);
      if (models.length === 0) { showFetchHint(t('settings.providers.fetchFailed'), false); return; }
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models } } }),
      });
      showFetchHint(t('settings.providers.fetchSuccess', { name: providerId, n: models.length }), true);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch {
      showFetchHint(t('settings.providers.fetchFailed'), false);
    } finally {
      if (btn) btn.classList.remove(styles['spinning']);
    }
  };

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!dropdownOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const w = rect.width + 80;
    const left = Math.min(rect.left, window.innerWidth - w - 8);
    setPanelStyle({
      position: 'fixed',
      left: Math.max(8, left),
      width: w,
      bottom: window.innerHeight - rect.top + 4,
      zIndex: 9999,
    });
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  return (
    <div className={styles['pv-models']}>
      <div className={styles['pv-models-action-row']}>
        <button ref={triggerRef} className={styles['pv-model-dropdown-trigger']} onClick={() => setDropdownOpen(!dropdownOpen)}>
          <span>{t('settings.api.addModel')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          className={styles['pv-fetch-btn-inline']}
          title={t('settings.providers.fetchModels')}
          onClick={(e) => fetchModels(e.currentTarget)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {t('settings.providers.fetchModels')}
        </button>
      </div>
      {fetchHint && <div className={`${styles['pv-fetch-hint']} ${fetchHint.ok ? styles['ok'] : styles['fail']}`}>{fetchHint.msg}</div>}
      {dropdownOpen && (
          <div className={styles['pv-model-dropdown-panel']} ref={panelRef} style={panelStyle}>
            <input
              className={styles['pv-model-dropdown-search']}
              type="text"
              placeholder={t('settings.api.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className={styles['pv-model-dropdown-list']}>
              {filtered.map(mid => {
                const isFav = pendingFavorites.has(favKey(providerId, mid));
                const meta = lookupModelMeta(mid) || {};
                return (
                  <button
                    key={mid}
                    className={`${styles['pv-model-dropdown-option']}${isFav  ? ' ' + styles['added'] : ''}`}
                    onClick={() => { if (!isFav) { toggleFavorite(mid); } }}
                  >
                    <span className={styles['pv-model-dropdown-option-name']}>{mid}</span>
                    {isFav && <span className={styles['pv-model-dropdown-option-check']}>{'\u2713'}</span>}
                    {meta.context && <span className={styles['pv-model-ctx']}>{formatContext(meta.context)}</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className={styles['pv-model-dropdown-empty']}>{t('settings.providers.noModels')}</div>
              )}
            </div>
            <div className={styles['pv-model-dropdown-custom']}>
              <input
                className={styles['pv-model-dropdown-custom-input']}
                type="text"
                placeholder={t('settings.oauth.customModelPlaceholder')}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { addCustomModel(); } }}
              />
              <button className={styles['pv-model-add-btn']} onClick={addCustomModel}>{'\u21B5'}</button>
            </div>
          </div>
        )}
    </div>
  );
}
