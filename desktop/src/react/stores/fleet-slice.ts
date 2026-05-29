/**
 * fleet-slice.ts — Worker Fleet state (B-line). Holds the per-worker views and a
 * single `applyFleetEvent` reducer entry point shared by mock playback now and
 * the live `fleet:*` WS events later (ws-message-handler).
 */
import type { FleetWorkerEvent } from '../../../../shared/fleet-events.js';
import { applyFleetEventToList, type FleetWorkerView } from '../components/fleet/fleet-reducer';

export interface FleetSlice {
  /** Active + recent workers, in arrival order. */
  fleetWorkers: FleetWorkerView[];
  /** Fold one worker event into the matching view (creates it on worker.started). */
  applyFleetEvent: (event: FleetWorkerEvent) => void;
  /** Remove a single worker from the board. */
  removeWorker: (workerId: string) => void;
  /** Drop completed/cancelled/failed workers to declutter the board. */
  clearFinishedWorkers: () => void;
  /** Clear the board (used before replaying a mock stream). */
  resetFleet: () => void;
}

const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'];

export const createFleetSlice = (
  set: (partial: Partial<FleetSlice> | ((s: FleetSlice) => Partial<FleetSlice>)) => void,
): FleetSlice => ({
  fleetWorkers: [],
  applyFleetEvent: (event) => set((s) => ({ fleetWorkers: applyFleetEventToList(s.fleetWorkers, event) })),
  removeWorker: (workerId) => set((s) => ({ fleetWorkers: s.fleetWorkers.filter((w) => w.workerId !== workerId) })),
  clearFinishedWorkers: () =>
    set((s) => ({ fleetWorkers: s.fleetWorkers.filter((w) => !TERMINAL_STATUSES.includes(w.status)) })),
  resetFleet: () => set({ fleetWorkers: [] }),
});

// ── Selectors ──
export const selectFleetWorkers = (s: FleetSlice) => s.fleetWorkers;
