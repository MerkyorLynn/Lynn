import { describe, expect, it } from 'vitest';
import { sortWorkersByAttention } from '../fleet-sort';
import { createWorkerView, type FleetWorkerView } from '../fleet-reducer';

function w(workerId: string, status: FleetWorkerView['status']): FleetWorkerView {
  return { ...createWorkerView(workerId), status };
}

describe('sortWorkersByAttention', () => {
  it('floats blocked/failed/review above running/done', () => {
    const order = sortWorkersByAttention([
      w('a', 'completed'),
      w('b', 'running'),
      w('c', 'blocked'),
      w('d', 'failed'),
      w('e', 'waiting_approval'),
    ]).map((x) => x.workerId);
    expect(order).toEqual(['c', 'd', 'e', 'b', 'a']);
  });

  it('is stable within the same status (keeps dispatch order)', () => {
    const order = sortWorkersByAttention([
      w('r1', 'running'),
      w('r2', 'running'),
      w('r3', 'running'),
    ]).map((x) => x.workerId);
    expect(order).toEqual(['r1', 'r2', 'r3']);
  });
});
