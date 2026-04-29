import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function SendButton({ isStreaming, canSteer, disabled, title, onSend, onSteer, onStop }: {
  isStreaming: boolean;
  canSteer: boolean;
  disabled: boolean;
  title?: string;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const zh = String(document?.documentElement?.lang || '').startsWith('zh');

  // 三态：send | steer+stop | stop
  if (!isStreaming) {
    return (
      <button
        className={styles['send-btn']}
        disabled={disabled}
        title={title}
        onClick={onSend}
      >
        <span className={styles['send-label']}>
          <svg className={styles['send-enter-icon']} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
        </span>
      </button>
    );
  }

  // streaming 中
  return (
    <div className={styles['send-btn-group']}>
      {canSteer && (
        <button
          className={styles['steer-btn']}
          onClick={onSteer}
          title={zh ? '加入对话（不会中断当前任务）' : 'Join conversation (won\'t interrupt current task)'}
        >
          <span className={styles['send-label']}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
            </svg>
            <span>{zh ? '加入对话' : 'Join'}</span>
          </span>
          <span className={styles['steer-hint']}>{zh ? '不中断任务' : 'won\'t stop task'}</span>
        </button>
      )}
      <button
        className={`${styles['send-btn']} ${styles['is-streaming']}`}
        onClick={onStop}
      >
        <span className={styles['send-label']}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span>{t('chat.stop')}</span>
        </span>
      </button>
    </div>
  );
}
