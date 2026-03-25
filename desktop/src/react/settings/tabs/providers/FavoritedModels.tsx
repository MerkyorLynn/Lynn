import React, { useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import {
  t, formatContext, lookupModelMeta, favKey, parseFavKey,
  autoSaveConfig, autoSaveModels,
} from '../../helpers';
import { ModelEditPanel } from './ModelEditPanel';
import styles from '../../Settings.module.css';

export function FavoritedModels({ providerId, summary }: {
  providerId: string;
  summary: ProviderSummary;
}) {
  const { pendingFavorites, pendingDefaultModel } = useSettingsStore();
  const allModels = [...new Set([...(summary.models || []), ...(summary.custom_models || [])])];
  const favModels = allModels.filter(m => pendingFavorites.has(favKey(providerId, m)));

  const removeFavorite = (mid: string) => {
    const key = favKey(providerId, mid);
    const next = new Set(pendingFavorites);
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
    autoSaveModels();
  };

  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  if (favModels.length === 0) return null;

  return (
    <div className={styles['pv-fav-section']}>
      <div className={styles['pv-fav-title']}>
        {t('settings.api.addedModels')}
        <span className={styles['pv-models-count']}>{favModels.length}</span>
      </div>
      <div className={styles['pv-fav-list']}>
        {favModels.map(mid => {
          const meta = lookupModelMeta(mid) || {};
          return (
            <div key={mid} className={styles['pv-fav-item']}>
              <span className={styles['pv-fav-item-name']} title={mid}>{meta.displayName || meta.name || mid}</span>
              {(meta.displayName || meta.name) && meta.displayName !== mid && meta.name !== mid && <span className={styles['pv-fav-item-id']}>{mid}</span>}
              {meta.context && <span className={styles['pv-model-ctx']}>{formatContext(meta.context)}</span>}
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
                <button className={styles['pv-fav-item-remove']} onClick={() => removeFavorite(mid)} title={t('settings.api.removeModel')}>
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
        <ModelEditPanel modelId={editing.id} anchorEl={editing.anchor} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
