import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { loadModels } from '../../utils/ui-helpers';
import { lookupKnownModel } from '../../utils/known-models';
import { currentLocale, isChineseLocale } from '../../utils/locale';

/** Inline zh/en picker for model-pill copy. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);
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

const LOCAL_QWEN35_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
const LOCAL_QWEN35_MODEL_ID = 'qwen38-27b-coder390-q3-lynnstyle';

function formatProviderLabel(provider?: string): string {
  if (!provider) return '';
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isLocalQwen35(model?: SelectorModel | null): boolean {
  return model?.provider === LOCAL_QWEN35_PROVIDER_ID && (model?.id === LOCAL_QWEN35_MODEL_ID || model?.id === 'qwen38-27b-efficientthink-q2-lynnstyle');
}

function compactPillModelName(model?: SelectorModel | null, role?: string | null): string {
  if (isLocalQwen35(model)) return 'Qwen3.8-27B';
  return normalizeDisplayModelName(model, { role, purpose: 'chat' });
}

function modelMetaLine(model?: SelectorModel, role?: string | null): string {
  if (!model) return '';
  if (model.metaLabel) return model.metaLabel;
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider,
    role,
    purpose: 'chat',
    locale: currentLocale(),
  });
  if (alias && !isDisplayDefaultModel(model.id, model.provider)) return D('按角色自动分配 · 已就绪', 'Assigned by role · ready');
  if (isDisplayDefaultModel(model.id, model.provider)) return D('开箱即用 · 已备案', 'Works out of the box · approved');
  const meta = lookupKnownModel(model.provider || '', model.id);
  const parts: string[] = [];
  const providerLabel = formatProviderLabel(model.provider);
  const context = model.contextWindow || meta?.contextWindow || meta?.context;

  if (providerLabel) parts.push(providerLabel);
  if (context) parts.push('ctx ' + Math.max(1, Math.round(context / 1000)) + 'k');

  return parts.join(' · ');
}

export function ModelSelector({
  models,
  disabled,
  localQwenRunning = false,
  localQwenLoading = false,
}: {
  models: SelectorModel[];
  disabled?: boolean;
  localQwenRunning?: boolean;
  localQwenLoading?: boolean;
}) {
  const { t } = useI18n();
  const agentYuan = useStore((s) => s.agentYuan) || 'lynn';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibleModels = useMemo(() => {
    const priority = (model: SelectorModel) => {
      if (isLocalQwen35(model)) return 0;
      if (model.isCurrent) return 1;
      if (model.provider === LOCAL_QWEN35_PROVIDER_ID) return 2;
      return 10;
    };
    return [...collapseBrainModelChoices(models)].sort((a, b) => {
      const byPriority = priority(a) - priority(b);
      if (byPriority !== 0) return byPriority;
      return compactPillModelName(a, agentYuan).localeCompare(compactPillModelName(b, agentYuan));
    });
  }, [agentYuan, models]);

  const current = visibleModels.find(m => m.isCurrent);
  const hasSwitchableModels = visibleModels.filter(m => !m.locked).length > 1;

  useEffect(() => {
    if (!open) return;
    const mouseHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', mouseHandler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', mouseHandler);
      document.removeEventListener('keydown', keyHandler);
    };
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

  const groupKeys = Object.keys(grouped).sort((a, b) => {
    const rank = (provider: string) => {
      if (provider === LOCAL_QWEN35_PROVIDER_ID) return 0;
      if (provider === current?.provider) return 1;
      if (!provider) return 9;
      return 5;
    };
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return normalizeDisplayProviderLabel(a).localeCompare(normalizeDisplayProviderLabel(b));
  });
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');
  const currentMeta = modelMetaLine(current, agentYuan);
  const currentIsLocalQwen35 = isLocalQwen35(current);
  const localQwenStatusClass = localQwenRunning
    ? styles['model-pill-status-dot-running']
    : localQwenLoading
      ? styles['model-pill-status-dot-loading']
      : styles['model-pill-status-dot-offline'];
  const localQwenTitle = localQwenRunning
    ? D('本地 Qwen3.8-27B 正在运行 · Q4 imatrix MTP', 'Local Qwen3.8-27B is running · Q4 imatrix MTP')
    : localQwenLoading
      ? D('本地 Qwen3.8-27B 正在启动 · Q4 imatrix MTP', 'Local Qwen3.8-27B is starting · Q4 imatrix MTP')
      : D('本地 Qwen3.8-27B 已选择，尚未启动', 'Local Qwen3.8-27B is selected but not started');
  const localQwenInlineState = localQwenRunning
    ? null
    : localQwenLoading
      ? D('启动中', 'Starting')
      : D('未启动', 'Not started');

  return (
    <div className={`${styles['model-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button
        className={`${styles['model-pill']}${disabled ? ` ${styles['model-pill-disabled']}` : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled && hasSwitchableModels) setOpen(!open);
        }}
        title={currentIsLocalQwen35 ? localQwenTitle : (currentMeta || current?.id || '')}
      >
        {currentIsLocalQwen35 && <span className={`${styles['model-pill-status-dot']} ${localQwenStatusClass}`} aria-hidden="true" />}
        <span className={styles['model-pill-name']}>{compactPillModelName(current, agentYuan) || t('model.unknown') || '...'}</span>
        {currentIsLocalQwen35 && localQwenInlineState && (
          <span className={styles['model-pill-local-state']}>{localQwenInlineState}</span>
        )}
        {currentMeta && !currentIsLocalQwen35 && <span className={styles['model-pill-meta']}>{currentMeta}</span>}
        {hasSwitchableModels && <span className={styles['model-arrow']}>▾</span>}
      </button>
      {open && hasSwitchableModels && (
        <div className={styles['model-dropdown']}>
          {groupKeys.map(provider => {
            const items = grouped[provider];
            return (
              <div key={provider || '__none'}>
                {hasMultipleProviders && (
                  <div className={styles['model-group-header']}>
                    {provider === LOCAL_QWEN35_PROVIDER_ID
                      ? D('本地模型', 'Local models')
                      : normalizeDisplayProviderLabel(provider) || '—'}
                  </div>
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
