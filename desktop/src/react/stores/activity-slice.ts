import type { Activity, TaskRuntimeSnapshot } from '../types';

export interface ActivitySlice {
  activities: Activity[];
  taskSnapshot: TaskRuntimeSnapshot | null;
  setActivities: (activities: Activity[]) => void;
  setTaskSnapshot: (snapshot: TaskRuntimeSnapshot | null) => void;
}

export const createActivitySlice = (
  set: (partial: Partial<ActivitySlice>) => void
): ActivitySlice => ({
  activities: [],
  taskSnapshot: null,
  setActivities: (activities) => set({ activities }),
  setTaskSnapshot: (taskSnapshot) => set({ taskSnapshot }),
});

// ── Selectors ──
export const selectActivities = (s: ActivitySlice) => s.activities;
