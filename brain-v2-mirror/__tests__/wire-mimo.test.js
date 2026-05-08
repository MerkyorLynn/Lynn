// Brain v2 · MiMo wire adapter tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockFetch, ok, fail, makeSSEBody, sseEvent, sseDone, drain } from './helpers.js';
import { call as callMimo } from '../wire-adapter/mimo.js';

const provider = {
  id: 'mimo',
  endpoint: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'mimo-v2.5-pro',
  capability: { vision: false, tools: true, native_search: true },
};

describe('MiMo wire adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends enable_search:true in request body', async () => {
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
    await drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(f).toHaveBeenCalledTimes(1);
    const [, init] = f.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.enable_search).toBe(true);
    expect(body.model).toBe('mimo-v2.5-pro');
    expect(body.stream).toBe(true);
  });

  it('forwards content delta', async () => {
    mockFetch(ok(makeSSEBody(sseEvent({ content: 'hello ' }), sseEvent({ content: 'world' }), sseDone())));
    const chunks = await drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const contents = chunks.filter(c => c.type === 'content').map(c => c.delta);
    expect(contents).toEqual(['hello ', 'world']);
  });

  it('forwards reasoning_content as reasoning chunk', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ reasoning_content: 'thinking...' }),
      sseEvent({ content: 'answer' }),
      sseDone(),
    )));
    const chunks = await drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const reasoning = chunks.filter(c => c.type === 'reasoning').map(c => c.delta);
    expect(reasoning).toEqual(['thinking...']);
  });

  it('forwards tool_calls as tool_call_delta', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ tool_calls: [{ index: 0, id: 'tc-1', function: { name: 'web_search', arguments: '{"q":"x"}' } }] }),
      sseEvent({}, { finishReason: 'tool_calls' }),
      sseDone(),
    )));
    const chunks = await drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const tcs = chunks.filter(c => c.type === 'tool_call_delta');
    expect(tcs.length).toBe(1);
    expect(tcs[0].delta[0].function.name).toBe('web_search');
    const finish = chunks.find(c => c.type === 'finish');
    expect(finish.reason).toBe('tool_calls');
  });

  it('throws on HTTP error', async () => {
    mockFetch(fail(500, 'server error'));
    await expect(drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }] }))).rejects.toThrow(/mimo HTTP 500/);
  });

  it('passes tools through to body when provided', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    const tools = [{ type: 'function', function: { name: 'web_search', parameters: {} } }];
    await drain(callMimo({ provider, messages: [{ role: 'user', content: 'q' }], tools }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
  });
});
