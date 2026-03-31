import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { loadSettingsConfig } from '../actions';
import iconUrl from '../../../assets/Lynn.png';
import styles from '../Settings.module.css';
import type { AutoUpdateState } from '../../types';

const hana = window.hana;

export function AboutTab() {
  const { settingsConfig } = useSettingsStore();
  const [version, setVersion] = useState('');
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState | null>(null);
  const isBeta = settingsConfig?.update_channel === 'beta';

  // 全权模式 easter egg：点击头像 5 次解锁
  const [devUnlocked, setDevUnlocked] = useState(false);
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFullAccessWarning, setShowFullAccessWarning] = useState(false);

  const sandboxEnabled = settingsConfig?.sandbox !== false;

  const handleIconTap = () => {
    tapCount.current += 1;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (tapCount.current >= 5) {
      tapCount.current = 0;
      setDevUnlocked(prev => !prev);
    } else {
      tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 1500);
    }
  };

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
    hana?.autoUpdateState?.().then((s: AutoUpdateState) => {
      if (s) setAutoUpdate(s);
    });
    hana?.onAutoUpdateState?.((s: AutoUpdateState) => setAutoUpdate(s));
  }, []);

  const handleCheck = useCallback(() => {
    hana?.autoUpdateCheck?.();
  }, []);

  const handleDownload = useCallback(() => {
    hana?.autoUpdateDownload?.();
  }, []);

  const handleInstall = useCallback(() => {
    hana?.autoUpdateInstall?.();
  }, []);

  const handleBetaToggle = useCallback(async (on: boolean) => {
    const channel = on ? 'beta' : 'stable';
    hana?.autoUpdateSetChannel?.(channel);
    await autoSaveConfig({ update_channel: channel }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const renderUpdateStatus = () => {
    if (!autoUpdate) return null;
    const { status, version: newVer, progress, error } = autoUpdate;

    switch (status) {
      case 'checking':
        return (
          <div className={styles['about-update']}>
            <span>{t('settings.about.updateChecking')}</span>
          </div>
        );
      case 'available':
        return (
          <div className={styles['about-update']}>
            <span>{t('settings.about.updateAvailable', { version: newVer })}</span>
            <a className={styles['about-update-link']} href="#"
              onClick={(e) => { e.preventDefault(); handleDownload(); }}>
              {t('settings.about.updateDownload')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>
          </div>
        );
      case 'downloading':
        return (
          <div className={styles['about-update']}>
            <span>{t('settings.about.updateDownloading', { version: newVer })}</span>
            {progress && (
              <span className={styles['about-update-progress']}>
                {t('settings.about.updateProgress', { percent: progress.percent })}
              </span>
            )}
          </div>
        );
      case 'downloaded':
        return (
          <div className={styles['about-update']}>
            <span>{t('settings.about.updateReadyInstall', { version: newVer })}</span>
            <a className={styles['about-update-link']} href="#"
              onClick={(e) => { e.preventDefault(); handleInstall(); }}>
              {t('settings.about.updateInstall')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </a>
          </div>
        );
      case 'error':
        return (
          <div className={styles['about-update']}>
            <span className={styles['about-update-error']}>{t('settings.about.updateError')}</span>
            {error && <span className={styles['about-update-error-detail']}>{error}</span>}
          </div>
        );
      case 'latest':
        return (
          <div className={styles['about-update']}>
            <span>{t('settings.about.updateLatest')}</span>
          </div>
        );
      case 'idle':
      default:
        return null;
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      <div className={styles['about-hero']}>
        <img
          className={`${styles['about-icon']} ${styles['about-icon-clickable']}`}
          src={iconUrl}
          alt="Lynn"
          onClick={handleIconTap}
        />
        <div className={styles['about-name']}>Lynn</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {version && <div className={styles['about-version']}>v{version}</div>}
        {renderUpdateStatus()}
        {(!autoUpdate || autoUpdate.status === 'idle' || autoUpdate.status === 'latest' || autoUpdate.status === 'error') && (
          <button className={styles['about-check-update-btn']} onClick={handleCheck}>
            {t('settings.about.updateCheckBtn')}
          </button>
        )}
      </div>

      <section className={styles['about-info']}>
        <div className={styles['about-row']}>
          <span className={styles['about-label']}>{t('settings.about.license')}</span>
          <span className={styles['about-value']}>Apache License 2.0</span>
        </div>
        <div className={styles['about-row']}>
          <span className={styles['about-label']}>{t('settings.about.description')}</span>
          <span className={styles['about-value']}>{t('settings.about.descriptionText')}</span>
        </div>
        <div className={styles['about-row']}>
          <span className={styles['about-label']}>{t('settings.about.copyright')}</span>
          <span className={styles['about-value']}>
            &copy; 2026 liliMozi{t('settings.about.copyrightOriginal')}
            <br />
            &copy; 2026 Merkyor{t('settings.about.copyrightDerived')}
          </span>
        </div>
        <div className={styles['about-row']}>
          <span className={styles['about-label']}>GitHub</span>
          <a
            className={`${styles['about-value']} ${styles['about-link']}`}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              hana?.openExternal?.('https://github.com/MerkyorLynn/Lynn');
            }}
          >
            github.com/MerkyorLynn
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
        <div className={styles['about-row']}>
          <span className={styles['about-label']}>{t('settings.about.betaUpdates')}</span>
          <Toggle on={isBeta} onChange={handleBetaToggle} />
        </div>
      </section>

      <button
        className={styles['about-license-toggle']}
        onClick={() => setLicenseOpen(!licenseOpen)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={licenseOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
        {t('settings.about.licenseToggle')}
      </button>

      {licenseOpen && (
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      )}

      {devUnlocked && (
        <section className={`${styles['settings-section']} ${styles['about-dev-section']}`}>
          <h2 className={styles['settings-section-title']}>{t('settings.about.permissions')}</h2>
          <div className={styles['tool-caps-group']}>
            <div className={styles['tool-caps-item']}>
              <div className={styles['tool-caps-label']}>
                <span className={styles['tool-caps-name']}>{t('settings.about.fullAccess')}</span>
                <span className={`${styles['tool-caps-desc']} ${styles['warn']}`}>
                  {t('settings.about.fullAccessDesc')}
                </span>
              </div>
              <Toggle
                on={!sandboxEnabled}
                onChange={async (on) => {
                  if (on) {
                    setShowFullAccessWarning(true);
                  } else {
                    await autoSaveConfig({ sandbox: true }, { silent: true });
                    await loadSettingsConfig();
                  }
                }}
              />
            </div>
          </div>
        </section>
      )}

      {showFullAccessWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowFullAccessWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">{t('settings.about.fullAccessWarningTitle')}</h3>
            <div className="hana-warning-body">
              <p>{t('settings.about.fullAccessWarningBody1')}</p>
              <p style={{ whiteSpace: 'pre-line' }}>
                {t('settings.about.fullAccessWarningBody2')}
              </p>
              <p>{t('settings.about.fullAccessWarningBody3')}</p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowFullAccessWarning(false)}>
                {t('settings.about.fullAccessCancel')}
              </button>
              <button className="hana-warning-confirm" onClick={async () => {
                setShowFullAccessWarning(false);
                await autoSaveConfig({ sandbox: false }, { silent: true });
                await loadSettingsConfig();
              }}>
                {t('settings.about.fullAccessConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi（原始版权）
Copyright 2026 Merkyor（二次开发）

基于 liliMozi 的开源项目开发
项目仓库：https://github.com/MerkyorLynn/Lynn

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;
