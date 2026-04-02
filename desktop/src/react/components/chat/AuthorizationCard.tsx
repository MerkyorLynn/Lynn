/**
 * AuthorizationCard — 授权确认卡片
 *
 * 在授权模式下，当沙盒拦截到危险操作时显示。
 * 包含人类可读的说明 + 「以后都允许」checkbox。
 */

import { useState, memo, useCallback, useEffect } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import styles from './AuthorizationCard.module.css';


interface AuthorizationCardProps {
  confirmId: string;
  command: string;
  reason: string;
  description: string;
  category: string;
  identifier: string;
  status: 'pending' | 'confirmed' | 'rejected';
}

export const AuthorizationCard = memo(function AuthorizationCard({
  confirmId,
  command,
  reason,
  description,
  status: initialStatus,
}: AuthorizationCardProps) {
  const [status, setStatus] = useState(initialStatus);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const addToast = useStore(s => s.addToast);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const handleAllow = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value: { alwaysAllow } }),
      });
      setStatus('confirmed');
      addToast(window.t('security.auth.allowed'), 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`${window.t('settings.saveFailed') || 'Operation failed'}: ${msg}`, 'error');
    }
  }, [addToast, confirmId, alwaysAllow]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
      addToast(window.t('security.auth.rejected'), 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`${window.t('settings.saveFailed') || 'Operation failed'}: ${msg}`, 'error');
    }
  }, [addToast, confirmId]);

  // 已决定状态
  if (status !== 'pending') {
    return (
      <div className={`${styles.card} ${status === 'confirmed' ? styles.cardConfirmed : styles.cardRejected}`}>
        <div className={styles.header}>
          <span className={styles.headerIcon}>{status === 'confirmed' ? '✅' : '🚫'}</span>
          <span className={styles.headerText}>
            {status === 'confirmed' ? window.t('security.auth.allowed') : window.t('security.auth.rejected')}
          </span>
        </div>
        <div className={styles.commandLine}>
          <code className={styles.command}>{command}</code>
        </div>
      </div>
    );
  }

  // 等待用户决定
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>⚠️</span>
        <span className={styles.headerText}>{window.t('security.auth.title')}</span>
      </div>

      <div className={styles.body}>
        {/* 即将执行的命令 */}
        <div className={styles.commandLine}>
          <span className={styles.commandLabel}>{window.t('security.auth.commandLabel')}</span>
          <code className={styles.command}>{command}</code>
        </div>

        {/* 人类可读的说明 — 帮助小白用户理解这条操作用于什么 */}
        <div className={styles.description}>
          <span className={styles.descIcon}>💡</span>
          <span>{description || reason}</span>
        </div>

        {/* 拦截原因 */}
        <div className={styles.reason}>
          {reason}
        </div>

        {/* 以后都允许 checkbox */}
        <label className={styles.alwaysAllow}>
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
          />
          <span>{window.t('security.auth.alwaysAllow')}</span>
        </label>
      </div>

      <div className={styles.actions}>
        <button className={`${styles.btn} ${styles.btnReject}`} onClick={handleReject}>
          {window.t('security.auth.reject')}
        </button>
        <button className={`${styles.btn} ${styles.btnAllow}`} onClick={handleAllow}>
          {window.t('security.auth.allow')}
        </button>
      </div>
    </div>
  );
});
