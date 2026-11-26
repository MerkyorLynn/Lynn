import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

interface DeepResearchPanelProps {
  busy: boolean;
  isStreaming: boolean;
  onClose: () => void;
  onFillTemplate: () => void;
  onStart: () => void;
}

export function DeepResearchPanel({
  busy,
  isStreaming,
  onClose,
  onFillTemplate,
  onStart,
}: DeepResearchPanelProps) {
  const { t } = useI18n();
  return (
    <div className={styles['deep-research-card']}>
      <div className={styles['deep-research-orb']} aria-hidden="true">
        <span />
      </div>
      <div className={styles['deep-research-copy']}>
        <strong>{t('input.deepResearch') || 'Deep research'}</strong>
        <span>
          {t('input.deepResearchDesc')
            || 'Great for long research, competitor reviews and report drafts. The result becomes an HTML report you can preview inside the chat.'}
        </span>
      </div>
      <div className={styles['deep-research-actions']}>
        <button
          type="button"
          className={styles['deep-research-example']}
          onClick={onFillTemplate}
        >
          {t('input.deepResearchFillTemplate') || 'Fill in the template'}
        </button>
        <button
          type="button"
          className={styles['deep-research-start']}
          onClick={onStart}
          disabled={busy || isStreaming}
        >
          {busy
            ? (t('input.deepResearchBusy') || 'Researching…')
            : (t('input.deepResearchStart') || 'Start research')}
        </button>
        <button
          type="button"
          className={styles['deep-research-close']}
          onClick={onClose}
          aria-label={t('input.deepResearchCloseHint') || 'Close the deep research guide'}
          title={t('common.close') || 'Close'}
        >
          ×
        </button>
      </div>
    </div>
  );
}
