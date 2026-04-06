import React, { useState, useEffect, useCallback } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from '../Settings.module.css';

interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  status: 'loaded' | 'failed' | 'disabled';
  contributions?: string[];
  error?: string | null;
}

function StatusBadge({ status }: { status: PluginInfo['status'] }) {
  const labelKey =
    status === 'loaded' ? 'settings.plugins.statusLoaded' :
    status === 'failed' ? 'settings.plugins.statusFailed' :
    'settings.plugins.statusDisabled';

  const style: React.CSSProperties =
    status === 'loaded'
      ? { color: 'var(--success, #5a9)', background: 'rgba(90,170,153,0.1)' }
      : status === 'failed'
      ? { color: 'var(--danger, #c55)', background: 'rgba(204,85,85,0.1)' }
      : { color: 'var(--text-muted)', background: 'var(--overlay-light, rgba(0,0,0,0.06))' };

  return (
    <span
      className={styles['oauth-status-badge']}
      style={style}
    >
      {t(labelKey)}
    </span>
  );
}

function ContributionBadges({ contributions }: { contributions?: string[] }) {
  if (!contributions || contributions.length === 0) return null;

  return (
    <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
      {contributions.map(c => (
        <span
          key={c}
          className={styles['skills-source-badge']}
          style={{ marginRight: 0, opacity: 1, background: 'var(--overlay-light, rgba(0,0,0,0.05))', padding: '1px 6px', borderRadius: 'var(--radius-sm)' }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hanaFetch('/api/plugins');
      const data = await res.json();
      setPlugins(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[plugins] load failed:', err);
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="plugins">
      <section className={styles['settings-section']}>
        <div className={styles['settings-section-header']}>
          <h2 className={styles['settings-section-title']}>{t('settings.plugins.title')}</h2>
          <button
            className={styles['settings-icon-btn']}
            title={t('settings.plugins.reload')}
            onClick={loadPlugins}
            disabled={loading}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={loading ? styles['spin'] : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <p className={styles['settings-desc']}>{t('settings.plugins.desc')}</p>

        {!loading && plugins.length === 0 ? (
          <p className={`${styles['settings-desc']} ${styles['skills-empty']}`}>
            {t('settings.plugins.empty')}
          </p>
        ) : (
          <div className={styles['skills-list-block']}>
            {plugins.map(plugin => (
              <div key={plugin.id} className={styles['skills-list-item']}>
                <div className={styles['skills-list-info']}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span className={styles['skills-list-name']}>{plugin.name}</span>
                    {plugin.version && (
                      <span className={styles['skills-list-name-hint']}>v{plugin.version}</span>
                    )}
                    <StatusBadge status={plugin.status} />
                    <ContributionBadges contributions={plugin.contributions} />
                  </div>
                  {plugin.description && (
                    <span className={styles['skills-list-desc']}>{plugin.description}</span>
                  )}
                  {plugin.status === 'failed' && plugin.error && (
                    <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)' }}>
                      {plugin.error}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
