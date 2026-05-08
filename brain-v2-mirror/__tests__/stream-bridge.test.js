import { describe, it, expect, vi } from 'vitest';
import { makeSSEEmitter } from '../stream-bridge.js';

function makeMockRes() {
  const writes = [];
  let ended = false;
  return {
    writes,
    isEnded: () => ended,
    write: vi.fn((s) => { writes.push(s); return true; }),
    end: vi.fn(() => { ended = true; }),
  };
}

function parseSSEWrites(writes) {
  return writes
    .filter(w => w.startsWith('data: '))
    .map(w => w.slice(6).trim())
    .filter(s => s !== '[DONE]')
    .map(s => JSON.parse(s));
}

describe('stream-bridge SSE emitter', () => {
  it('emitRole writes role=assistant first chunk', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitRole();
    const events = parseSSEWrites(res.writes);
    expect(events[0].choices[0].delta.role).toBe('assistant');
  });

  it('forwards content chunks', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitChunk({ type: 'content', delta: 'hi' }, { providerId: 'p1' });
    const ev = parseSSEWrites(res.writes)[0];
    expect(ev.choices[0].delta.content).toBe('hi');
    expect(ev.model).toBe('p1');
  });

  it('forwards reasoning as reasoning_content delta', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitChunk({ type: 'reasoning', delta: '思考' });
    const ev = parseSSEWrites(res.writes)[0];
    expect(ev.choices[0].delta.reasoning_content).toBe('思考');
  });

  it('forwards tool_call_delta as tool_calls in delta', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    const tcd = [{ index: 0, id: 't1', function: { name: 'web_search', arguments: '{}' } }];
    e.emitChunk({ type: 'tool_call_delta', delta: tcd });
    const ev = parseSSEWrites(res.writes)[0];
    expect(ev.choices[0].delta.tool_calls).toEqual(tcd);
  });

  it('forwards finish reason', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitChunk({ type: 'finish', reason: 'tool_calls' });
    const ev = parseSSEWrites(res.writes)[0];
    expect(ev.choices[0].finish_reason).toBe('tool_calls');
  });

  it('done() writes [DONE] and ends the response', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.done();
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(res.isEnded()).toBe(true);
  });

  it('emitError writes error payload', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitError('boom', [{ providerId: 'p1', error: 'x' }]);
    const ev = parseSSEWrites(res.writes)[0];
    expect(ev.error).toBe('boom');
    expect(ev.errors[0].providerId).toBe('p1');
  });

  it('does not write after done()', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.done();
    const beforeCount = res.writes.length;
    e.emitChunk({ type: 'content', delta: 'late' });
    expect(res.writes.length).toBe(beforeCount);
  });

  it('switches model when meta.providerId changes (fallback chain visibility)', () => {
    const res = makeMockRes();
    const e = makeSSEEmitter(res, { id: 'x' });
    e.emitChunk({ type: 'content', delta: 'a' }, { providerId: 'mimo' });
    e.emitChunk({ type: 'content', delta: 'b' }, { providerId: 'spark' });
    const events = parseSSEWrites(res.writes);
    expect(events[0].model).toBe('mimo');
    expect(events[1].model).toBe('spark');
  });
});
