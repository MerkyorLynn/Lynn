import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  __resetWakeLockForTests,
  hasActiveRuntimeTasks,
  isActiveTaskStatus,
  setStreamingWakeLock,
  syncTaskWakeLockFromSnapshot,
} from '../../services/wake-lock';

describe('wake-lock', () => {
  beforeEach(() => {
    __resetWakeLockForTests();
    (globalThis as unknown as { window: unknown }).window = {
      hana: { setWakeLock: vi.fn().mockResolvedValue({ active: true, blockerId: 1, reasons: [] }) },
    };
  });

  it('detects active task statuses', () => {
    expect(isActiveTaskStatus('pending')).toBe(true);
    expect(isActiveTaskStatus('running')).toBe(true);
    expect(isActiveTaskStatus('waiting_approval')).toBe(true);
    expect(isActiveTaskStatus('completed')).toBe(false);
    expect(isActiveTaskStatus('failed')).toBe(false);
  });

  it('keeps the system awake while streaming and releases after turn end', () => {
    const bridge = window.hana.setWakeLock as unknown as Mock;

    setStreamingWakeLock(true);
    setStreamingWakeLock(true);
    setStreamingWakeLock(false);

    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenNthCalledWith(1, 'chat:streaming', true);
    expect(bridge).toHaveBeenNthCalledWith(2, 'chat:streaming', false);
  });

  it('syncs wake lock reasons from runtime task snapshot', () => {
    const bridge = window.hana.setWakeLock as unknown as Mock;

    syncTaskWakeLockFromSnapshot({
      activeCount: 2,
      waitingApprovalCount: 1,
      runningCount: 1,
      pendingCount: 0,
      recent: [
        { id: 'a', title: 'A', status: 'running' },
        { id: 'b', title: 'B', status: 'waiting_approval' },
      ],
    });
    syncTaskWakeLockFromSnapshot({
      activeCount: 0,
      waitingApprovalCount: 0,
      runningCount: 0,
      pendingCount: 0,
      recent: [],
    });

    expect(bridge).toHaveBeenCalledWith('task:a', true);
    expect(bridge).toHaveBeenCalledWith('task:b', true);
    expect(bridge).toHaveBeenCalledWith('task:a', false);
    expect(bridge).toHaveBeenCalledWith('task:b', false);
  });

  it('treats activeCount without recent task ids as active work', () => {
    expect(hasActiveRuntimeTasks({
      activeCount: 1,
      waitingApprovalCount: 0,
      runningCount: 1,
      pendingCount: 0,
      recent: [],
    })).toBe(true);
  });
});
