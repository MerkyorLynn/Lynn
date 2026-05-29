/**
 * WorkerCard — one worker's live view: collapsible card with a status dot, a
 * code-change summary, a per-file list, a click-to-expand colorized `git diff`
 * drawer, tests, log, finish/error, a reasoning indicator, and recovery actions
 * (Cancel / Retry / Open worktree / Copy logs) plus dismiss for finished workers.
 */
import { useState } from 'react';
import type { FleetWorkerView } from './fleet-reducer';
import type { FleetChangedFile } from '../../../../../shared/fleet-events.js';
import { classifyDiffLine } from './diff-format';
import s from './Fleet.module.css';

const STATUS_LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting_approval: 'review',
  blocked: 'blocked',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

const TERMINAL = ['completed', 'cancelled', 'failed'];

function fileVerb(file: FleetChangedFile, active: boolean): string {
  const action = file.action ?? 'edit';
  if (active) {
    if (action === 'add') return 'creating';
    if (action === 'delete') return 'deleting';
    if (action === 'rename') return 'renaming';
    return 'editing';
  }
  if (action === 'add') return 'new';
  if (action === 'delete') return 'deleted';
  if (action === 'rename') return 'renamed';
  return 'edited';
}

export function WorkerCard({
  worker,
  onCancel,
  onRetry,
  onOpenWorktree,
  onDismiss,
  fetchFileDiff,
  collapsed: collapsedProp,
  onToggleCollapse,
}: {
  worker: FleetWorkerView;
  onCancel?: (workerId: string) => void;
  onRetry?: (workerId: string) => void;
  onOpenWorktree?: (worker: FleetWorkerView) => void;
  onDismiss?: (workerId: string) => void;
  fetchFileDiff?: (workerId: string, file: string) => Promise<string>;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { diffStat } = worker;
  const fileCount = diffStat?.files ?? worker.changedFiles.length;
  const hasChanges = worker.changedFiles.length > 0 || diffStat != null;
  const isTerminal = TERMINAL.includes(worker.status);

  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedProp ?? localCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setLocalCollapsed((c) => !c));
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggleDiff = async (file: string) => {
    if (openFile === file) {
      setOpenFile(null);
      return;
    }
    setOpenFile(file);
    setDiffText('');
    if (!fetchFileDiff) return;
    setDiffLoading(true);
    try {
      setDiffText(await fetchFileDiff(worker.workerId, file));
    } catch {
      setDiffText('');
    } finally {
      setDiffLoading(false);
    }
  };

  const copyLogs = () => {
    try {
      void navigator.clipboard?.writeText(worker.log.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const canCancel = !!onCancel && ['queued', 'running', 'waiting_approval', 'blocked'].includes(worker.status);
  const canRetry = !!onRetry && ['failed', 'cancelled', 'blocked', 'completed'].includes(worker.status);
  const canOpen = !!onOpenWorktree && !!worker.worktree;
  const canCopy = worker.log.length > 0;
  const hasActions = canCancel || canRetry || canOpen || canCopy;
  const isVision = !!worker.taskType && worker.taskType !== 'code';
  const visualText = (worker.assistant.trim() || worker.finished?.summary || '').trim();
  const rs = worker.runner?.source;
  const runnerSourceLabel =
    rs === 'bundled' ? 'bundled Node' : rs === 'electron' ? 'Electron-as-node' : rs === 'dev' ? 'dev CLI' : rs;

  return (
    <div className={s.workerCard} data-status={worker.status} data-blocked={worker.hasForbiddenEdit ? '1' : '0'}>
      <div className={s.workerHead}>
        <button
          className={s.collapseBtn}
          type="button"
          onClick={toggleCollapse}
          aria-label={collapsed ? 'expand' : 'collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={s.statusDot} data-status={worker.status} />
        <span className={s.workerAgent}>{worker.agent ?? 'worker'}</span>
        <span className={s.workerBranch}>{worker.branch ?? worker.workerId}</span>
        {worker.reasoningChunks > 0 && <span className={s.reasoningChip}>reasoning x{worker.reasoningChunks}</span>}
        {worker.hasForbiddenEdit && (
          <span className={s.badgeScope} title="out-of-scope edit">
            out-of-scope
          </span>
        )}
        <span className={s.workerStatus}>{STATUS_LABEL[worker.status] ?? worker.status}</span>
        {onDismiss && isTerminal && (
          <button className={s.dismissBtn} type="button" onClick={() => onDismiss(worker.workerId)} aria-label="dismiss">
            ×
          </button>
        )}
      </div>

      {worker.runner && (
        <div className={s.runnerLine} data-mode={worker.runner.mode}>
          runner:{' '}
          {worker.runner.mode === 'stub'
            ? 'stub - CLI bundle pending'
            : `spawned${runnerSourceLabel ? ` via ${runnerSourceLabel}` : ''}${
                worker.runner.pid != null ? ` (pid ${worker.runner.pid})` : ''
              }`}
        </div>
      )}

      {isVision && (
        <div className={s.visualResult}>
          <div className={s.visualResultHead}>
            visual · {worker.taskType}
            {worker.image ? <span className={s.visualImage}> · {worker.image}</span> : null}
          </div>
          {visualText ? (
            <div className={s.visualResultBody}>
              {visualText}
              <span className={s.unstructuredTag}>unstructured preview</span>
            </div>
          ) : (
            <div className={s.visualResultPending}>waiting for result…</div>
          )}
        </div>
      )}

      {hasChanges && (
        <div className={s.changeSummary}>
          {fileCount} file{fileCount === 1 ? '' : 's'} changed
          {diffStat && (
            <>
              {' '}
              <span className={s.fileIns}>+{diffStat.insertions}</span>{' '}
              <span className={s.fileDel}>-{diffStat.deletions}</span>
            </>
          )}
        </div>
      )}

      {!collapsed && (
        <>
          {worker.changedFiles.length > 0 && (
            <ul className={s.workerFiles}>
              {worker.changedFiles.map((f) => {
                const active = worker.status === 'running' && f.path === worker.activeFile;
                const hasCounts = f.insertions != null || f.deletions != null;
                return (
                  <li key={f.path} data-forbidden={f.forbidden ? '1' : '0'} data-active={active ? '1' : '0'}>
                    <button className={s.fileRow} type="button" onClick={() => toggleDiff(f.path)} title="view diff">
                      <span className={s.fileVerb}>{fileVerb(f, active)}</span> {f.path}
                      {hasCounts && (
                        <>
                          {' '}
                          <span className={s.fileIns}>+{f.insertions ?? 0}</span>{' '}
                          <span className={s.fileDel}>-{f.deletions ?? 0}</span>
                        </>
                      )}
                      {f.forbidden ? '  (forbidden)' : ''}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {openFile && (
            <div className={s.diffDrawer}>
              {diffLoading ? (
                <div className={s.diffMeta}>loading diff…</div>
              ) : diffText ? (
                diffText.split('\n').map((line, i) => (
                  <div key={i} className={s.diffLine} data-kind={classifyDiffLine(line)}>
                    {line || ' '}
                  </div>
                ))
              ) : (
                <div className={s.diffMeta}>no diff yet (worktree not materialized until the worker really runs)</div>
              )}
            </div>
          )}

          {worker.tests.length > 0 && (
            <ul className={s.workerTests}>
              {worker.tests.map((t, idx) => (
                <li key={`${t.command}-${idx}`} data-ok={t.running ? 'run' : t.ok ? 'ok' : 'fail'}>
                  {t.command} — {t.running ? 'running…' : t.ok ? `ok${t.summary ? ` · ${t.summary}` : ''}` : 'failed'}
                </li>
              ))}
            </ul>
          )}

          {worker.log.length > 0 && <div className={s.workerLog}>{worker.log.slice(-4).join('\n')}</div>}

          {worker.finished && (
            <div className={s.workerFinished}>
              {worker.finished.summary}
              {worker.finished.commit ? ` (${worker.finished.commit})` : ''}
            </div>
          )}

          {worker.error && (
            <div className={s.workerError}>
              error {worker.error.code}: {worker.error.message}
            </div>
          )}
        </>
      )}

      {hasActions && (
        <div className={s.workerActions}>
          {canCancel && (
            <button className={s.fleetBtn} onClick={() => onCancel?.(worker.workerId)}>
              Cancel
            </button>
          )}
          {canRetry && (
            <button className={s.fleetBtn} onClick={() => onRetry?.(worker.workerId)}>
              Retry
            </button>
          )}
          {canOpen && (
            <button className={s.fleetBtn} onClick={() => onOpenWorktree?.(worker)}>
              Open worktree
            </button>
          )}
          {canCopy && (
            <button className={s.fleetBtn} onClick={copyLogs}>
              {copied ? 'Copied' : 'Copy logs'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
