import type { TaskRuntimeSnapshot, TaskRuntimeSnapshotItem } from '../types';

const ACTIVE_TASK_STATUSES = new Set(['pending', 'running', 'waiting_approval']);
const requestedReasons = new Set<string>();
let activeTaskReasons = new Set<string>();
let warnedMissingBridge = false;

function getWakeLockBridge() {
  if (typeof window === 'undefined') return null;
  return window.hana?.setWakeLock || window.platform?.setWakeLock;
}

function taskReason(taskId: string): string {
  return `task:${taskId}`;
}

export function isActiveTaskStatus(status: unknown): boolean {
  return ACTIVE_TASK_STATUSES.has(String(status || '').toLowerCase());
}

export function hasActiveRuntimeTasks(snapshot: TaskRuntimeSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  if (Number(snapshot.activeCount || 0) > 0) return true;
  return Array.isArray(snapshot.recent) && snapshot.recent.some((task) => isActiveTaskStatus(task.status));
}

export function setWakeLockReason(reason: string, active: boolean): void {
  const key = String(reason || '').trim();
  if (!key) return;

  const alreadyActive = requestedReasons.has(key);
  if (active === alreadyActive) return;

  if (active) requestedReasons.add(key);
  else requestedReasons.delete(key);

  const bridge = getWakeLockBridge();
  if (!bridge) {
    if (!warnedMissingBridge) {
      warnedMissingBridge = true;
      console.warn('[wake-lock] Electron bridge is unavailable; sleep prevention skipped');
    }
    return;
  }

  bridge(key, active).catch((err: unknown) => {
    console.warn('[wake-lock] update failed:', err);
  });
}

export function setStreamingWakeLock(isStreaming: boolean): void {
  setWakeLockReason('chat:streaming', !!isStreaming);
}

export function updateTaskWakeLockFromTask(task: Partial<TaskRuntimeSnapshotItem> & { taskId?: string } | null | undefined): void {
  const id = String(task?.id || task?.taskId || '').trim();
  if (!id) return;
  const reason = taskReason(id);
  if (isActiveTaskStatus(task?.status)) {
    activeTaskReasons.add(reason);
    setWakeLockReason(reason, true);
  } else {
    activeTaskReasons.delete(reason);
    setWakeLockReason(reason, false);
  }
}

export function syncTaskWakeLockFromSnapshot(snapshot: TaskRuntimeSnapshot | null | undefined): void {
  const nextReasons = new Set<string>();
  const recent = Array.isArray(snapshot?.recent) ? snapshot.recent : [];

  for (const task of recent) {
    if (!task?.id || !isActiveTaskStatus(task.status)) continue;
    nextReasons.add(taskReason(task.id));
  }

  if (hasActiveRuntimeTasks(snapshot) && nextReasons.size === 0) {
    nextReasons.add('task:runtime');
  }

  for (const reason of activeTaskReasons) {
    if (!nextReasons.has(reason)) setWakeLockReason(reason, false);
  }
  for (const reason of nextReasons) {
    setWakeLockReason(reason, true);
  }
  activeTaskReasons = nextReasons;
}

export function __resetWakeLockForTests(): void {
  requestedReasons.clear();
  activeTaskReasons = new Set();
  warnedMissingBridge = false;
}
