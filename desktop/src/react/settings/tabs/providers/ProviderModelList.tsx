import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t, formatContext, lookupModelMeta } from '../../helpers';
import { ModelEditPanel } from './ModelEditPanel';
import {
  BRAIN_PROVIDER_ID,
} from '../../../../../../shared/brain-provider.js';
import {
  brainComplianceNote,
  brainDisplayMetaLabel,
  brainDisplayName,
} from '../../../utils/brain-models';
import styles from '../../Settings.module.css';
import { notifyModelsChanged } from './model-change-events';

interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number | null;
  maxOutput?: number | null;
  vision?: boolean | null;
  reasoning?: boolean | null;
}

type ProviderModelEntry = string | {
  id?: string;
  name?: string;
  displayName?: string;
  context?: number | null;
  maxOutput?: number | null;
  vision?: boolean | null;
  reasoning?: boolean | null;
};

function modelEntryId(entry: ProviderModelEntry): string {
  if (typeof entry === 'string') return entry;
  return typeof entry?.id === 'string' ? entry.id : '';
}

function modelEntryMeta(entry: ProviderModelEntry | undefined): Partial<DiscoveredModel> {
  if (!entry || typeof entry === 'string') return {};
  return {
    name: entry.name || entry.displayName,
    context: entry.context,
    maxOutput: entry.maxOutput,
    vision: entry.vision,
    reasoning: entry.reasoning,
  };
}

function modelEntryFromDiscovery(model: DiscoveredModel | undefined, fallbackId: string): ProviderModelEntry {
  const id = String(model?.id || fallbackId || '').trim();
  if (!id) return fallbackId;
  const hasMetadata = Boolean(model?.name)
    || model?.context != null
    || model?.maxOutput != null
    || typeof model?.vision === 'boolean'
    || typeof model?.reasoning === 'boolean';
  if (!hasMetadata) return id;
  return {
    id,
    name: model?.name,
    context: model?.context ?? null,
    maxOutput: model?.maxOutput ?? null,
    vision: typeof model?.vision === 'boolean' ? model.vision : null,
    reasoning: typeof model?.reasoning === 'boolean' ? model.reasoning : null,
  };
}

function uniqueModelIds(ids: Array<string | undefined | null>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function buildProviderModelOptions({
  currentModelEntries,
  discoveredModels,
  customModels,
  removedModels,
}: {
  currentModelEntries: ProviderModelEntry[];
  discoveredModels: DiscoveredModel[];
  customModels: string[];
  removedModels?: string[];
}): { currentModels: string[]; candidateModels: string[] } {
  const currentModels = uniqueModelIds(currentModelEntries.map(modelEntryId));
  const currentSet = new Set(currentModels);
  const removedSet = new Set(uniqueModelIds(removedModels || []));
  const candidateModels = uniqueModelIds([
    ...discoveredModels.map(m => m.id),
    ...(customModels || []),
  ]).filter((id) => !currentSet.has(id) && !removedSet.has(id));
  return { currentModels, candidateModels };
}

export function nextRemovedModelsAfterAdd(removedModels: string[] | undefined, modelId: string): string[] {
  return uniqueModelIds(removedModels || []).filter((id) => id !== modelId);
}

export function nextRemovedModelsAfterRemove(removedModels: string[] | undefined, modelId: string): string[] {
  return uniqueModelIds([...(removedModels || []), modelId]);
}

export function buildAutoRegisteredModelEntries({
  currentModelEntries,
  discoveredModels,
  removedModels,
}: {
  currentModelEntries: ProviderModelEntry[];
  discoveredModels: DiscoveredModel[];
  removedModels?: string[];
}): ProviderModelEntry[] {
  if (uniqueModelIds(currentModelEntries.map(modelEntryId)).length > 0) {
    return currentModelEntries;
  }

  const removedSet = new Set(uniqueModelIds(removedModels || []));
  const seen = new Set<string>();
  const entries: ProviderModelEntry[] = [];
  for (const model of discoveredModels) {
    const id = String(model?.id || '').trim();
    if (!id || removedSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push(modelEntryFromDiscovery(model, id));
  }
  return entries;
}

export function ProviderModelList({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const isBrainProvider = providerId === BRAIN_PROVIDER_ID;
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);

  const loadDiscoveredModels = useCallback(async () => {
    if (isBrainProvider) {
      setDiscoveredModels([]);
      return;
    }
    try {
      const res = await hanaFetch(`/api/providers/${encodeURIComponent(providerId)}/discovered-models`);
      const data = await res.json();
      setDiscoveredModels(data.models || []);
    } catch {
      // cache miss is fine
    }
  }, [isBrainProvider, providerId]);

  useEffect(() => { void loadDiscoveredModels(); }, [loadDiscoveredModels]);

  const currentModelEntries = (summary.models || []) as ProviderModelEntry[];
  const { currentModels, candidateModels } = buildProviderModelOptions({
    currentModelEntries,
    discoveredModels,
    customModels: summary.custom_models || [],
    removedModels: summary.removed_models || [],
  });
  const query = search.toLowerCase();
  const filtered = query ? candidateModels.filter(m => m.toLowerCase().includes(query)) : candidateModels;

  const addModelToProvider = async (mid: string) => {
    if (currentModels.includes(mid)) return;
    const nextRemoved = nextRemovedModelsAfterAdd(summary.removed_models, mid);
    const discovered = discoveredModels.find((model) => model.id === mid);
    const nextEntry = modelEntryFromDiscovery(discovered, mid);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: [...currentModelEntries, nextEntry], removed_models: nextRemoved } } }),
      });
      await onRefresh();
      notifyModelsChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    }
  };

  const removeModelFromProvider = async (mid: string) => {
    try {
      const next = currentModelEntries.filter(m => modelEntryId(m) !== mid);
      const nextRemoved = nextRemovedModelsAfterRemove(summary.removed_models, mid);
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: next, removed_models: nextRemoved } } }),
      });
      await onRefresh();
      notifyModelsChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    }
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
        const nextRemoved = nextRemovedModelsAfterAdd(summary.removed_models, id);
        await hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: { [providerId]: { models: [...currentModelEntries, id], removed_models: nextRemoved } } }),
        });
      }
      setCustomInput('');
      await onRefresh();
      notifyModelsChanged();
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
      const models = (data.models || []) as DiscoveredModel[];
      if (models.length === 0) { showFetchHint(t('settings.providers.fetchFailed'), false); return; }
      setDiscoveredModels(models);
      const nextModels = buildAutoRegisteredModelEntries({
        currentModelEntries,
        discoveredModels: models,
        removedModels: summary.removed_models || [],
      });
      if (currentModels.length === 0 && nextModels.length > 0) {
        await hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providers: {
              [providerId]: {
                models: nextModels,
                removed_models: summary.removed_models || [],
              },
            },
          }),
        });
        await onRefresh();
        notifyModelsChanged();
      }
      showFetchHint(t('settings.providers.fetchSuccess', { name: providerId, n: models.length }), true);
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
      top: rect.bottom + 4,
      maxHeight: window.innerHeight - rect.bottom - 12,
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

  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  if (isBrainProvider) {
    return (
      <div className={styles['pv-models']}>
        <div className={styles['pv-default-model-card']}>
          <div className={styles['pv-default-model-title']}>{brainDisplayName()}</div>
          <div className={styles['pv-default-model-desc']}>{brainDisplayMetaLabel()}</div>
          <div className={styles['pv-default-model-hint']}>
            {t('settings.providers.defaultModelHint') || 'Lynn 会在后台统一调度默认模型，无需手动添加、删除或挑选具体型号。'}
          </div>
          <div className={styles['pv-default-model-hint']}>
            {brainComplianceNote()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles['pv-models']}>
      {/* Added models list */}
      {currentModels.length > 0 && (
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {t('settings.api.addedModels')}
            <span className={styles['pv-models-count']}>{currentModels.length}</span>
          </div>
          <div className={styles['pv-fav-list']}>
            {currentModels.map(mid => {
              const meta = lookupModelMeta(mid) || {};
              const savedMeta = modelEntryMeta(currentModelEntries.find(entry => modelEntryId(entry) === mid));
              return (
                <div key={mid} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={mid}>{meta.displayName || savedMeta.name || meta.name || mid}</span>
                  {(meta.displayName || meta.name) && meta.displayName !== mid && meta.name !== mid && <span className={styles['pv-fav-item-id']}>{mid}</span>}
                  {(savedMeta.context || meta.context) && <span className={styles['pv-model-ctx']}>{formatContext((savedMeta.context || meta.context) as number)}</span>}
                  <div className={styles['pv-fav-item-actions']}>
                    <button
                      className={styles['pv-fav-item-edit']}
                      title={t('settings.api.editModel')}
                      onClick={(e) => setEditing({ id: mid, anchor: e.currentTarget })}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button className={styles['pv-fav-item-remove']} onClick={() => removeModelFromProvider(mid)} title={t('settings.api.removeModel')}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {editing && (
            <ModelEditPanel
              modelId={editing.id}
              providerId={providerId}
              anchorEl={editing.anchor}
              onClose={() => setEditing(null)}
              onRefresh={onRefresh}
            />
          )}
        </div>
      )}

      {/* Add model dropdown + fetch button */}
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
	                const meta = lookupModelMeta(mid) || {};
	                const savedMeta = modelEntryMeta(currentModelEntries.find(entry => modelEntryId(entry) === mid));
	                const discovered = discoveredModels.find(d => d.id === mid);
	                const ctx = savedMeta.context || meta.context || discovered?.context;
                return (
                  <button
                    key={mid}
                    className={styles['pv-model-dropdown-option']}
                    onClick={() => { addModelToProvider(mid); }}
                  >
                    <span className={styles['pv-model-dropdown-option-name']}>{mid}</span>
                    {ctx && <span className={styles['pv-model-ctx']}>{formatContext(ctx)}</span>}
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
