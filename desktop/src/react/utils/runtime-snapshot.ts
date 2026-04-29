import { hanaFetch } from '../hooks/use-hana-fetch';
import { syncTaskWakeLockFromSnapshot } from '../services/wake-lock';
import { useStore } from '../stores';
import type { CapabilitySnapshot, TaskRuntimeSnapshot } from '../types';

declare function t(key: string, vars?: Record<string, string | number>): string;

function maybeAnnounceRecoveredTasks(snapshot: TaskRuntimeSnapshot | null | undefined): void {
  const activeCount = Number(snapshot?.activeCount || 0);
  if (!activeCount) return;

  const ids = Array.isArray(snapshot?.recent)
    ? snapshot.recent.map((task) => task.id).filter(Boolean).join(',')
    : '';
  const toastKey = `runtime-recovered:${activeCount}:${ids}`;

  try {
    if (window.sessionStorage?.getItem(toastKey)) return;
    window.sessionStorage?.setItem(toastKey, '1');
  } catch {
    // ignore sessionStorage failures
  }

  useStore.getState().addToast(
    t('status.tasksRecovered', { count: activeCount }),
    'info',
    5000,
    { dedupeKey: toastKey },
  );
}

export async function syncRuntimeSnapshot(opts: { announceRecovery?: boolean } = {}): Promise<void> {
  try {
    const res = await hanaFetch('/api/app-state');
    const data = await res.json();
    const patch: Record<string, unknown> = {};

    if (data?.agent?.currentAgentId) patch.currentAgentId = data.agent.currentAgentId;
    if (data?.agent?.name) patch.agentName = data.agent.name;
    if (data?.agent?.yuan) patch.agentYuan = data.agent.yuan;
    if (data?.desk?.homeFolder !== undefined) {
      patch.homeFolder = data.desk.homeFolder || null;
      patch.selectedFolder = data.desk.homeFolder || null;
    }
    if (Array.isArray(data?.desk?.trustedRoots)) patch.trustedRoots = data.desk.trustedRoots;
    if (data?.model?.current?.id) {
      patch.currentModel = {
        id: data.model.current.id,
        provider: data.model.current.provider || '',
      };
    }
    if (data?.tasks !== undefined) patch.taskSnapshot = (data.tasks || null) as TaskRuntimeSnapshot | null;
    if (data?.capabilities !== undefined) patch.capabilitySnapshot = (data.capabilities || null) as CapabilitySnapshot | null;

    if (Object.keys(patch).length > 0) {
      useStore.setState(patch);
    }

    syncTaskWakeLockFromSnapshot((data?.tasks || null) as TaskRuntimeSnapshot | null);

    if (opts.announceRecovery) {
      maybeAnnounceRecoveredTasks((data?.tasks || null) as TaskRuntimeSnapshot | null);
    }

    if (data?.security?.mode) {
      useStore.getState().setSecurityMode(data.security.mode);
      window.dispatchEvent(new CustomEvent('hana-security-mode', { detail: { mode: data.security.mode } }));
      window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: !!data.security.planMode } }));
    }
  } catch (err) {
    console.warn('[runtime] snapshot sync failed:', err);
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAnnounce = false;

export function requestRuntimeSnapshotRefresh(opts: { announceRecovery?: boolean } = {}): void {
  if (opts.announceRecovery) pendingAnnounce = true;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    const announceRecovery = pendingAnnounce;
    pendingAnnounce = false;
    refreshTimer = null;
    void syncRuntimeSnapshot({ announceRecovery });
  }, 80);
}
