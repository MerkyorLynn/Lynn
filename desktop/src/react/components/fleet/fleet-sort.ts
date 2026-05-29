/** Order workers so the ones needing attention float to the top of the board. Pure. */
import type { FleetWorkerView } from './fleet-reducer';

const ATTENTION_ORDER: Record<string, number> = {
  blocked: 0,
  failed: 1,
  waiting_approval: 2,
  running: 3,
  queued: 4,
  completed: 5,
  cancelled: 6,
};

export function sortWorkersByAttention(workers: FleetWorkerView[]): FleetWorkerView[] {
  return workers
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const oa = ATTENTION_ORDER[a.w.status] ?? 9;
      const ob = ATTENTION_ORDER[b.w.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.i - b.i; // stable: keep dispatch order within a status
    })
    .map((x) => x.w);
}
