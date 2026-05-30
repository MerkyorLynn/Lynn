import { describe, expect, it } from 'vitest';
import { deriveGate } from '../fleet-reducer';

const worker = (overrides: Record<string, unknown>) =>
  ({ tests: [], gate: null, hasForbiddenEdit: false, ...overrides }) as never;

describe('deriveGate (GUI merge gate badge)', () => {
  it('passes when nothing failed', () => {
    expect(deriveGate(worker({}))).toEqual({ passed: true, reasons: [] });
  });

  it('collects reasons for forbidden edits / failed tests / failed gate', () => {
    const g = deriveGate(
      worker({
        tests: [{ command: 'npm test', running: false, ok: false }],
        gate: { ok: false, summary: 'x' },
        hasForbiddenEdit: true,
      }),
    );
    expect(g.passed).toBe(false);
    expect(g.reasons).toContain('out-of-scope edits');
    expect(g.reasons).toContain('gate failed');
    expect(g.reasons.some((r) => r.includes('test'))).toBe(true);
  });

  it('passes when tests pass and scope is clean', () => {
    expect(
      deriveGate(worker({ tests: [{ command: 'x', running: false, ok: true }], gate: { ok: true, summary: 'ok' } })).passed,
    ).toBe(true);
  });
});
