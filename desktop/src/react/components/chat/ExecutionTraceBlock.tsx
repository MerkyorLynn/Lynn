/**
 * ExecutionTraceBlock — 类 Codex 的执行轨迹概览
 *
 * 把工具调用压成一条可折叠的过程摘要，避免长任务时消息区过于噪杂。
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolCall } from '../../stores/chat-types';
import { extractToolDetail } from '../../utils/message-parser';
import { useI18n } from '../../hooks/use-i18n';
import styles from './Chat.module.css';

interface Props {
  tools: ToolCall[];
}

function formatElapsed(startedAt?: number): string {
  if (!startedAt) return '';
  const ms = Date.now() - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function compactLabel(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || text;
}

function zhSummary(tools: ToolCall[]): string {
  const counts = {
    read: 0,
    search: 0,
    edit: 0,
    command: 0,
    browse: 0,
    other: 0,
  };
  for (const tool of tools) {
    if (tool.name === 'read') counts.read += 1;
    else if (['grep', 'glob', 'find', 'web_search', 'search_memory'].includes(tool.name)) counts.search += 1;
    else if (['write', 'edit', 'edit-diff'].includes(tool.name)) counts.edit += 1;
    else if (tool.name === 'bash') counts.command += 1;
    else if (['browser', 'web_fetch'].includes(tool.name)) counts.browse += 1;
    else counts.other += 1;
  }

  const parts: string[] = [];
  if (counts.read) parts.push(`已查看 ${counts.read} 个文件`);
  if (counts.search) parts.push(`${counts.search} 次搜索`);
  if (counts.edit) parts.push(`${counts.edit} 次修改`);
  if (counts.command) parts.push(`${counts.command} 次命令`);
  if (counts.browse) parts.push(`${counts.browse} 次访问`);
  if (counts.other) parts.push(`${counts.other} 次其他操作`);
  return parts.length ? parts.slice(0, 3).join('，') : `已执行 ${tools.length} 个步骤`;
}

function enSummary(tools: ToolCall[]): string {
  const counts = {
    read: 0,
    search: 0,
    edit: 0,
    command: 0,
    browse: 0,
    other: 0,
  };
  for (const tool of tools) {
    if (tool.name === 'read') counts.read += 1;
    else if (['grep', 'glob', 'find', 'web_search', 'search_memory'].includes(tool.name)) counts.search += 1;
    else if (['write', 'edit', 'edit-diff'].includes(tool.name)) counts.edit += 1;
    else if (tool.name === 'bash') counts.command += 1;
    else if (['browser', 'web_fetch'].includes(tool.name)) counts.browse += 1;
    else counts.other += 1;
  }

  const parts: string[] = [];
  if (counts.read) parts.push(`${counts.read} file read${counts.read > 1 ? 's' : ''}`);
  if (counts.search) parts.push(`${counts.search} search${counts.search > 1 ? 'es' : ''}`);
  if (counts.edit) parts.push(`${counts.edit} edit${counts.edit > 1 ? 's' : ''}`);
  if (counts.command) parts.push(`${counts.command} command${counts.command > 1 ? 's' : ''}`);
  if (counts.browse) parts.push(`${counts.browse} visit${counts.browse > 1 ? 's' : ''}`);
  if (counts.other) parts.push(`${counts.other} other step${counts.other > 1 ? 's' : ''}`);
  return parts.length ? parts.slice(0, 3).join(', ') : `${tools.length} step${tools.length > 1 ? 's' : ''} executed`;
}

function buildToolTraceLine(tool: ToolCall, zh: boolean): string {
  const detail = extractToolDetail(tool.name, tool.args);
  switch (tool.name) {
    case 'read':
      return zh ? `查看 ${compactLabel(detail) || '文件'}` : `Read ${compactLabel(detail) || 'file'}`;
    case 'grep':
    case 'glob':
    case 'find':
    case 'web_search':
    case 'search_memory':
      return zh ? `搜索 ${detail || tool.name}` : `Searched ${detail || tool.name}`;
    case 'write':
    case 'edit':
    case 'edit-diff':
      return zh ? `修改 ${compactLabel(detail) || '文件'}` : `Edited ${compactLabel(detail) || 'file'}`;
    case 'bash':
      return zh ? `执行 ${detail || '命令'}` : `Ran ${detail || 'command'}`;
    case 'browser':
    case 'web_fetch':
      return zh ? `访问 ${detail || '页面'}` : `Visited ${detail || 'page'}`;
    default:
      return zh ? `使用 ${tool.name}` : `Used ${tool.name}`;
  }
}

export const ExecutionTraceBlock = memo(function ExecutionTraceBlock({ tools }: Props) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const allDone = tools.every((tool) => tool.done);
  const running = tools.filter((tool) => !tool.done).length;
  const defaultOpen = tools.length <= 3;
  const [open, setOpen] = useState(defaultOpen);
  const [userTouched, setUserTouched] = useState(false);
  const toggle = useCallback(() => {
    setUserTouched(true);
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    if (!userTouched) {
      setOpen(tools.length <= 3);
    }
  }, [tools.length, userTouched]);

  const summary = useMemo(
    () => (zh ? zhSummary(tools) : enSummary(tools)),
    [tools, zh],
  );
  const hint = zh
    ? (open ? '再次点击收起细节' : '点击查看执行细节')
    : (open ? 'Click to collapse details' : 'Click to view execution details');

  return (
    <details className={styles.executionTrace} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className={styles.executionTraceSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.executionTraceArrow}${open ? ` ${styles.executionTraceArrowOpen}` : ''}`}>›</span>
        <span className={styles.executionTraceTitle}>{summary}</span>
        {!allDone && (
          <span className={styles.executionTraceMeta}>
            {zh ? `处理中 ${running}/${tools.length}` : `${running}/${tools.length} running`}
            <span className={styles.thinkingDots}><span /><span /><span /></span>
          </span>
        )}
        <span className={styles.executionTraceHint}>{hint}</span>
      </summary>
      <div className={styles.executionTraceBody}>
        {tools.map((tool, index) => {
          const statusClass = tool.done
            ? (tool.success ? styles.executionTraceStatusDone : styles.executionTraceStatusFailed)
            : styles.executionTraceStatusRunning;
          const elapsed = formatElapsed(tool.startedAt);
          return (
            <div key={`${tool.name}-${index}-${tool.startedAt || index}`} className={styles.executionTraceItem}>
              <span className={`${styles.executionTraceStatus} ${statusClass}`}>
                {tool.done ? (tool.success ? '✓' : '✗') : '•'}
              </span>
              <span className={styles.executionTraceText}>{buildToolTraceLine(tool, zh)}</span>
              {elapsed && <span className={styles.executionTraceElapsed}>{elapsed}</span>}
            </div>
          );
        })}
      </div>
    </details>
  );
});
