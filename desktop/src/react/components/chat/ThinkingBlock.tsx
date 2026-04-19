/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const t = window.t ?? ((p: string) => p);
  // [PROGRESS-UX v2] DeepSeek-R1 style:
  //   - During streaming (sealed=false): expanded so user reads along
  //   - After thinking completes (sealed=true): auto-collapse to surface answer
  //   - User manual toggle overrides auto behavior (explicitOpen is sticky once set)
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null);
  const open = explicitOpen !== null ? explicitOpen : !sealed;
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const toggle = useCallback(() => setExplicitOpen(v => !(v !== null ? v : !sealed)), [sealed]);

  useEffect(() => {
    if (sealed) return;
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [sealed]);

  const elapsedLabel = !sealed && elapsed >= 2000 ? ` (${formatElapsed(elapsed)})` : '';

  return (
    <details className={styles.thinkingBlock} open={open} onToggle={(e) => setExplicitOpen((e.target as HTMLDetailsElement).open)}>
      <summary className={styles.thinkingBlockSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        <span className={styles.thinkingBlockLabel}>
          {sealed ? t('thinking.done') : t('thinking.active')}
          {elapsedLabel}
        </span>
        {!sealed && <span className={styles.thinkingDots}><span /><span /><span /></span>}
      </summary>
      {open && content && (
        <div className={styles.thinkingBlockBody}>{content}</div>
      )}
    </details>
  );
});
