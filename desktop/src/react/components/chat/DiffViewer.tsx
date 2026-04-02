/**
 * DiffViewer — 轻量级 unified diff 内联展示
 *
 * 解析 unified diff 格式，渲染绿色增/红色删行。
 * 支持折叠/展开和 Accept/Reject 操作。
 */

import { memo, useState, useCallback, useMemo } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './DiffViewer.module.css';

interface Props {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  rollbackId?: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newLineNum: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', content: line.slice(1), oldLineNum: oldLine });
      oldLine++;
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', content: line.slice(1), oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }
  return result;
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

export const DiffViewer = memo(function DiffViewer({ filePath, diff, linesAdded, linesRemoved, rollbackId }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState<'pending' | 'accepted' | 'rejected'>('pending');
  const [isRejecting, setIsRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedLines = useMemo(() => parseDiff(diff), [diff]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const handleAccept = useCallback(() => {
    setError(null);
    setStatus('accepted');
  }, []);

  const handleReject = useCallback(async () => {
    if (!rollbackId || isRejecting) return;

    setIsRejecting(true);
    setError(null);
    try {
      await hanaFetch('/api/fs/revert-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollbackId }),
      });
      setStatus('rejected');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setIsRejecting(false);
    }
  }, [isRejecting, rollbackId]);

  const fileName = getFileName(filePath);
  const rejectDisabled = !rollbackId || isRejecting;

  return (
    <div className={`${styles.diffCard}${status !== 'pending' ? ` ${styles.diffCardResolved}` : ''}`}>
      <div className={styles.diffHeader} onClick={toggle}>
        <div className={styles.diffFileInfo}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className={styles.diffFileName}>{fileName}</span>
          <span className={styles.diffFilePath} title={filePath}>{filePath}</span>
        </div>
        <div className={styles.diffStats}>
          {linesAdded > 0 && <span className={styles.diffStatsAdded}>+{linesAdded}</span>}
          {linesRemoved > 0 && <span className={styles.diffStatsRemoved}>-{linesRemoved}</span>}
          <span className={styles.diffToggleArrow}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className={styles.diffBody}>
          <div className={styles.diffLines}>
            {parsedLines.map((line, i) => (
              <div
                key={i}
                className={`${styles.diffLine} ${styles[`diffLine${capitalize(line.type)}`]}`}
              >
                <span className={styles.diffLineNum}>
                  {line.type === 'header' ? '' : (line.oldLineNum ?? '')}
                </span>
                <span className={styles.diffLineNum}>
                  {line.type === 'header' ? '' : (line.newLineNum ?? '')}
                </span>
                <span className={styles.diffLinePrefix}>
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : line.type === 'header' ? '' : ' '}
                </span>
                <span className={styles.diffLineContent}>{line.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {status === 'pending' && (
        <div className={styles.diffActions}>
          <button className={styles.diffAcceptBtn} onClick={handleAccept} title="Accept changes">
            ✓ Accept
          </button>
          <button
            className={styles.diffRejectBtn}
            onClick={handleReject}
            title={rollbackId ? 'Reject changes and restore original file' : 'Rollback unavailable'}
            disabled={rejectDisabled}
          >
            {isRejecting ? '… Reverting' : '✗ Reject'}
          </button>
        </div>
      )}
      {status !== 'pending' && (
        <div className={`${styles.diffStatusBar} ${status === 'accepted' ? styles.diffStatusAccepted : styles.diffStatusRejected}`}>
          {status === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
        </div>
      )}
      {error && <div className={styles.diffError}>{error}</div>}
    </div>
  );
});

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
