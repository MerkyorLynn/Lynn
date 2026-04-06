/**
 * AuthorizationCard — 授权确认卡片
 *
 * 在执行模式下，当受保护操作需要确认时显示。
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

function deriveScopeLabel(category: string, command: string): string {
  if (category.startsWith('path_write')) return window.t('security.auth.fileWrite') || 'File Write';
  if (category.startsWith('path_read')) return window.t('security.auth.fileRead') || 'File Read';
  if (category.startsWith('path_')) return window.t('security.auth.fileOp') || 'File Access';
  if (/\b(bash|chmod|chown|rm|mv|cp|git|npm|pnpm|yarn)\b/i.test(command)) {
    return window.t('security.auth.terminal') || 'Terminal';
  }
  return window.t('security.auth.scope') || 'Action';
}

function decisionHints(trustedRootLabel: string) {
  const projectLabel = trustedRootLabel || (window.t('security.auth.currentProject') || 'current project');
  return [
    window.t('security.auth.allowOnceHint') || 'Only allow this single action.',
    window.t('security.auth.allowSessionHint') || 'Allow similar actions for the rest of this task/session.',
    (window.t('security.auth.allowAlwaysHereHint') || 'Always allow similar actions inside {project}.')
      .replace('{project}', projectLabel),
  ];
}

function buildSummary(scopeLabel: string, trustedRootLabel: string): string {
  const projectLabel = trustedRootLabel || (window.t('security.auth.currentProject') || 'current project');
  return (window.t('security.auth.summary') || 'Lynn wants to perform a {scope} action in {project}. Choose how much to allow.')
    .replace('{scope}', scopeLabel)
    .replace('{project}', projectLabel);
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
  category,
  trustedRoot,
  status: initialStatus,
}: AuthorizationCardProps) {
  const [status, setStatus] = useState<AuthorizationStatus>(initialStatus);
  const [submitting, setSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const scopeLabel = deriveScopeLabel(category, command);
  const [onceHint, sessionHint, persistentHint] = decisionHints(trustedRootLabel);
  const summary = buildSummary(scopeLabel, trustedRootLabel);
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
        <span className={styles.scopeTag}>{scopeLabel}</span>
      </div>

      <p className={styles.summary}>{summary}</p>
      <p className={styles.description}>{description || reason}</p>
      {reason && description && reason !== description ? (
        <p className={styles.reason}>
          <span className={styles.reasonLabel}>{window.t('security.auth.reasonLabel') || 'Reason'}</span>
          {reason}
        </p>
      ) : null}

      <div className={styles.commandWrap}>
        <div className={styles.commandLabel}>{window.t('security.auth.commandLabel') || 'About to execute:'}</div>
        <pre className={styles.commandBlock}><code>{command}</code></pre>
      </div>

      {trustedRootLabel && (
        <p className={styles.rootHint} title={trustedRoot || ''}>
          {window.t('security.auth.trustedRoot')}: {trustedRootLabel}
        </p>
      )}

      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={handleAllowSession}
          disabled={submitting}
          title={sessionHint}
        >
          {window.t('security.auth.allowSession')}
        </button>
        <button
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={handleReject}
          disabled={submitting}
        >
          {window.t('security.auth.reject')}
        </button>
        <button
          className={`${styles.btn} ${styles.btnLink}`}
          onClick={() => setShowAdvanced(!showAdvanced)}
          type="button"
          style={{ fontSize: '0.68rem', opacity: 0.6 }}
        >
          {showAdvanced ? '▴' : '▾'} {(() => { const v = window.t('security.auth.moreOptions'); return (v && v !== 'security.auth.moreOptions') ? v : 'More options'; })()}
        </button>
      </div>

      {showAdvanced && (
        <div className={styles.actions} style={{ marginTop: 4 }}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={handleAllowOnce}
            disabled={submitting}
            title={onceHint}
          >
            {window.t('security.auth.allowOnce')}
          </button>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={handleAllowPersistent}
            disabled={submitting}
            title={persistentHint}
          >
            {window.t('security.auth.allowAlwaysHere')}
          </button>
        </div>
      )}

      <div className={styles.decisionGuide}>
        <span className={styles.decisionItem}>{sessionHint}</span>
      </div>
    </div>
  );
});
