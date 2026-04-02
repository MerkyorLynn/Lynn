/**
 * ReviewCard — 按需 Review 结果卡片
 *
 * 展示另一个 Agent 的 review 结果。
 * 状态：loading（等待结果）、done（结果已到达）。
 */

import { memo } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { renderMarkdown } from '../../utils/markdown';
import styles from './Chat.module.css';

interface Props {
  reviewId: string;
  reviewerName: string;
  content: string;
  error?: string;
  status: 'loading' | 'done';
}

export const ReviewCard = memo(function ReviewCard({ reviewerName, content, error, status }: Props) {
  const t = window.t ?? ((key: string) => key);

  return (
    <div className={styles.reviewCard}>
      <div className={styles.reviewCardHeader}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className={styles.reviewCardTitle}>
          {t('review.cardTitle') || 'Review'} · {reviewerName}
        </span>
        {status === 'loading' && (
          <span className={styles.reviewCardLoading}>
            <span className={styles.thinkingDots}><span /><span /><span /></span>
          </span>
        )}
      </div>
      {status === 'done' && (
        <div className={styles.reviewCardBody}>
          {error ? (
            <div className={styles.reviewCardError}>{error}</div>
          ) : (
            <MarkdownContent html={renderMarkdown(content)} />
          )}
        </div>
      )}
    </div>
  );
});
