/**
 * WritingDiffViewer — 写作修订视图（类似 Word Track Changes）
 *
 * 对 .md/.txt 文件的 diff 用散文友好的方式渲染：
 * - 词级高亮（绿色新增 / 红色删除线）
 * - 逐段 accept/reject
 * - 完成审阅后一次性写入最终内容
 */

import { memo, useState, useCallback, useMemo, useRef } from 'react';
import type React from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import {
  reconstructFromUnifiedDiff,
  splitParagraphs,
  alignParagraphs,
  computeWordDiff,
  applyReviewToFullContent,
  type ParagraphPair,
  type WordChange,
} from '../../utils/diff-utils';
import styles from './WritingDiffViewer.module.css';

interface Props {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  rollbackId?: string;
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

// ── 词级渲染 ──

function WordDiffSpans({ changes }: { changes: WordChange[] }) {
  return (
    <>
      {changes.map((c, i) => {
        if (c.added) return <span key={i} className={styles.wordAdded}>{c.value}</span>;
        if (c.removed) return <span key={i} className={styles.wordRemoved}>{c.value}</span>;
        return <span key={i}>{c.value}</span>;
      })}
    </>
  );
}

// ── 段落渲染 ──

function ParagraphBlock({
  pair,
  decision,
  editedText,
  onDecide,
  onEdit,
  disabled,
  isZh,
}: {
  pair: ParagraphPair;
  decision?: 'accept' | 'reject';
  editedText?: string;
  onDecide: (index: number, d: 'accept' | 'reject') => void;
  onEdit: (index: number, text: string | null) => void;
  disabled: boolean;
  isZh: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // [2026-04-17] IME 组合追踪：输入中文时不要触发 autoResize（避免 textarea 高度抖动导致 IME 候选框飞到屏幕左下角）
  const isComposing = useRef(false);

  const wordChanges = useMemo(() => {
    if (pair.type === 'modified' && pair.oldText && pair.newText) {
      return computeWordDiff(pair.oldText, pair.newText);
    }
    return null;
  }, [pair]);

  const typeClass =
    pair.type === 'unchanged' ? styles.paragraphUnchanged
    : pair.type === 'modified' ? styles.paragraphModified
    : pair.type === 'added' ? styles.paragraphAdded
    : styles.paragraphRemoved;

  const decisionClass =
    editedText !== undefined ? styles.paragraphEdited
    : decision === 'accept' ? styles.paragraphAccepted
    : decision === 'reject' ? styles.paragraphRejected
    : '';

  const showActions = pair.type !== 'unchanged';

  const handleStartEdit = useCallback(() => {
    // 进入编辑模式时，默认给用户看"期望的新文本"（改动段用 newText，删除段用 oldText）
    const initial = editedText !== undefined
      ? editedText
      : pair.type === 'removed'
        ? (pair.oldText || '')
        : (pair.newText || '');
    setDraft(initial);
    setEditing(true);
    setTimeout(() => {
      textareaRef.current?.focus();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
      }
    }, 0);
  }, [editedText, pair]);

  const handleSaveEdit = useCallback(() => {
    onEdit(pair.index, draft);
    setEditing(false);
  }, [draft, onEdit, pair.index]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleRevertEdit = useCallback(() => {
    onEdit(pair.index, null);
    setEditing(false);
  }, [onEdit, pair.index]);

  const autoResize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // 只在 IME 非组合态 resize，否则会干扰候选窗定位
    if (!isComposing.current) {
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
    }
    setDraft(e.target.value);
  };

  const handleCompositionStart = () => { isComposing.current = true; };
  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposing.current = false;
    // 组合结束后补一次 resize
    const t = e.target as HTMLTextAreaElement;
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
  };

  return (
    <div className={`${styles.paragraph} ${typeClass} ${decisionClass}`}>
      {editing ? (
        <div className={styles.editorWrap}>
          <textarea
            ref={textareaRef}
            className={styles.editorTextarea}
            value={draft}
            onChange={autoResize}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={(e) => {
              // IME 组合中忽略快捷键（否则会打断中文输入）
              if (isComposing.current) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSaveEdit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelEdit();
              }
            }}
          />
          <div className={styles.editorActions}>
            <span className={styles.editorHint}>
              {isZh ? '⌘+Enter 保存 · Esc 取消' : '⌘+Enter save · Esc cancel'}
            </span>
            <button type="button" className={styles.paraRejectBtn} onClick={handleCancelEdit}>
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button type="button" className={styles.paraAcceptBtn} onClick={handleSaveEdit}>
              {isZh ? '保存修改' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 段落内容 */}
          {editedText !== undefined ? (
            <span className={styles.editedPreview}>
              <span className={styles.editedTag}>{isZh ? '✎ 已手改' : '✎ Edited'}</span>
              {editedText}
            </span>
          ) : (
            <>
              {pair.type === 'unchanged' && <span>{pair.newText}</span>}
              {pair.type === 'modified' && wordChanges && <WordDiffSpans changes={wordChanges} />}
              {pair.type === 'added' && <span className={styles.wordAdded}>{pair.newText}</span>}
              {pair.type === 'removed' && <span className={styles.wordRemoved}>{pair.oldText}</span>}
            </>
          )}

          {/* 操作按钮 */}
          {showActions && (
            <div className={styles.paragraphActions}>
              <button
                className={styles.paraEditBtn}
                onClick={handleStartEdit}
                disabled={disabled}
                title={isZh ? '自行修改此段（在 AI 建议基础上微调）' : 'Edit this paragraph manually'}
              >
                ✎
              </button>
              {editedText !== undefined && (
                <button
                  className={styles.paraRejectBtn}
                  onClick={handleRevertEdit}
                  disabled={disabled}
                  title={isZh ? '撤销手改，恢复 AI 版本' : 'Revert edit'}
                >
                  ↺
                </button>
              )}
              <button
                className={styles.paraAcceptBtn}
                onClick={() => onDecide(pair.index, 'accept')}
                disabled={disabled || decision === 'accept' || editedText !== undefined}
                title={isZh ? '接受此段 AI 修改' : 'Accept AI change'}
              >
                ✓
              </button>
              <button
                className={styles.paraRejectBtn}
                onClick={() => onDecide(pair.index, 'reject')}
                disabled={disabled || decision === 'reject' || editedText !== undefined}
                title={isZh ? '拒绝此段，保留原文' : 'Reject, keep original'}
              >
                ✗
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 主组件 ──

export const WritingDiffViewer = memo(function WritingDiffViewer({
  filePath,
  diff,
  linesAdded,
  linesRemoved,
  rollbackId,
}: Props) {
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');
  const [expanded, setExpanded] = useState(true);
  const [decisions, setDecisions] = useState<Map<number, 'accept' | 'reject'>>(new Map());
  const [edits, setEdits] = useState<Map<number, string>>(new Map());
  const [status, setStatus] = useState<'reviewing' | 'accepted' | 'rejected' | 'partial'>('reviewing');
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 解析 diff → 段落对
  const pairs = useMemo(() => {
    const { oldText, newText } = reconstructFromUnifiedDiff(diff);
    const oldParas = splitParagraphs(oldText);
    const newParas = splitParagraphs(newText);
    return alignParagraphs(oldParas, newParas);
  }, [diff]);

  const changedPairs = useMemo(() => pairs.filter(p => p.type !== 'unchanged'), [pairs]);
  const decidedCount = useMemo(() => {
    let count = 0;
    for (const p of changedPairs) {
      if (decisions.has(p.index)) count++;
    }
    return count;
  }, [changedPairs, decisions]);

  const toggle = useCallback(() => setExpanded(v => !v), []);

  const handleDecide = useCallback((index: number, d: 'accept' | 'reject') => {
    setDecisions(prev => {
      const next = new Map(prev);
      next.set(index, d);
      return next;
    });
  }, []);

  const handleEdit = useCallback((index: number, text: string | null) => {
    setEdits(prev => {
      const next = new Map(prev);
      if (text === null) {
        next.delete(index);
      } else {
        next.set(index, text);
      }
      return next;
    });
    // 手改即视为接受该段，便于 decidedCount 统计
    if (text !== null) {
      setDecisions(prev => {
        const next = new Map(prev);
        next.set(index, 'accept');
        return next;
      });
    }
  }, []);

  // 全部接受
  const handleAcceptAll = useCallback(() => {
    setError(null);
    setStatus('accepted');
  }, []);

  // 全部拒绝
  const handleRejectAll = useCallback(async () => {
    if (!rollbackId || isApplying) return;
    setIsApplying(true);
    setError(null);
    try {
      await hanaFetch('/api/fs/revert-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollbackId }),
      });
      setStatus('rejected');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      const cleaned = raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
      setError(cleaned || (isZh ? '回滚失败' : 'Rollback failed'));
    } finally {
      setIsApplying(false);
    }
  }, [rollbackId, isApplying, isZh]);

  // 完成审阅 — 部分 accept/reject/edit
  const handleFinish = useCallback(async () => {
    if (isApplying) return;

    const hasEdits = edits.size > 0;

    // 所有变化接受 + 没手改 → 直接标完成
    const allAccepted = !hasEdits && changedPairs.every(p => decisions.get(p.index) !== 'reject');
    if (allAccepted) {
      setStatus('accepted');
      return;
    }

    // 所有变化拒绝 + 没手改 → 走全量回滚
    const allRejected = !hasEdits && changedPairs.every(p => decisions.get(p.index) === 'reject');
    if (allRejected) {
      await handleRejectAll();
      return;
    }

    // 部分 accept/reject/edit — 基于完整当前文件安全应用，避免 diff hunk 截断整文
    setIsApplying(true);
    setError(null);
    try {
      const readRes = await hanaFetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      const currentContent = await readRes.text();
      const finalContent = applyReviewToFullContent(currentContent, pairs, decisions, edits);
      await hanaFetch('/api/fs/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content: finalContent }),
      });
      setStatus('partial');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      const cleaned = raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
      setError(cleaned || (isZh ? '写入失败' : 'Write failed'));
    } finally {
      setIsApplying(false);
    }
  }, [isApplying, changedPairs, decisions, edits, pairs, filePath, handleRejectAll, isZh]);

  const fileName = getFileName(filePath);
  const isDone = status !== 'reviewing';

  return (
    <div className={`${styles.card}${isDone ? ` ${styles.cardResolved}` : ''}`}>
      {/* 头部 */}
      <div className={styles.header} onClick={toggle}>
        <div className={styles.fileInfo}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className={styles.fileName}>{fileName}</span>
          <span className={styles.badge}>{isZh ? '修订' : 'Review'}</span>
          <span className={styles.filePath} title={filePath}>{filePath}</span>
        </div>
        <div className={styles.stats}>
          {linesAdded > 0 && <span className={styles.statsAdded}>+{linesAdded}</span>}
          {linesRemoved > 0 && <span className={styles.statsRemoved}>-{linesRemoved}</span>}
          <span className={styles.toggleArrow}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* 正文 */}
      {expanded && (
        <div className={styles.body}>
          {pairs.map(pair => (
            <ParagraphBlock
              key={pair.index}
              pair={pair}
              decision={decisions.get(pair.index)}
              editedText={edits.get(pair.index)}
              onDecide={handleDecide}
              onEdit={handleEdit}
              disabled={isDone}
              isZh={isZh}
            />
          ))}
        </div>
      )}

      {/* 操作栏 */}
      {!isDone && (
        <div className={styles.actions}>
          <button
            className={styles.acceptAllBtn}
            onClick={handleAcceptAll}
            title={isZh ? '接受所有改动' : 'Accept all changes'}
          >
            {isZh ? '✓ 全部接受' : '✓ Accept All'}
          </button>
          <button
            className={styles.rejectAllBtn}
            onClick={handleRejectAll}
            disabled={!rollbackId || isApplying}
            title={rollbackId
              ? (isZh ? '拒绝所有改动并恢复原文' : 'Reject all and restore original')
              : (isZh ? '无法回滚' : 'Rollback unavailable')}
          >
            {isApplying
              ? (isZh ? '… 回滚中' : '… Reverting')
              : (isZh ? '✗ 全部拒绝' : '✗ Reject All')}
          </button>
          {changedPairs.length > 0 && (
            <span className={styles.progress}>
              {decidedCount}/{changedPairs.length}
            </span>
          )}
          {decidedCount > 0 && (
            <button
              className={styles.finishBtn}
              onClick={handleFinish}
              disabled={isApplying}
              title={isZh ? '应用审阅结果' : 'Apply review decisions'}
            >
              {isApplying
                ? (isZh ? '… 应用中' : '… Applying')
                : (isZh ? '完成审阅' : 'Finish Review')}
            </button>
          )}
        </div>
      )}

      {/* 状态栏 */}
      {isDone && (
        <div className={`${styles.statusBar} ${
          status === 'accepted' ? styles.statusAccepted
          : status === 'rejected' ? styles.statusRejected
          : styles.statusPartial
        }`}>
          {status === 'accepted'
            ? (isZh ? '✓ 已接受所有改动' : '✓ All changes accepted')
            : status === 'rejected'
            ? (isZh ? '✗ 已拒绝所有改动' : '✗ All changes rejected')
            : (isZh ? '✓ 审阅完成，已应用部分改动' : '✓ Review complete, partial changes applied')}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
});
