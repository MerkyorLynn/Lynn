/**
 * WorkersPanel — the GUI command deck for the CLI Worker Fleet (B-line, MVP shell).
 *
 * - "Dispatch worker" opens the Task Brief form -> POST /api/fleet/dispatch; the
 *   server FleetHub streams fleet events back over the WS into this board.
 * - "Play mock worker" replays a fixture stream through the same applyFleetEvent
 *   path the live WS uses, so the board is demoable without a running worker.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import fp from '../FloatingPanels.module.css';
import s from './Fleet.module.css';
import { WorkerCard } from './WorkerCard';
import { TaskBriefForm } from './TaskBriefForm';
import { playFleetFixture } from './playback';
import { MOCK_WORKER_JSONL } from './fixtures';
import { detectFleetConflicts } from './fleet-conflicts';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { CliEnvStatus } from '../../types';
import type { FleetWorkerView } from './fleet-reducer';

export function WorkersPanel() {
  const activePanel = useStore((st) => st.activePanel);
  const fleetWorkers = useStore((st) => st.fleetWorkers);
  const applyFleetEvent = useStore((st) => st.applyFleetEvent);
  const resetFleet = useStore((st) => st.resetFleet);
  const cancelRef = useRef<null | (() => void)>(null);
  const [showForm, setShowForm] = useState(false);
  const [cliEnv, setCliEnv] = useState<CliEnvStatus | null>(null);

  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  useEffect(() => {
    if (activePanel !== 'fleet') return;
    let alive = true;
    const p = window.hana?.cliEnvStatus?.();
    if (p) p.then((st) => { if (alive) setCliEnv(st); }).catch(() => { /* ipc unavailable */ });
    return () => {
      alive = false;
    };
  }, [activePanel]);

  if (activePanel !== 'fleet') return null;

  const close = () => useStore.getState().setActivePanel(null);

  const playMock = () => {
    if (cancelRef.current) cancelRef.current();
    resetFleet();
    cancelRef.current = playFleetFixture(MOCK_WORKER_JSONL, applyFleetEvent, { intervalMs: 250 });
  };

  const cancelWorker = (workerId: string) => {
    void hanaFetch(`/api/fleet/workers/${encodeURIComponent(workerId)}/cancel`, { method: 'POST' }).catch(() => {
      /* server broadcasts the cancel result; ignore transport errors here */
    });
  };

  const retryWorker = (workerId: string) => {
    void hanaFetch(`/api/fleet/workers/${encodeURIComponent(workerId)}/retry`, { method: 'POST' }).catch(() => {
      /* server broadcasts the new worker; ignore transport errors here */
    });
  };

  const openWorktree = (worker: FleetWorkerView) => {
    if (!worker.worktree) return;
    const abs = worker.cwd ? `${worker.cwd.replace(/\/+$/, '')}/${worker.worktree}` : worker.worktree;
    window.hana?.openFolder?.(abs);
  };

  const fetchFileDiff = async (workerId: string, file: string): Promise<string> => {
    try {
      const res = await hanaFetch(
        `/api/fleet/workers/${encodeURIComponent(workerId)}/diff?file=${encodeURIComponent(file)}`,
      );
      const data = (await res.json()) as { diff?: string };
      return typeof data.diff === 'string' ? data.diff : '';
    } catch {
      return '';
    }
  };

  const conflicts = detectFleetConflicts(fleetWorkers);

  const totals = fleetWorkers.reduce(
    (acc, w) => {
      if (w.diffStat) {
        acc.files += w.diffStat.files;
        acc.ins += w.diffStat.insertions;
        acc.del += w.diffStat.deletions;
      }
      return acc;
    },
    { files: 0, ins: 0, del: 0 },
  );

  return (
    <div className={fp.floatingPanel} onClick={close}>
      <div className={fp.floatingPanelInner} onClick={(e) => e.stopPropagation()}>
        <div className={fp.floatingPanelHeader}>
          <span className={fp.floatingPanelTitle}>Workers</span>
          <button className={fp.floatingPanelClose} onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          {cliEnv && (
            <div className={s.cliEnv} data-ready={cliEnv.ready ? '1' : '0'}>
              CLI runtime: Node {cliEnv.node.version ?? '?'} ({cliEnv.node.source})
              {cliEnv.ready ? ' · ready' : cliEnv.cli.present ? '' : ' · CLI bundle pending integration'}
            </div>
          )}
          <div className={s.fleetToolbar}>
            <button className={s.fleetBtn} onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'Close form' : 'Dispatch worker'}
            </button>
            <button className={s.fleetBtn} onClick={playMock}>
              Play mock worker
            </button>
            <span className={s.fleetHint}>
              {fleetWorkers.length} worker(s)
              {totals.files > 0 && (
                <>
                  {' · '}
                  {totals.files} files <span className={s.fileIns}>+{totals.ins}</span>{' '}
                  <span className={s.fileDel}>-{totals.del}</span>
                </>
              )}
            </span>
          </div>

          {showForm && <TaskBriefForm onClose={() => setShowForm(false)} />}

          {conflicts.length > 0 && (
            <div className={s.conflictBanner}>
              <strong>⚠ {conflicts.length} conflict(s)</strong>
              {conflicts.map((c) => (
                <div key={`${c.kind}:${c.path}`}>
                  {c.kind === 'center-lock' ? 'center-lock' : 'overlap'} · {c.path} · {c.workerIds.join(', ')}
                </div>
              ))}
            </div>
          )}

          {fleetWorkers.length === 0 ? (
            <div className={s.fleetEmpty}>
              <div className={s.emptyTitle}>No workers yet</div>
              <p>Dispatch 3-5 CLI workers (codex / claude / qwen ...) into isolated git worktrees and supervise them here.</p>
              <ol className={s.emptySteps}>
                <li>
                  <strong>Dispatch worker</strong> — write a brief: which files it owns, which are forbidden, the test commands.
                </li>
                <li>Each worker runs in its own worktree; this board shows its live log, per-file diff, and tests.</li>
                <li>Out-of-scope edits and center-file conflicts are flagged red and block merge.</li>
                <li>Cancel / retry / open the worktree from each card.</li>
              </ol>
              <p className={s.emptyHint}>
                New here? Click <strong>Play mock worker</strong> to watch a simulated run end-to-end.
              </p>
            </div>
          ) : (
            <div className={s.fleetBoard}>
              {fleetWorkers.map((w) => (
                <WorkerCard
                  key={w.workerId}
                  worker={w}
                  onCancel={cancelWorker}
                  onRetry={retryWorker}
                  onOpenWorktree={openWorktree}
                  fetchFileDiff={fetchFileDiff}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
