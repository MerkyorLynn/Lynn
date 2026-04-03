/**
 * AuthorizationCard — 授权确认卡片
 *
 * 在授权模式下，当沙盒拦截到危险操作时显示。
 * 提供一次性、会话级、持久化（当前 trusted root）三层授权。
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import styles from './AuthorizationCard.module.css';


type AuthorizationStatus = 'pending' | 'confirmed' | 'rejected';
type AuthorizationAction = 'confirmed_once' | 'confirmed_session' | 'confirmed_persistent' | 'rejected';

interface AuthorizationCardProps {
  confirmId: string;
  command: string;
  reason: string;
  description: string;
  category: string;
  identifier: string;
  trustedRoot?: string | null;
  status: AuthorizationStatus;
}

function shortPath(p?: string | null): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `.../${parts.slice(-3).join('/')}`;
}

function statusText(status: AuthorizationStatus): string {
  if (status === 'confirmed') return window.t('security.auth.allowed');
  if (status === 'rejected') return window.t('security.auth.rejected');
  return window.t('security.auth.title');
}

function sendAction(confirmId: string, action: AuthorizationAction) {
  return hanaFetch(`/api/confirm/${confirmId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

export const AuthorizationCard = memo(function AuthorizationCard({
  confirmId,
  command,
  reason,
  description,
  trustedRoot,
  status: initialStatus,
}: AuthorizationCardProps) {
  const [status, setStatus] = useState<AuthorizationStatus>(initialStatus);
  const [submitting, setSubmitting] = useState(false);
  const addToast = useStore((s) => s.addToast);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const decide = useCallback(async (action: AuthorizationAction) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await sendAction(confirmId, action);
      const nextStatus: AuthorizationStatus = action === 'rejected' ? 'rejected' : 'confirmed';
      setStatus(nextStatus);
      if (nextStatus === 'confirmed') {
        addToast(window.t('security.auth.allowed'), 'success');
      } else {
        addToast(window.t('security.auth.rejected'), 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`${window.t('settings.saveFailed') || 'Operation failed'}: ${msg}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }, [addToast, confirmId, submitting]);

  const handleAllowOnce = useCallback(() => decide('confirmed_once'), [decide]);
  const handleAllowSession = useCallback(() => decide('confirmed_session'), [decide]);
  const handleAllowPersistent = useCallback(() => decide('confirmed_persistent'), [decide]);
  const handleReject = useCallback(() => decide('rejected'), [decide]);

  const trustedRootLabel = trustedRoot ? shortPath(trustedRoot) : '';

  if (status !== 'pending') {
    return (
      <div className={`${styles.card} ${status === 'confirmed' ? styles.cardConfirmed : styles.cardRejected}`}>
        <div className={styles.header}>
          <span className={styles.headerText}>{statusText(status)}</span>
          <span className={styles.statusBadge}>{status === 'confirmed' ? window.t('security.auth.allow') : window.t('security.auth.reject')}</span>
        </div>
        <pre className={styles.commandBlock}><code>{command}</code></pre>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerText}>{window.t('security.auth.title')}</span>
        <span className={styles.scopeTag}>Terminal</span>
      </div>

      <pre className={styles.commandBlock}><code>{command}</code></pre>

      <p className={styles.description}>{description || reason}</p>
      <p className={styles.reason}>{reason}</p>

      {trustedRootLabel && (
        <p className={styles.rootHint} title={trustedRoot || ''}>
          {window.t('security.auth.trustedRoot')}: {trustedRootLabel}
        </p>
      )}

      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={handleReject}
          disabled={submitting}
        >
          {window.t('security.auth.reject')}
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleAllowSession}
          disabled={submitting}
          title={window.t('security.auth.allowSession')}
        >
          {window.t('security.auth.allowSession')}
        </button>
        <button
          className={`${styles.btn} ${styles.btnSecondary}`}
          onClick={handleAllowPersistent}
          disabled={submitting}
          title={window.t('security.auth.allowAlwaysHere')}
        >
          {window.t('security.auth.allowAlwaysHere')}
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleAllowOnce}
          disabled={submitting}
        >
          {window.t('security.auth.allowOnce')}
        </button>
      </div>
    </div>
  );
});
