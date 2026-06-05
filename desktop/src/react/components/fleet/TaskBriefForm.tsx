/**
 * TaskBriefForm — author a worker brief and dispatch it (B-line).
 * Posts to POST /api/fleet/dispatch; the server FleetHub broadcasts fleet events
 * back over the WS, so a dispatched worker appears on the board with no extra wiring.
 *
 * Supports fan-out: one brief dispatched to several agents in parallel (each gets
 * its own worker + worktree).
 */
import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Fleet.module.css';
import { DEFAULT_FLEET_SCOPE_PRESET, FLEET_SCOPE_PRESETS, buildPresetDefaults } from './brief-presets';

interface AgentEntry {
  id: string;
  label: string;
  enabled: boolean;
  available?: boolean;
  availability?: string;
}

type FleetTaskType = 'code';
type FleetApprovalMode = 'ask' | 'on-failure' | 'never' | 'yolo';
type FleetSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface FleetDispatchFormState {
  title: string;
  agent: string;
  taskType: FleetTaskType;
  image: string;
  approval: FleetApprovalMode;
  sandbox: FleetSandboxMode;
  objective: string;
  owned: string;
  forbidden: string;
  tests: string;
  branch: string;
  worktree: string;
}

const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'lynn-cli', label: 'Lynn CLI', enabled: true },
  { id: 'stepfun-flash', label: 'StepFun 3.7 Flash (fast coding)', enabled: true },
  { id: 'codex-cli', label: 'Codex', enabled: true },
  { id: 'claude-code', label: 'Claude Code', enabled: true },
  { id: 'claude-internal', label: 'Claude (internal)', enabled: true },
  { id: 'qwen-cli', label: 'Qwen', enabled: true },
  { id: 'kimi-cli', label: 'Kimi', enabled: true },
  { id: 'codebuddy', label: 'CodeBuddy', enabled: true },
];

const DEFAULT_FLEET_AGENT = 'lynn-cli';
const INITIAL_SCOPE_DEFAULTS = buildPresetDefaults(DEFAULT_FLEET_SCOPE_PRESET, '');
const EXTERNAL_AGENT_IDS = new Set([
  'codex-cli',
  'claude-code',
  'claude-internal',
  'qwen-cli',
  'kimi-cli',
  'codebuddy',
  'opencode',
]);

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function agentOptionLabel(agent: AgentEntry): string {
  if (agent.enabled) return agent.label;
  return `${agent.label} (${agent.availability || 'unavailable'})`;
}

export function isExternalFleetAgent(agentId: string): boolean {
  return EXTERNAL_AGENT_IDS.has(agentId);
}

export function externalTargetsNeedFullAccess(input: {
  targets: string[];
  approval: FleetApprovalMode;
  sandbox: FleetSandboxMode;
}): boolean {
  return input.targets.some(isExternalFleetAgent)
    && !(input.approval === 'yolo' && input.sandbox === 'danger-full-access');
}

export function buildFleetDispatchPayload(state: FleetDispatchFormState) {
  return {
    title: state.title,
    agent: state.agent,
    taskType: state.taskType,
    ...(state.image.trim() ? { image: state.image.trim() } : {}),
    approval: state.approval,
    sandbox: state.sandbox,
    objective: state.objective,
    owned: toLines(state.owned),
    forbidden: toLines(state.forbidden),
    testCommands: toLines(state.tests),
    branch: state.branch,
    worktree: state.worktree,
  };
}

export function TaskBriefForm({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState(DEFAULT_FLEET_AGENT);
  const [scopePresetId, setScopePresetId] = useState(DEFAULT_FLEET_SCOPE_PRESET.id);
  const [taskType, setTaskType] = useState<FleetTaskType>('code');
  const [approval, setApproval] = useState<FleetApprovalMode>('ask');
  const [sandbox, setSandbox] = useState<FleetSandboxMode>('workspace-write');
  const [fanOut, setFanOut] = useState<string[]>([]);
  const [objective, setObjective] = useState('');
  const [owned, setOwned] = useState(INITIAL_SCOPE_DEFAULTS.owned);
  const [forbidden, setForbidden] = useState(INITIAL_SCOPE_DEFAULTS.forbidden);
  const [tests, setTests] = useState(INITIAL_SCOPE_DEFAULTS.tests);
  const [branch, setBranch] = useState(INITIAL_SCOPE_DEFAULTS.branch);
  const [worktree, setWorktree] = useState(INITIAL_SCOPE_DEFAULTS.worktree);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/fleet/registry')
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.agents)) {
          const nextAgents = d.agents as AgentEntry[];
          setAgents(nextAgents);
          if (!nextAgents.some((a) => a.id === agent && a.enabled)) {
            const fallback = nextAgents.find((a) => a.enabled);
            if (fallback) setAgent(fallback.id);
          }
        }
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/fleet/permissions')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.approval === 'ask' || d?.approval === 'on-failure' || d?.approval === 'never' || d?.approval === 'yolo') {
          setApproval(d.approval);
        }
        if (d?.sandbox === 'read-only' || d?.sandbox === 'workspace-write' || d?.sandbox === 'danger-full-access') {
          setSandbox(d.sandbox);
        }
      })
      .catch(() => {
        /* keep guarded defaults */
      });
    return () => {
      alive = false;
    };
  }, []);

  const writesFiles = taskType === 'code';
  const targets = Array.from(new Set([agent, ...fanOut.filter((a) => a !== agent)]));
  const needsExternalFullAccess = externalTargetsNeedFullAccess({ targets, approval, sandbox });
  const baseBranch = branch;
  const baseWorktree = worktree;
  const canSubmit = !!title.trim() && !!baseBranch.trim() && !!baseWorktree.trim() && !needsExternalFullAccess;

  const setTaskKind = (value: FleetTaskType) => {
    setTaskType(value);
  };

  const applyScopePreset = (presetId: string) => {
    const preset = FLEET_SCOPE_PRESETS.find((p) => p.id === presetId) || DEFAULT_FLEET_SCOPE_PRESET;
    const defaults = buildPresetDefaults(preset, title);
    setScopePresetId(preset.id);
    setOwned(defaults.owned);
    setForbidden(defaults.forbidden);
    setTests(defaults.tests);
    setBranch(defaults.branch);
    setWorktree(defaults.worktree);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const fan = targets.length > 1;
      for (const target of targets) {
        const brief = buildFleetDispatchPayload({
          title,
          agent: target,
          taskType,
          image: '',
          approval,
          sandbox,
          objective,
          owned: writesFiles ? owned : '',
          forbidden: writesFiles ? forbidden : '',
          tests: writesFiles ? tests : '',
          branch: fan && baseBranch ? `${baseBranch}-${target}` : baseBranch,
          worktree: fan && baseWorktree ? `${baseWorktree}-${target}` : baseWorktree,
        });
        const res = await hanaFetch('/api/fleet/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(brief),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(`${target}: ${data.error || `dispatch failed (${res.status})`}`);
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

  return (
    <div className={s.briefForm}>
      <div className={s.formField}>
        <label className={s.formLabel}>Title</label>
        <input className={s.formInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Split ComposerTextarea" />
      </div>
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Agent</label>
          <select className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.enabled}>
                {agentOptionLabel(a)}
              </option>
            ))}
          </select>
          <div className={s.formHint}>{agents.find((a) => a.id === agent)?.availability || 'Ready'}</div>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>Task type</label>
          <select className={s.formInput} value={taskType} onChange={(e) => setTaskKind(e.target.value as FleetTaskType)}>
            <option value="code">Code / text work</option>
          </select>
        </div>
      </div>

      <div className={s.formField}>
        <label className={s.formLabel}>Scope preset</label>
        <select className={s.formInput} value={scopePresetId} onChange={(e) => applyScopePreset(e.target.value)}>
          {FLEET_SCOPE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <div className={s.formHint}>
          {FLEET_SCOPE_PRESETS.find((preset) => preset.id === scopePresetId)?.description || DEFAULT_FLEET_SCOPE_PRESET.description}
        </div>
      </div>

      {agents.length > 1 && (
        <div className={s.formField}>
          <label className={s.formLabel}>Fan out to (parallel, optional)</label>
          <div className={s.fanOutRow}>
            {agents
              .filter((a) => a.id !== agent && a.enabled)
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

      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Approval</label>
          <select className={s.formInput} value={approval} onChange={(e) => setApproval(e.target.value as FleetApprovalMode)}>
            <option value="ask">ask (guarded)</option>
            <option value="on-failure">on-failure</option>
            <option value="never">never (read/check only)</option>
            <option value="yolo">yolo (autonomous edits)</option>
          </select>
          <div className={approval === 'yolo' ? s.formDangerHint : s.formHint}>
            {approval === 'yolo'
              ? 'YOLO lets the worker edit files and run shell tools without another prompt.'
              : 'Non-interactive workers may stop before dangerous edits unless approval is yolo.'}
          </div>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>Sandbox</label>
          <select className={s.formInput} value={sandbox} onChange={(e) => setSandbox(e.target.value as FleetSandboxMode)}>
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
          <div className={sandbox === 'danger-full-access' ? s.formDangerHint : s.formHint}>
            {sandbox === 'danger-full-access'
              ? 'Full filesystem access is only for trusted local worktrees.'
              : 'Workspace-write keeps edits scoped to the assigned worktree.'}
          </div>
        </div>
      </div>
      {targets.some(isExternalFleetAgent) && (
        <div className={needsExternalFullAccess ? s.formDangerHint : s.formHint}>
          External CLI adapters run their own shell/process. To launch them from Fleet, explicitly set Approval=yolo and
          Sandbox=danger-full-access. Built-in Lynn and StepFun workers can stay guarded.
        </div>
      )}
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Branch</label>
          <input className={s.formInput} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="cli-2/inputarea" />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Worktree</label>
        <input className={s.formInput} value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="worktrees/cli-2-inputarea" />
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Objective</label>
        <textarea className={s.formTextarea} value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} />
      </div>
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
      {error && <div className={s.formError}>{error}</div>}
      <div className={s.formActions}>
        <button className={s.fleetBtn} onClick={submit} disabled={busy || !canSubmit}>
          {busy ? 'Dispatching...' : targets.length > 1 ? `Dispatch to ${targets.length} workers` : 'Dispatch worker'}
        </button>
        <button className={s.fleetBtn} onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
