import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { loadModels } from '../../utils/ui-helpers';
import { lookupKnownModel } from '../../utils/known-models';
import styles from './InputArea.module.css';

interface SelectorModel {
  id: string;
  name: string;
  provider?: string;
  isCurrent?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  locked?: boolean;
  metaLabel?: string;
}

function formatProviderLabel(provider?: string): string {
  if (!provider) return '';
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function modelMetaLine(model?: SelectorModel): string {
  if (!model) return '';
  if (model.metaLabel) return model.metaLabel;
  const meta = lookupKnownModel(model.provider || '', model.id);
  const parts: string[] = [];
  const providerLabel = formatProviderLabel(model.provider);
  const context = model.contextWindow || meta?.contextWindow || meta?.context;

  if (providerLabel) parts.push(providerLabel);
  if (context) parts.push('ctx ' + Math.max(1, Math.round(context / 1000)) + 'k');

  return parts.join(' · ');
}

export function ModelSelector({ models, disabled }: { models: SelectorModel[]; disabled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find(m => m.isCurrent);
  const hasSwitchableModels = models.some(m => !m.locked);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const switchModel = useCallback(async (modelId: string, provider?: string) => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, provider }),
      });

      const { currentSessionPath, pendingNewSession } = useStore.getState();
      if (currentSessionPath && !pendingNewSession) {
        const { createNewSession } = await import('../../stores/session-actions');
        await createNewSession();
      }

      await loadModels();
    } catch (err) {
      console.error('[model] switch failed:', err);
    }
    setOpen(false);
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<string, SelectorModel[]> = {};
    for (const m of models) {
      const key = m.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    if (current && !models.find(m => m.id === current.id && m.provider === current.provider)) {
      const key = current.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].unshift(current);
    }
    return groups;
  }, [models, current]);

  const groupKeys = Object.keys(grouped);
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');
  const currentMeta = modelMetaLine(current);

  return (
    <div className={`${styles['model-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button
        className={`${styles['model-pill']}${disabled ? ` ${styles['model-pill-disabled']}` : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled && hasSwitchableModels) setOpen(!open);
        }}
        title={currentMeta || current?.id || ''}
      >
        <span className={styles['model-pill-name']}>{current?.name || t('model.unknown') || '...'}</span>
        {currentMeta && <span className={styles['model-pill-meta']}>{currentMeta}</span>}
        {hasSwitchableModels && <span className={styles['model-arrow']}>▾</span>}
      </button>
      {open && hasSwitchableModels && (
        <div className={styles['model-dropdown']}>
          {groupKeys.map(provider => {
            const items = grouped[provider];
            return (
              <div key={provider || '__none'}>
                {hasMultipleProviders && (
                  <div className={styles['model-group-header']}>{provider || '—'}</div>
                )}
                {items.map(m => {
                  const meta = modelMetaLine(m);
                  return (
                    <button
                      key={`${m.provider || '__default'}/${m.id}`}
                      className={`${styles['model-option']}${m.isCurrent ? ` ${styles.active}` : ''}`}
                      onClick={() => {
                        if (!m.locked) switchModel(m.id, m.provider);
                      }}
                      title={m.id}
                      disabled={m.locked}
                    >
                      <span className={styles['model-option-name']}>{m.name}</span>
                      <span className={styles['model-option-meta']}>{meta || m.id}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
