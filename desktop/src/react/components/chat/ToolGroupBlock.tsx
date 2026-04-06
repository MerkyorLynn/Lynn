/**
 * ToolGroupBlock — 工具调用组，含展开/折叠、丰富信息卡片、计时
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import styles from './Chat.module.css';
import { extractToolDetail } from '../../utils/message-parser';
import { useStore } from '../../stores';
import type { ToolCall, ToolCallSummary } from '../../stores/chat-types';

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

function getToolLabel(name: string, phase: string): string {
  const t = window.t;
  const agentName = useStore.getState().agentName || 'Lynn';
  const vars = { name: agentName };
  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;
  return t?.(`tool._fallback.${phase}`, vars) || name;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, collapsed: initialCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  const allDone = tools.every(t => t.done);
  const failCount = tools.filter(t => t.done && !t.success).length;
  const running = tools.filter(t => !t.done).length;
  const isSingle = tools.length === 1;

  // 摘要标题
  const _t = window.t ?? ((p: string) => p);
  let summaryText = '';
  if (allDone) {
    if (failCount > 0) {
      summaryText = _t('toolGroup.countWithFail', { total: tools.length, fail: failCount });
    } else {
      summaryText = _t('toolGroup.count', { n: tools.length });
    }
  } else {
    summaryText = _t('toolGroup.running', { n: running });
  }

  return (
    <div className={`${styles.toolGroup}${isSingle ? ` ${styles.toolGroupSingle}` : ''}`}>
      {!isSingle && (
        <div
          className={`${styles.toolGroupSummary}${allDone ? ` ${styles.toolGroupSummaryClickable}` : ''}`}
          onClick={allDone ? toggle : undefined}
        >
          <span className={styles.toolGroupTitle}>{summaryText}</span>
          {!allDone && <span className={styles.toolGroupCount}>{running}/{tools.length}</span>}
          {allDone && <span className={styles.toolGroupArrow}>{collapsed ? '›' : '‹'}</span>}
          {!allDone && (
            <span className={styles.toolDots}><span /><span /><span /></span>
          )}
        </div>
      )}
      <div className={`${styles.toolGroupContent}${collapsed && !isSingle ? ` ${styles.toolGroupContentCollapsed}` : ''}`}>
        {tools.map((tool, i) => (
          <ToolIndicator key={`${tool.name}-${i}`} tool={tool} />
        ))}
      </div>
    </div>
  );
});

// ── Elapsed timer hook ──

function useElapsedTime(startedAt: number | undefined, done: boolean): string {
  const [elapsed, setElapsed] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (done || !startedAt) {
      if (timerRef.current) clearInterval(timerRef.current);
      // Show final elapsed if done and startedAt exists
      if (done && startedAt) {
        const ms = Date.now() - startedAt;
        setElapsed(formatMs(ms));
      }
      return;
    }

    const update = () => {
      const ms = Date.now() - startedAt;
      setElapsed(formatMs(ms));
    };
    update();
    timerRef.current = setInterval(update, 100);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startedAt, done]);

  return elapsed;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({ tool }: { tool: ToolCall }) {
  const detail = extractToolDetail(tool.name, tool.args);
  const label = getToolLabel(tool.name, tool.done ? 'done' : 'running');
  const elapsed = useElapsedTime(tool.startedAt, tool.done);
  const [outputExpanded, setOutputExpanded] = useState(false);

  // 有命令/路径时只展示事实行，避免每步重复「用你的电脑」类叙事（对齐 Cursor 工具条）
  const primary = detail?.trim() ? detail : label;

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  // 是否有可展示的输出预览
  const hasOutput = tool.done && tool.summary?.outputPreview;

  return (
    <div className={styles.toolIndicatorWrap}>
      <div className={styles.toolIndicator} data-tool={tool.name} data-done={String(tool.done)}
        onClick={hasOutput ? () => setOutputExpanded(v => !v) : undefined}
        style={hasOutput ? { cursor: 'pointer' } : undefined}
      >
        <span className={`${styles.toolDesc}${detail?.trim() ? ` ${styles.toolDescMono}` : ''}`}>{primary}</span>
        {tag && <span className={styles.toolTag}>{tag}</span>}
        {elapsed && <span className={styles.toolElapsed}>{elapsed}</span>}
        {tool.done ? (
          <span className={`${styles.toolStatus} ${tool.success ? styles.toolStatusDone : styles.toolStatusFailed}`}>
            {tool.success ? '✓' : '✗'}
          </span>
        ) : (
          <span className={styles.toolDots}><span /><span /><span /></span>
        )}
        {tool.done && tool.summary && <ToolSummaryInfo name={tool.name} summary={tool.summary} />}
        {hasOutput && <span className={styles.toolOutputToggle}>{outputExpanded ? '▾' : '▸'}</span>}
      </div>
      {outputExpanded && hasOutput && (
        <ToolOutputPreview name={tool.name} summary={tool.summary!} />
      )}
    </div>
  );
});

// ── ToolSummaryInfo — 工具完成后的丰富信息 ──

const ToolSummaryInfo = memo(function ToolSummaryInfo({ name, summary }: { name: string; summary: ToolCallSummary }) {
  if (name === 'edit' || name === 'edit-diff') {
    if (summary.linesAdded == null && summary.linesRemoved == null) return null;
    return (
      <span className={styles.toolSummaryBadge}>
        {summary.linesAdded != null && summary.linesAdded > 0 && (
          <span className={styles.toolSummaryAdded}>+{summary.linesAdded}</span>
        )}
        {summary.linesRemoved != null && summary.linesRemoved > 0 && (
          <span className={styles.toolSummaryRemoved}>-{summary.linesRemoved}</span>
        )}
      </span>
    );
  }

  if (name === 'write') {
    if (!summary.bytesWritten) return null;
    const kb = (summary.bytesWritten / 1024).toFixed(1);
    return (
      <span className={styles.toolSummaryBadge}>
        <span className={styles.toolSummaryMeta}>{kb}KB</span>
      </span>
    );
  }

  if (name === 'bash') {
    if (summary.truncated) {
      return (
        <span className={styles.toolSummaryBadge}>
          <span className={styles.toolSummaryMeta}>{summary.totalLines} lines (truncated)</span>
        </span>
      );
    }
    return null;
  }

  if (name === 'grep' || name === 'glob' || name === 'find') {
    if (!summary.matchCount) return null;
    return (
      <span className={styles.toolSummaryBadge}>
        <span className={styles.toolSummaryMeta}>{summary.matchCount} matches</span>
      </span>
    );
  }

  if (name === 'read') {
    if (!summary.lineCount) return null;
    return (
      <span className={styles.toolSummaryBadge}>
        <span className={styles.toolSummaryMeta}>{summary.lineCount} lines</span>
      </span>
    );
  }

  return null;
});

// ── ToolOutputPreview — 可展开的工具输出预览 ──

const ToolOutputPreview = memo(function ToolOutputPreview({ name, summary }: { name: string; summary: ToolCallSummary }) {
  const preview = summary.outputPreview || '';
  if (!preview) return null;

  // bash: terminal-style output
  if (name === 'bash') {
    return (
      <div className={styles.toolOutputPreview} data-style="terminal">
        <pre className={styles.toolOutputPre}>{preview}</pre>
      </div>
    );
  }

  // grep/glob: file list style
  if (name === 'grep' || name === 'glob' || name === 'find') {
    const lines = preview.split('\n').filter(Boolean);
    return (
      <div className={styles.toolOutputPreview} data-style="filelist">
        {lines.map((line, i) => (
          <div key={i} className={styles.toolOutputFileLine}>{line}</div>
        ))}
        {summary.matchCount && summary.matchCount > lines.length && (
          <div className={styles.toolOutputMore}>
            ...and {summary.matchCount - lines.length} more
          </div>
        )}
      </div>
    );
  }

  // web_search / default: plain preview
  return (
    <div className={styles.toolOutputPreview}>
      <div className={styles.toolOutputText}>{preview}</div>
    </div>
  );
});
