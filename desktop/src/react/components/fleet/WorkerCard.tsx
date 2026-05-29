/**
 * WorkerCard — one worker's live view: status, a code-change summary (aggregate
 * "N files changed +X -Y" plus a per-file list with verbs and +/- counts, the
 * file being written right now shown as in-progress), tests, log, finish/error,
 * a click-to-expand per-file diff drawer, and recovery actions
 * (Cancel / Retry / Open worktree / Copy logs).
 */
import { useState } from 'react';
import type { FleetWorkerView } from './fleet-reducer';
import type { FleetChangedFile } from '../../../../../shared/fleet-events.js';
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
  fetchFileDiff,
}: {
  worker: FleetWorkerView;
  onCancel?: (workerId: string) => void;
  onRetry?: (workerId: string) => void;
  onOpenWorktree?: (worker: FleetWorkerView) => void;
  fetchFileDiff?: (workerId: string, file: string) => Promise<string>;
}) {
  const { diffStat } = worker;
  const fileCount = diffStat?.files ?? worker.changedFiles.length;
  const hasChanges = worker.changedFiles.length > 0 || diffStat != null;

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);

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
    } catch {
      /* clipboard unavailable */
    }
  };

  const canCancel = !!onCancel && ['queued', 'running', 'waiting_approval', 'blocked'].includes(worker.status);
  const canRetry = !!onRetry && ['failed', 'cancelled', 'blocked', 'completed'].includes(worker.status);
  const canOpen = !!onOpenWorktree && !!worker.worktree;
  const canCopy = worker.log.length > 0;
  const hasActions = canCancel || canRetry || canOpen || canCopy;

  return (
    <div className={s.workerCard} data-status={worker.status} data-blocked={worker.hasForbiddenEdit ? '1' : '0'}>
      <div className={s.workerHead}>
        <span className={s.workerAgent}>{worker.agent ?? 'worker'}</span>
        <span className={s.workerBranch}>{worker.branch ?? worker.workerId}</span>
        {worker.hasForbiddenEdit && (
          <span className={s.badgeScope} title="out-of-scope edit">
            out-of-scope
          </span>
        )}
        <span className={s.workerStatus}>{STATUS_LABEL[worker.status] ?? worker.status}</span>
      </div>

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
        <pre className={s.diffDrawer}>
          {diffLoading ? 'loading diff…' : diffText || 'no diff yet (worktree not materialized until the worker really runs)'}
        </pre>
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
              Copy logs
            </button>
          )}
        </div>
      )}
    </div>
  );
}
