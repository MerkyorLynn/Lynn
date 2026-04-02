/**
 * SecurityModeSelector — 安全模式下拉选择器
 *
 * 替代 PlanModeButton，在输入区底部工具栏展示三个模式。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import type { SecurityMode } from '../../stores/security-slice';
import styles from './SecurityModeSelector.module.css';

const MODES: Array<{
  value: SecurityMode;
  labelKey: string;
  descKey: string;
}> = [
  { value: 'authorized', labelKey: 'security.mode.authorized', descKey: 'security.mode.authorizedDesc' },
  { value: 'plan',       labelKey: 'security.mode.plan',       descKey: 'security.mode.planDesc' },
  { value: 'safe',       labelKey: 'security.mode.safe',       descKey: 'security.mode.safeDesc' },
];

export function SecurityModeSelector() {
  const { t } = useI18n();
  const securityMode = useStore(s => s.securityMode);
  const setSecurityMode = useStore(s => s.setSecurityMode);
  const addToast = useStore(s => s.addToast);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Listen for server-pushed security_mode events
  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent).detail?.mode;
      if (mode) setSecurityMode(mode);
    };
    window.addEventListener('hana-security-mode', handler);
    return () => window.removeEventListener('hana-security-mode', handler);
  }, [setSecurityMode]);

  // Load initial mode from server
  useEffect(() => {
    hanaFetch('/api/security-mode')
      .then(r => r.json())
      .then(d => { if (d.mode) setSecurityMode(d.mode); })
      .catch(() => {});
  }, [setSecurityMode]);

  const handleSelect = useCallback(async (mode: SecurityMode) => {
    setOpen(false);
    if (mode === securityMode) return;
    try {
      const res = await hanaFetch('/api/security-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (data.mode) {
        setSecurityMode(data.mode);
        addToast(t(`security.mode.${data.mode}`), 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`${t('settings.saveFailed') || 'Operation failed'}: ${msg}`, 'error');
      console.error('[security-mode] switch failed:', err);
    }
  }, [addToast, securityMode, setSecurityMode, t]);

  const current = MODES.find(m => m.value === securityMode) || MODES[0];

  return (
    <div className={`${styles.selector} ${open ? styles.open : ''}`} ref={ref}>
      <button
        type="button"
        className={`${styles.pill} ${styles[`pill-${securityMode}`]}`}
        onClick={() => setOpen(!open)}
        title={t(current.descKey)}
      >
        <span className={styles.pillLabel}>{t(current.labelKey)}</span>
        <span className={styles.pillArrow}>▾</span>
      </button>

      {open && (
        <div className={styles.dropdown}>
          {MODES.map(mode => (
            <button
              key={mode.value}
              type="button"
              className={`${styles.option} ${securityMode === mode.value ? styles.active : ''}`}
              onClick={() => handleSelect(mode.value)}
            >
              <div className={styles.optionText}>
                <span className={styles.optionLabel}>
                  {t(mode.labelKey)}
                  {securityMode === mode.value && <span className={styles.check}> ✓</span>}
                </span>
                <span className={styles.optionDesc}>{t(mode.descKey)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
