// Brain v2 · agent-checkpoint module unit tests
import { describe, it, expect } from 'vitest';
import { _internals } from '../agent-checkpoint.mjs';

const { parseCheckpointResponse, validCheckpoint, formatTrajectory, buildCheckpointPrompt } = _internals;

describe('agent-checkpoint validCheckpoint', () => {
  it('accepts continue verdict', () => {
    expect(validCheckpoint({ C1: 1, C2: 2, C3: 1, verdict: 'continue', reason: 'x' })).toBe(true);
  });
  it('accepts replan verdict', () => {
    expect(validCheckpoint({ C1: 5, C2: 6, C3: 4, verdict: 'replan', reason: 'x' })).toBe(true);
  });
  it('accepts abort verdict', () => {
    expect(validCheckpoint({ C1: 7, C2: 8, C3: 7, verdict: 'abort', reason: 'x' })).toBe(true);
  });
  it('rejects unknown verdict', () => {
    expect(validCheckpoint({ C1: 1, C2: 2, C3: 1, verdict: 'maybe', reason: 'x' })).toBe(false);
  });
  it('rejects out-of-range scores', () => {
    expect(validCheckpoint({ C1: 0, C2: 5, C3: 3, verdict: 'continue' })).toBe(false);
    expect(validCheckpoint({ C1: 9, C2: 5, C3: 3, verdict: 'continue' })).toBe(false);
  });
});

describe('agent-checkpoint parseCheckpointResponse', () => {
  it('parses pure JSON', () => {
    const r = parseCheckpointResponse('{"C1": 2, "C2": 3, "C3": 1, "verdict": "continue", "reason": "ok"}');
    expect(r?.verdict).toBe('continue');
    expect(r?.C1).toBe(2);
  });
  it('parses with markdown fence', () => {
    const r = parseCheckpointResponse('```json\n{"C1": 6, "C2": 7, "C3": 5, "verdict": "replan", "reason": "stuck"}\n```');
    expect(r?.verdict).toBe('replan');
  });
  it('returns null on garbage', () => {
    expect(parseCheckpointResponse('garbage')).toBeNull();
    expect(parseCheckpointResponse('')).toBeNull();
  });
});

describe('agent-checkpoint formatTrajectory', () => {
  it('formats steps cleanly', () => {
    const t = formatTrajectory([
      { step: 1, action: 'web_search("Qwen3.6")', observation: 'found 5 results' },
      { step: 2, action: 'read_file("plan.md")', observation: 'plan content...' },
    ]);
    expect(t).toContain('Step 1');
    expect(t).toContain('web_search');
    expect(t).toContain('Step 2');
    expect(t).toContain('plan.md');
  });
  it('handles empty trajectory', () => {
    expect(formatTrajectory([])).toContain('no steps');
  });
  it('caps observation length to 600 chars', () => {
    const long = 'x'.repeat(2000);
    const t = formatTrajectory([{ step: 1, action: 'a', observation: long }]);
    expect(t).not.toContain('x'.repeat(700)); // truncated
    expect(t).toContain('x'.repeat(500));
  });
  it('keeps only last 15 steps', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ step: i + 1, action: `a${i}`, observation: `o${i}` }));
    const t = formatTrajectory(many);
    expect(t).toContain('Step 16'); // first kept
    expect(t).toContain('Step 30'); // last
    expect(t).not.toContain('Step 1\n'); // dropped (note newline disambiguates from 16)
  });
});

describe('agent-checkpoint buildCheckpointPrompt', () => {
  it('includes user goal + trajectory + verdict instruction', () => {
    const p = buildCheckpointPrompt({
      userPrompt: '调研 Qwen3.6 的本地部署方案',
      trajectory: [{ step: 1, action: 'web_search', observation: 'found qwen3.6 modelscope page' }],
      currentStep: 1,
      maxSteps: 10,
    });
    expect(p).toContain('调研 Qwen3.6');
    expect(p).toContain('Step 1');
    expect(p).toContain('continue');
    expect(p).toContain('replan');
    expect(p).toContain('abort');
    expect(p).toContain('JSON');
  });
});
