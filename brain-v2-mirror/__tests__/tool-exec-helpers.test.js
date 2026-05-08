import { describe, it, expect, vi } from 'vitest';
import { makeLruCache, withTimeout, aggregateAllSettled } from '../tool-exec/_helpers.js';

describe('makeLruCache', () => {
  it('stores and retrieves values', () => {
    const c = makeLruCache(3, 10_000);
    c.set('a', 1); c.set('b', 2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
  });
  it('expires entries past TTL', async () => {
    const c = makeLruCache(3, 5);
    c.set('a', 1);
    await new Promise(r => setTimeout(r, 15));
    expect(c.get('a')).toBe(null);
  });
  it('evicts LRU when over maxSize', () => {
    const c = makeLruCache(2, 10_000);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBe(null);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });
  it('refreshes recency on get', () => {
    const c = makeLruCache(2, 10_000);
    c.set('a', 1); c.set('b', 2);
    c.get('a');  // a becomes most recent
    c.set('c', 3);  // should evict b not a
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(null);
  });
});

describe('withTimeout', () => {
  it('resolves when promise wins', async () => {
    const r = await withTimeout(Promise.resolve('ok'), 100);
    expect(r).toBe('ok');
  });
  it('rejects with timeout error when too slow', async () => {
    await expect(withTimeout(new Promise(r => setTimeout(() => r('late'), 100)), 20, 'task')).rejects.toThrow(/task timeout 20ms/);
  });
  it('does not leak timer when promise resolves first', async () => {
    const r = await withTimeout(Promise.resolve('fast'), 1000);
    expect(r).toBe('fast');
  });
});

describe('aggregateAllSettled', () => {
  it('returns ok/fail entries with source labels', async () => {
    const racers = [
      { source: 'a', fn: () => Promise.resolve('A!') },
      { source: 'b', fn: () => Promise.reject(new Error('boom')) },
    ];
    const r = await aggregateAllSettled(racers, 100, { minSuccess: 2 });
    expect(r).toEqual([
      { source: 'a', ok: true, value: 'A!' },
      { source: 'b', ok: false, error: 'boom' },
    ]);
  });
  it('marks slow racer as timeout', async () => {
    const racers = [
      { source: 'fast-fail', fn: () => Promise.reject(new Error('early boom')) },
      { source: 'slow', fn: () => new Promise(r => setTimeout(() => r('late'), 200)) },
    ];
    const r = await aggregateAllSettled(racers, 30);
    expect(r[0].ok).toBe(false);
    expect(r[0].error).toBe('early boom');
    expect(r[1].ok).toBe(false);
    expect(r[1].error).toMatch(/slow timeout/);
  });

  it('returns as soon as one racer succeeds instead of waiting for slow laggards', async () => {
    const racers = [
      { source: 'fast', fn: () => Promise.resolve('quick') },
      { source: 'slow', fn: () => new Promise(r => setTimeout(() => r('late'), 200)) },
    ];
    const t0 = Date.now();
    const r = await aggregateAllSettled(racers, 500, { settleWindowMs: 0 });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r).toEqual([{ source: 'fast', ok: true, value: 'quick' }]);
  });
});
