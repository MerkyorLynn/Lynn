import { describe, expect, it } from 'vitest';
import { createWorkerView, reduceFleetWorker } from '../fleet-reducer';

// The server attaches structured context to worker.progress.data (an existing
// protocol field) for B1 vision + B3 runner, so the GUI can render them without a
// shared protocol change.
describe('worker.progress data (vision + runner context)', () => {
  it('captures vision taskType + image from data:{kind:vision}', () => {
    let v = createWorkerView('w1', 'mimo-vl');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'vision task: ground',
      data: { kind: 'vision', taskType: 'ground', image: '/shot.png' },
    });
    expect(v.taskType).toBe('ground');
    expect(v.image).toBe('/shot.png');
  });

  it('captures runner mode + source + pid from data:{kind:runner}', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'spawned via bundled Node (pid 7)',
      data: { kind: 'runner', mode: 'spawned', source: 'bundled', pid: 7 },
    });
    expect(v.runner).toEqual({ mode: 'spawned', source: 'bundled', pid: 7 });
  });

  it('stub runner data sets mode stub', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'stub - CLI bundle pending',
      data: { kind: 'runner', mode: 'stub' },
    });
    expect(v.runner?.mode).toBe('stub');
  });

  it('plain progress without data is just a log line', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, { type: 'worker.progress', workerId: 'w1', message: 'hello' });
    expect(v.log).toContain('hello');
    expect(v.taskType).toBeUndefined();
    expect(v.runner).toBeUndefined();
  });
});
