/**
 * TaskBriefForm — author a worker brief and dispatch it (B-line).
 * Posts to POST /api/fleet/dispatch; the server FleetHub broadcasts fleet events
 * back over the WS, so a dispatched worker appears on the board with no extra wiring.
 *
 * Supports MiMo vision dispatch (task type + image) and fan-out: one brief dispatched
 * to several agents in parallel (each gets its own worker + worktree).
 */
import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Fleet.module.css';

interface AgentEntry {
  id: string;
  label: string;
  enabled: boolean;
}

const TASK_TYPES = [
  { id: 'code', label: 'Code (edit files)' },
  { id: 'see', label: 'See (describe a screenshot)' },
  { id: 'ground', label: 'Ground (locate a UI target)' },
  { id: 'ui2code', label: 'UI -> code (screenshot to component)' },
] as const;
type TaskType = (typeof TASK_TYPES)[number]['id'];

const OBJECTIVE_LABEL: Record<TaskType, string> = {
  code: 'Objective',
  see: 'What to inspect',
  ground: 'What to locate (target)',
  ui2code: 'What to build',
};

const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'mimo-vl', label: 'MiMo Vision', enabled: true },
  { id: 'lynn-cli', label: 'Lynn CLI', enabled: true },
  { id: 'codex-cli', label: 'Codex', enabled: true },
  { id: 'claude-code', label: 'Claude Code', enabled: true },
  { id: 'claude-internal', label: 'Claude (internal)', enabled: true },
  { id: 'qwen-cli', label: 'Qwen', enabled: true },
];

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function TaskBriefForm({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS);
  const [taskType, setTaskType] = useState<TaskType>('code');
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState('claude-code');
  const [fanOut, setFanOut] = useState<string[]>([]);
  const [image, setImage] = useState('');
  const [objective, setObjective] = useState('');
  const [owned, setOwned] = useState('');
  const [forbidden, setForbidden] = useState('server/**\nbrain-v2-mirror/**');
  const [tests, setTests] = useState('npm run typecheck');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/fleet/registry')
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.agents)) {
          setAgents(d.agents.filter((a: AgentEntry) => a.enabled));
        }
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => {
      alive = false;
    };
  }, []);

  const isVision = taskType !== 'code';
  const writesFiles = taskType === 'code' || taskType === 'ui2code';
  const targets = Array.from(new Set([agent, ...fanOut.filter((a) => a !== agent)]));

  const onTaskTypeChange = (next: TaskType) => {
    setTaskType(next);
    if (next !== 'code' && !agent.startsWith('mimo')) setAgent('mimo-vl');
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const base = {
        title,
        taskType,
        objective,
        ...(image ? { image } : {}),
        owned: writesFiles ? toLines(owned) : [],
        forbidden: writesFiles ? toLines(forbidden) : [],
        testCommands: writesFiles ? toLines(tests) : [],
      };
      const baseBranch = branch || (isVision ? `vision/${taskType}` : '');
      const baseWorktree = worktree || (isVision ? `worktrees/vision-${taskType}` : '');
      const fan = targets.length > 1;
      for (const a of targets) {
        const brief = {
          ...base,
          agent: a,
          branch: fan && baseBranch ? `${baseBranch}-${a}` : baseBranch,
          worktree: fan && baseWorktree ? `${baseWorktree}-${a}` : baseWorktree,
        };
        const res = await hanaFetch('/api/fleet/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(brief),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(`${a}: ${data.error || `dispatch failed (${res.status})`}`);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !!title && (isVision ? !!image : !!branch && !!worktree);

  return (
    <div className={s.briefForm}>
      <div className={s.formField}>
        <label className={s.formLabel}>Title</label>
        <input className={s.formInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Split ComposerTextarea" />
      </div>

      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Task</label>
          <select className={s.formInput} value={taskType} onChange={(e) => onTaskTypeChange(e.target.value as TaskType)}>
            {TASK_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>Agent</label>
          <select className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {agents.length > 1 && (
        <div className={s.formField}>
          <label className={s.formLabel}>Fan out to (parallel, optional)</label>
          <div className={s.fanOutRow}>
            {agents
              .filter((a) => a.id !== agent)
              .map((a) => (
                <label key={a.id} className={s.fanOutChip}>
                  <input
                    type="checkbox"
                    checked={fanOut.includes(a.id)}
                    onChange={(e) =>
                      setFanOut((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)))
                    }
                  />
                  {a.label}
                </label>
              ))}
          </div>
        </div>
      )}

      {isVision && (
        <div className={s.formField}>
          <label className={s.formLabel}>Image (path)</label>
          <input
            className={s.formInput}
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="/path/to/screenshot.png"
          />
        </div>
      )}

      <div className={s.formField}>
        <label className={s.formLabel}>{OBJECTIVE_LABEL[taskType]}</label>
        <textarea
          className={s.formTextarea}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={2}
          placeholder={taskType === 'ground' ? 'the blue Submit button' : ''}
        />
      </div>

      {!isVision || writesFiles ? (
        <div className={s.formRow}>
          <div className={s.formField}>
            <label className={s.formLabel}>Branch</label>
            <input className={s.formInput} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="cli-2/inputarea" />
          </div>
          <div className={s.formField}>
            <label className={s.formLabel}>Worktree</label>
            <input className={s.formInput} value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="worktrees/cli-2-inputarea" />
          </div>
        </div>
      ) : null}

      {writesFiles && (
        <>
          <div className={s.formRow}>
            <div className={s.formField}>
              <label className={s.formLabel}>Owned files (one glob per line)</label>
              <textarea
                className={s.formTextarea}
                value={owned}
                onChange={(e) => setOwned(e.target.value)}
                rows={3}
                placeholder="desktop/src/react/components/input/**"
              />
            </div>
            <div className={s.formField}>
              <label className={s.formLabel}>Forbidden files</label>
              <textarea className={s.formTextarea} value={forbidden} onChange={(e) => setForbidden(e.target.value)} rows={3} />
            </div>
          </div>
          <div className={s.formField}>
            <label className={s.formLabel}>Test commands (one per line)</label>
            <textarea className={s.formTextarea} value={tests} onChange={(e) => setTests(e.target.value)} rows={2} />
          </div>
        </>
      )}

      {error && <div className={s.formError}>{error}</div>}
      <div className={s.formActions}>
        <button className={s.fleetBtn} onClick={submit} disabled={busy || !canSubmit}>
          {busy ? 'Dispatching…' : targets.length > 1 ? `Dispatch to ${targets.length} workers` : 'Dispatch worker'}
        </button>
        <button className={s.fleetBtn} onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
