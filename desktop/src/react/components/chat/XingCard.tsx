/**
 * XingCard — 行省反思卡片
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import styles from './Chat.module.css';
import { injectCopyButtons } from '../../utils/format';
import { AsyncMarkdownContent } from './AsyncMarkdownContent';

interface Props {
  title: string;
  content: string;
  sealed: boolean;
  agentName?: string;
}

export const XingCard = memo(function XingCard({ title, content, sealed, agentName }: Props) {
  const t = window.t ?? ((p: string) => p);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) injectCopyButtons(bodyRef.current);
  }, [content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {}); // clipboard may reject without focus/permission — non-critical
  }, [content]);

  return (
    <div className={`${styles.xingCard}${sealed ? '' : ` ${styles.xingCardLoading}`}`}>
      <div className={styles.xingCardTitle}>{title}</div>
      <hr className={styles.xingCardDivider} />
      {sealed ? (
        <>
          <div ref={bodyRef}>
            <AsyncMarkdownContent markdown={content} className={styles.xingCardBody} stateKey={`xing:${title}`} />
          </div>
          <button className={styles.xingCardCopy} onClick={handleCopy}>{t('common.copy')}</button>
        </>
      ) : (
        <div className={styles.xingCardStatus}>
          {t('xing.thinking', { name: agentName || 'Lynn' })}
          <span className={styles.thinkingDots}><span /><span /><span /></span>
        </div>
      )}
    </div>
  );
});
