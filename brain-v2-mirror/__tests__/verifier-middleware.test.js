// Brain v2 · verifier middleware unit tests
// Vitest. Pure unit (no real LLM call). E2E with real provider goes in scripts/smoke.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildVerifierPrompt, parseVerifierResponse } from '../verifier-prompts.mjs';

describe('parseVerifierResponse', () => {
  it('parses pure JSON', () => {
    const r = parseVerifierResponse('{"C1": 2, "C2": 3, "C3": 1, "reason": "ok"}');
    expect(r).toEqual({ C1: 2, C2: 3, C3: 1, reason: 'ok' });
  });

  it('parses JSON wrapped in markdown fence', () => {
    const r = parseVerifierResponse('```json\n{"C1": 5, "C2": 4, "C3": 6, "reason": "ok"}\n```');
    expect(r).toEqual({ C1: 5, C2: 4, C3: 6, reason: 'ok' });
  });

  it('parses JSON with leading prose', () => {
    const r = parseVerifierResponse('Here it is: {"C1": 1, "C2": 1, "C3": 1, "reason": "perfect"}');
    expect(r?.C1).toBe(1);
    expect(r?.reason).toBe('perfect');
  });

  it('rejects out-of-range scores', () => {
    expect(parseVerifierResponse('{"C1": 0, "C2": 5, "C3": 3, "reason": "x"}')).toBeNull();
    expect(parseVerifierResponse('{"C1": 9, "C2": 5, "C3": 3, "reason": "x"}')).toBeNull();
    expect(parseVerifierResponse('{"C1": -1, "C2": 5, "C3": 3, "reason": "x"}')).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(parseVerifierResponse('{"C1": 1, "C2": 2, "reason": "x"}')).toBeNull();
    expect(parseVerifierResponse('{"C1": 1, "C2": 2, "C3": null, "reason": "x"}')).toBeNull();
  });

  it('rejects non-numeric scores', () => {
    expect(parseVerifierResponse('{"C1": "1", "C2": 2, "C3": 3, "reason": "x"}')).toBeNull();
  });

  it('returns null on garbage / empty', () => {
    expect(parseVerifierResponse('garbage')).toBeNull();
    expect(parseVerifierResponse('')).toBeNull();
    expect(parseVerifierResponse(null)).toBeNull();
    expect(parseVerifierResponse(undefined)).toBeNull();
  });
});

describe('buildVerifierPrompt', () => {
  it('includes user prompt + tool name + result body', () => {
    const p = buildVerifierPrompt({
      userPrompt: '贵州茅台股价',
      toolName: 'stock_market',
      toolResult: '茅台 1750 CNY 2026-05-08',
    });
    expect(p).toContain('贵州茅台股价');
    expect(p).toContain('stock_market');
    expect(p).toContain('茅台 1750 CNY');
    expect(p).toContain('C1');
    expect(p).toContain('C2');
    expect(p).toContain('C3');
    expect(p).toContain('JSON');
  });

  it('truncates very long tool results', () => {
    const long = 'a'.repeat(20000);
    const p = buildVerifierPrompt({ userPrompt: 'x', toolName: 'web_search', toolResult: long });
    expect(p.length).toBeLessThan(20000);
    expect(p).toContain('a'.repeat(100));
  });

  it('handles non-string tool results gracefully', () => {
    const p = buildVerifierPrompt({ userPrompt: 'x', toolName: 'y', toolResult: null });
    expect(p).toContain('Tool Result:');
  });
});

describe('verifyToolResult skip paths', () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('skips when VERIFIER_ENABLED != 1', async () => {
    process.env.VERIFIER_ENABLED = '0';
    const { verifyToolResult } = await import('../verifier-middleware.mjs');
    const r = await verifyToolResult({
      userPrompt: 'x',
      toolName: 'web_search',
      toolResult: 'y',
    });
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.reason).toBe('disabled');
  });

  it('skips for tool not in whitelist', async () => {
    process.env.VERIFIER_ENABLED = '1';
    const { verifyToolResult } = await import('../verifier-middleware.mjs');
    const r = await verifyToolResult({
      userPrompt: 'x',
      toolName: 'create_pptx',
      toolResult: 'y',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('not-in-whitelist');
  });
});
