/**
 * WorkerCard — one worker's live view: collapsible card with a status dot, a
 * code-change summary, a per-file list, a click-to-expand colorized `git diff`
 * drawer, tests, log, finish/error, a reasoning indicator, and recovery actions
 * (Cancel / Retry / Open worktree / Copy logs) plus dismiss for finished workers.
 */
import { useState } from 'react';
import type { FleetWorkerView } from './fleet-reducer';
import { deriveGate } from './fleet-reducer';
import type { FleetChangedFile } from '../../../../../shared/fleet-events.js';
import { classifyDiffLine } from './diff-format';
import { formatVisualBox, groupVisualFiles, visualBoxStyle, visualImageSrc, VISUAL_FILE_KINDS } from './visual-format';
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
  onResume,
  onApprove,
  onIntegrate,
  onDiscard,
  onOpenWorktree,
  onDismiss,
  fetchFileDiff,
  collapsed: collapsedProp,
  onToggleCollapse,
}: {
  worker: FleetWorkerView;
  onCancel?: (workerId: string) => void;
  onRetry?: (workerId: string) => void;
  onResume?: (workerId: string) => void;
  onApprove?: (workerId: string) => void;
  onIntegrate?: (workerId: string, opts?: { force?: boolean; branch?: string }) => void;
  onDiscard?: (workerId: string) => void;
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
  const canApprove = !!onApprove && worker.status === 'waiting_approval' && !worker.hasForbiddenEdit && worker.gate?.ok !== false;
  const canIntegrate = !!onIntegrate && worker.review?.action === 'approved' && !!worker.review.commit;
  const gate = deriveGate(worker);
  const showGate = worker.tests.length > 0 || !!worker.gate || worker.hasForbiddenEdit;
  const canDiscard = !!onDiscard && ['waiting_approval', 'blocked', 'failed', 'completed', 'cancelled'].includes(worker.status);
  const canRetry = !!onRetry && ['failed', 'cancelled', 'blocked', 'completed'].includes(worker.status);
  const canResume = !!onResume && !!worker.checkpoint?.path && ['failed', 'cancelled', 'blocked', 'completed'].includes(worker.status);
  const canOpen = !!onOpenWorktree && !!worker.worktree;
  const canCopy = worker.log.length > 0;
  const hasActions = canCancel || canApprove || canIntegrate || canDiscard || canRetry || canResume || canOpen || canCopy;
  const recentTools = worker.tools.slice(-6);
  const visualResult = worker.visualResult;
  const visualTaskType = worker.taskType ?? visualResult?.taskType;
  const visualImage = worker.image ?? visualResult?.image;
  const visualPreviewSrc = visualImageSrc(visualImage);
  const isVision = (!!visualTaskType && visualTaskType !== 'code') || !!visualResult;
  const visualText = (visualResult?.summary || worker.assistant.trim() || worker.finished?.summary || '').trim();
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
        {worker.usage && <span className={s.usageChip}>{worker.usage.summary}</span>}
        {worker.checkpoint && (
          <span className={s.checkpointChip} title={worker.checkpoint.path ?? 'session checkpoint'}>
            checkpoint{worker.checkpoint.line ? `:${worker.checkpoint.line}` : ''}
          </span>
        )}
        {worker.hasForbiddenEdit && (
          <span className={s.badgeScope} title="out-of-scope edit">
            out-of-scope
          </span>
        )}
        {showGate && (
          <span
            className={s.gateBadge}
            data-pass={gate.passed ? '1' : '0'}
            title={gate.passed ? 'all checks passed' : gate.reasons.join('; ')}
          >
            {gate.passed ? 'gate ✓' : `gate ✗ · ${gate.reasons.length}`}
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
            ? 'demo runner - CLI runtime unavailable'
            : `spawned${runnerSourceLabel ? ` via ${runnerSourceLabel}` : ''}${
                worker.runner.pid != null ? ` (pid ${worker.runner.pid})` : ''
              }`}
        </div>
      )}

      {worker.planItems.length > 0 && (
        <div className={s.planBox}>
          <div className={s.planHead}>TodoWrite · Update todos</div>
          <ul className={s.planList}>
            {worker.planItems.map((item, index) => (
              <li key={item.id || index} data-status={item.status}>
                <span className={s.planGlyph}>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}</span>
                <span className={s.planId}>{item.id || `P${index + 1}`}</span>
                <span className={s.planText}>{item.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isVision && (
        <div className={s.visualResult}>
          <div className={s.visualResultHead}>
            visual · {visualTaskType}
            {visualImage ? <span className={s.visualImage}> · {visualImage}</span> : null}
          </div>
          {visualText ? (
            <div className={s.visualResultBody}>
              {visualPreviewSrc ? (
                <div className={s.visualPreview}>
                  <img className={s.visualPreviewImage} src={visualPreviewSrc} alt={visualImage || 'visual result'} draggable={false} />
                  {visualResult?.boxes?.map((b, i) => (
                    <span
                      key={`${b.label || 'box'}-${i}`}
                      className={s.visualOverlayBox}
                      style={visualBoxStyle(b)}
                      title={formatVisualBox(b, i)}
                      aria-label={formatVisualBox(b, i)}
                    >
                      <span className={s.visualOverlayLabel}>{b.label || `box ${i + 1}`}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {visualText}
              <span className={visualResult ? s.structuredTag : s.unstructuredTag}>
                {visualResult ? 'structured result' : 'unstructured preview'}
              </span>
              {visualResult?.boxes?.length ? (
                <ul className={s.visualBoxes}>
                  {visualResult.boxes.map((b, i) => (
                    <li key={i}>{formatVisualBox(b, i)}</li>
                  ))}
                </ul>
              ) : null}
              {visualResult?.files?.length ? (
                <div className={s.visualFiles}>
                  {VISUAL_FILE_KINDS.map((kind) => {
                    const paths = groupVisualFiles(visualResult.files ?? [])[kind];
                    if (!paths.length) return null;
                    return (
                      <div key={kind} className={s.visualFileGroup} data-kind={kind}>
                        <span className={s.visualFileKind}>{kind}</span>
                        {paths.map((p) => (
                          <span key={p} className={s.visualFilePath}>
                            {p}
                          </span>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : null}
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

          {recentTools.length > 0 && (
            <ul className={s.workerTools}>
              {recentTools.map((tool, idx) => {
                const state = tool.running ? 'run' : tool.ok ? 'ok' : 'fail';
                return (
                  <li key={`${tool.name}-${idx}`} data-ok={state}>
                    <span className={s.toolName}>{tool.name}</span>
                    {tool.argsPreview ? <span className={s.toolArgs}>{tool.argsPreview}</span> : null}
                    <span className={s.toolStatus}>
                      {tool.running ? 'running…' : tool.ok ? 'ok' : 'failed'}
                      {!tool.running && tool.ms != null ? ` · ${tool.ms}ms` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
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

          {worker.review?.action === 'approved' && (
            <div className={s.workerFinished}>
              approved{worker.review.commit ? ` · commit ${worker.review.commit}` : worker.review.changed === false ? ' · no changes' : ''}
            </div>
          )}

          {worker.review?.action === 'integrated' && (
            <div className={s.workerFinished}>
              integrated{worker.review.branch ? ` · ${worker.review.branch}` : ''}{worker.review.commit ? ` @ ${worker.review.commit}` : ''}
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
          {canApprove && (
            <button className={s.approveBtn} onClick={() => onApprove?.(worker.workerId)}>
              Approve
            </button>
          )}
          {canIntegrate && (
            <button className={s.approveBtn} onClick={() => onIntegrate?.(worker.workerId)} title="Cherry-pick into fleet/integration (gated: tests + scope must pass)">
              Integrate
            </button>
          )}
          {canIntegrate && gate.passed && (
            <button className={s.approveBtn} onClick={() => onIntegrate?.(worker.workerId, { branch: 'main' })} title="Gated merge into main (tests + scope must pass)">
              Merge to main
            </button>
          )}
          {canIntegrate && !gate.passed && (
            <button
              className={s.forceMergeBtn}
              onClick={() => onIntegrate?.(worker.workerId, { branch: 'main', force: true })}
              title={`Override the gate and merge into main anyway — ${gate.reasons.join('; ')}`}
            >
              Force merge
            </button>
          )}
          {canDiscard && (
            <button className={s.discardBtn} onClick={() => onDiscard?.(worker.workerId)}>
              Discard
            </button>
          )}
          {canRetry && (
            <button className={s.fleetBtn} onClick={() => onRetry?.(worker.workerId)}>
              Retry
            </button>
          )}
          {canResume && (
            <button className={s.fleetBtn} onClick={() => onResume?.(worker.workerId)} title={worker.checkpoint?.path}>
              Resume
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
