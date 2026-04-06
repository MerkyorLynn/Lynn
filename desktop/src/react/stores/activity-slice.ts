import type { Activity, CapabilitySnapshot, TaskRuntimeSnapshot } from '../types';

export interface ActivitySlice {
  activities: Activity[];
  taskSnapshot: TaskRuntimeSnapshot | null;
  capabilitySnapshot: CapabilitySnapshot | null;
  setActivities: (activities: Activity[]) => void;
  setTaskSnapshot: (snapshot: TaskRuntimeSnapshot | null) => void;
  setCapabilitySnapshot: (snapshot: CapabilitySnapshot | null) => void;
}

export const createActivitySlice = (
  set: (partial: Partial<ActivitySlice>) => void
): ActivitySlice => ({
  activities: [],
  taskSnapshot: null,
  capabilitySnapshot: null,
  setActivities: (activities) => set({ activities }),
  setTaskSnapshot: (taskSnapshot) => set({ taskSnapshot }),
  setCapabilitySnapshot: (capabilitySnapshot) => set({ capabilitySnapshot }),
});

// ── Selectors ──
export const selectActivities = (s: ActivitySlice) => s.activities;
