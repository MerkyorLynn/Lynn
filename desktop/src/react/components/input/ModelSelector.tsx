import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { loadModels } from '../../utils/ui-helpers';
import { lookupKnownModel } from '../../utils/known-models';
import {
  collapseBrainModelChoices,
  isDisplayDefaultModel,
  normalizeDisplayProviderLabel,
  normalizeDisplayModelName,
} from '../../utils/brain-models';
import { getUserFacingModelAlias } from '../../../../../shared/assistant-role-models.js';
import { showSidebarToast } from '../../stores/session-actions';
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

function modelMetaLine(model?: SelectorModel, role?: string | null): string {
  if (!model) return '';
  if (model.metaLabel) return model.metaLabel;
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider,
    role,
    purpose: 'chat',
  });
  if (alias && !isDisplayDefaultModel(model.id, model.provider)) return '按角色自动分配 · 已就绪';
  if (isDisplayDefaultModel(model.id, model.provider)) return '开箱即用 · 已备案';
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
  const agentYuan = useStore((s: any) => s.agentYuan) || 'lynn';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibleModels = useMemo(() => collapseBrainModelChoices(models), [models]);

  const current = visibleModels.find(m => m.isCurrent);
  const hasSwitchableModels = visibleModels.filter(m => !m.locked).length > 1;

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

      await loadModels();
    } catch (err) {
      console.error('[model] switch failed:', err);
      showSidebarToast(t('model.switchFailed') || '切换模型失败', 5000, 'error');
    }
    setOpen(false);
  }, [t]);

  const grouped = useMemo(() => {
    const groups: Record<string, SelectorModel[]> = {};
    for (const m of visibleModels) {
      const key = m.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    if (current && !visibleModels.find(m => m.id === current.id && m.provider === current.provider)) {
      const key = current.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].unshift(current);
    }
    return groups;
  }, [visibleModels, current]);

  const groupKeys = Object.keys(grouped);
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');
  const currentMeta = modelMetaLine(current, agentYuan);

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
        <span className={styles['model-pill-name']}>{normalizeDisplayModelName(current, { role: agentYuan, purpose: 'chat' }) || t('model.unknown') || '...'}</span>
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
                  <div className={styles['model-group-header']}>{normalizeDisplayProviderLabel(provider) || '—'}</div>
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
                      <span className={styles['model-option-name']}>{normalizeDisplayModelName(m)}</span>
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
