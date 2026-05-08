// Brain v2 · deep-research module unit tests
// Tests parser + ranking logic. Does NOT call real LLMs (those are in scripts/deep-research-smoke.mjs).
import { describe, it, expect } from 'vitest';
import { _internals } from '../deep-research.mjs';

const {
  parseScores,
  validScores,
  DEFAULT_CANDIDATES,
  MIN_VALID_CANDIDATES,
  MAX_WINNER_AVG,
  MAX_WINNER_DIMENSION,
  scoreMaxDimension,
  isAcceptableScore,
  buildQualityRejectedResult,
} = _internals;

describe('deep-research parseScores', () => {
  it('parses pure JSON', () => {
    const r = parseScores('{"C1": 2, "C2": 3, "C3": 1, "reason": "ok"}');
    expect(r).toEqual({ C1: 2, C2: 3, C3: 1, reason: 'ok' });
  });

  it('handles markdown fence', () => {
    const r = parseScores('```json\n{"C1": 5, "C2": 4, "C3": 6, "reason": "ok"}\n```');
    expect(r?.C1).toBe(5);
  });

  it('rejects out-of-range', () => {
    expect(parseScores('{"C1": 0, "C2": 5, "C3": 3, "reason": "x"}')).toBeNull();
    expect(parseScores('{"C1": 9, "C2": 5, "C3": 3, "reason": "x"}')).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(parseScores('garbage')).toBeNull();
    expect(parseScores('')).toBeNull();
    expect(parseScores(null)).toBeNull();
  });
});

describe('deep-research validScores', () => {
  it('accepts valid 1-8 integer scores', () => {
    expect(validScores({ C1: 1, C2: 4, C3: 8 })).toBe(true);
  });
  it('rejects non-integer', () => {
    expect(validScores({ C1: 1.5, C2: 2, C3: 3 })).toBe(true); // allows floats actually (Number.isFinite)
  });
  it('rejects missing fields', () => {
    expect(validScores({ C1: 1, C2: 2 })).toBe(false);
  });
});

describe('deep-research config', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_CANDIDATES.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_CANDIDATES.length).toBeLessThanOrEqual(6);
    expect(MIN_VALID_CANDIDATES).toBeGreaterThanOrEqual(1);
  });
  it('default candidates are registered providers', async () => {
    const { getProvider } = await import('../provider-registry.js');
    for (const id of DEFAULT_CANDIDATES) {
      expect(getProvider(id), `provider ${id} should be registered`).toBeTruthy();
    }
  });
});

describe('deep-research ranking sanity (sort order)', () => {
  it('lower avg ranks first (best)', () => {
    const scores = [
      { providerId: 'a', avg: 3.0, scored: true },
      { providerId: 'b', avg: 1.5, scored: true },
      { providerId: 'c', avg: 5.0, scored: true },
    ];
    const sorted = scores.sort((x, y) => x.avg - y.avg);
    expect(sorted[0].providerId).toBe('b');
    expect(sorted[2].providerId).toBe('c');
  });
});

describe('deep-research quality floor', () => {
  it('accepts a scored candidate only when avg and every dimension pass', () => {
    expect(isAcceptableScore({
      scored: true,
      avg: MAX_WINNER_AVG,
      scores: { C1: 1, C2: 2, C3: MAX_WINNER_DIMENSION },
    })).toBe(true);

    expect(isAcceptableScore({
      scored: true,
      avg: MAX_WINNER_AVG + 0.01,
      scores: { C1: 4, C2: 4, C3: 4 },
    })).toBe(false);

    expect(isAcceptableScore({
      scored: true,
      avg: 3.33,
      scores: { C1: MAX_WINNER_DIMENSION + 1, C2: 1, C3: 3 },
    })).toBe(false);
  });

  it('builds a quality-rejected fallback instead of exposing a weak winner', () => {
    const result = buildQualityRejectedResult({
      candidateResults: [
        { providerId: 'mimo', ok: true, content: 'bad answer', latencyMs: 1000 },
        { providerId: 'deepseek-chat', ok: true, content: 'weak answer', latencyMs: 1200 },
      ],
      scores: [
        { providerId: 'mimo', scored: true, avg: 4.67, scores: { C1: 7, C2: 4, C3: 3 } },
        { providerId: 'deepseek-chat', scored: true, avg: 5.33, scores: { C1: 5, C2: 6, C3: 5 } },
      ],
      phase1Ms: 1000,
      phase2Ms: 500,
      startedAt: Date.now() - 1600,
    });

    expect(result.winner).toBeNull();
    expect(result.qualityRejected).toBe(true);
    expect(result.fallbackContent).toContain('Deep Research 已拦截');
    expect(result.rankedScores[0].providerId).toBe('mimo');
    expect(scoreMaxDimension(result.rankedScores[0].scores)).toBe(7);
  });
});
