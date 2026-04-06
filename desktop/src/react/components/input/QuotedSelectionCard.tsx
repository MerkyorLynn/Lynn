import { useMemo } from 'react';
import { useStore } from '../../stores';
import { buildQuotedSelectionSummary } from '../../utils/composer-state';
import styles from './InputArea.module.css';

export function QuotedSelectionCard() {
  const quotedSelection = useStore(s => s.quotedSelection);
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);
  const updateQuotedSelection = useStore(s => s.updateQuotedSelection);

  const summary = useMemo(() => {
    if (!quotedSelection) return '';
    return buildQuotedSelectionSummary(quotedSelection);
  }, [quotedSelection]);

  if (!quotedSelection) return null;

  return (
    <div className={styles['quoted-selection-card']}>
      <div className={styles['quoted-selection-head']}>
        <div className={styles['quoted-selection-title']}>
          <GridIcon />
          <span>{quotedSelection.sourceTitle}</span>
        </div>
        <button className={styles['quoted-selection-remove']} onClick={clearQuotedSelection}>
          <CloseIcon />
        </button>
      </div>
      <div className={styles['quoted-selection-meta']}>{summary}</div>
      <textarea
        className={styles['quoted-selection-input']}
        rows={3}
        value={quotedSelection.text}
        onChange={(e) => updateQuotedSelection({ text: e.target.value, charCount: e.target.value.length })}
      />
    </div>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
