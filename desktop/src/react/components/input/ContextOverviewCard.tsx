import { useMemo } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export interface ContextOverviewCardProps {
  mode: 'prompt' | 'steer';
  modelLabel?: string | null;
  textLength: number;
  quotedSummary?: string | null;
  docName?: string | null;
  attachmentNames?: string[];
  imageNames?: string[];
  gitSummary?: string | null;
  heldBackLabels?: string[];
}

export function ContextOverviewCard({
  mode,
  modelLabel,
  textLength,
  quotedSummary,
  docName,
  attachmentNames = [],
  imageNames = [],
  gitSummary,
  heldBackLabels = [],
}: ContextOverviewCardProps) {
  const { t } = useI18n();

  const rows = useMemo(() => {
    const nextRows: Array<{ label: string; value: string }> = [
      {
        label: t('input.contextMode'),
        value: mode === 'steer' ? t('input.modeSteer') : t('input.modeSend'),
      },
      {
        label: t('input.contextText'),
        value: t('input.contextTextValue', { count: textLength }),
      },
    ];

    if (modelLabel) {
      nextRows.push({ label: t('input.contextModel'), value: modelLabel });
    }
    if (quotedSummary) {
      nextRows.push({ label: t('input.contextQuote'), value: quotedSummary });
    }
    if (docName) {
      nextRows.push({ label: t('input.contextDoc'), value: docName });
    }
    if (attachmentNames.length > 0) {
      nextRows.push({
        label: t('input.contextFiles'),
        value: summarizeNames(attachmentNames),
      });
    }
    if (imageNames.length > 0) {
      nextRows.push({
        label: t('input.contextImages'),
        value: summarizeNames(imageNames),
      });
    }
    if (gitSummary) {
      nextRows.push({
        label: t('input.contextGit'),
        value: gitSummary,
      });
    }

    return nextRows;
  }, [attachmentNames, docName, gitSummary, imageNames, mode, modelLabel, quotedSummary, t, textLength]);

  if (rows.length === 0 && heldBackLabels.length === 0) return null;

  return (
    <div className={styles['context-overview-card']}>
      <div className={styles['context-overview-head']}>
        <div>
          <div className={styles['context-overview-title']}>{t('input.contextOverview')}</div>
          <div className={styles['context-overview-subtitle']}>{t('input.contextOverviewSubtitle')}</div>
        </div>
      </div>

      <div className={styles['context-overview-grid']}>
        {rows.map((row) => (
          <div key={`${row.label}-${row.value}`} className={styles['context-overview-item']}>
            <span className={styles['context-overview-label']}>{row.label}</span>
            <span className={styles['context-overview-value']} title={row.value}>{row.value}</span>
          </div>
        ))}
      </div>

      {heldBackLabels.length > 0 && (
        <div className={styles['context-overview-heldback']}>
          <span className={styles['context-overview-heldback-label']}>{t('input.contextHeldBack')}</span>
          <span>{heldBackLabels.join('、')}</span>
        </div>
      )}
    </div>
  );
}

function summarizeNames(names: string[]): string {
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} +${names.length - 2}`;
}
