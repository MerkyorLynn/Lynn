// Brain v2 · SGLang wire adapter tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockFetch, ok, fail, makeSSEBody, sseEvent, sseDone, drain } from './helpers.js';
import { call as callSGLang } from '../wire-adapter/sglang.js';

const provider = {
  id: 'qwen3.6-35b-a3b',
  endpoint: 'http://127.0.0.1:18002/v1',
  apiKey: 'none',
  model: 'Qwen3.6-35B-A3B-FP8',
  capability: { vision: false, tools: true, thinking: true },
};

describe('SGLang wire adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends chat_template_kwargs.enable_thinking:true (永远 true,brain 不替模型决策)', async () => {
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
    await drain(callSGLang({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.chat_template_kwargs).toBeDefined();
    expect(body.chat_template_kwargs.enable_thinking).toBe(true);
    expect(body.max_tokens).toBe(32000);
  });

  it('emits reasoning + content chunks in order', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ reasoning_content: '思考中' }),
      sseEvent({ reasoning_content: '...' }),
      sseEvent({ content: '答案' }),
      sseDone(),
    )));
    const chunks = await drain(callSGLang({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.map(c => c.type)).toEqual(['reasoning', 'reasoning', 'content']);
    expect(chunks[0].delta + chunks[1].delta).toBe('思考中...');
    expect(chunks[2].delta).toBe('答案');
  });

  it('handles native tool_calls (qwen3_coder parser)', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ reasoning_content: '需要查股价' }),
      sseEvent({ tool_calls: [{ index: 0, id: 't1', function: { name: 'stock_market', arguments: '' } }] }),
      sseEvent({ tool_calls: [{ index: 0, function: { arguments: '{\"query\":\"AAPL\"}' } }] }),
      sseEvent({}, { finishReason: 'tool_calls' }),
      sseDone(),
    )));
    const chunks = await drain(callSGLang({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const tcs = chunks.filter(c => c.type === 'tool_call_delta');
    expect(tcs.length).toBe(2);
    // Lynn-side accumulator joins these
    const finish = chunks.find(c => c.type === 'finish');
    expect(finish.reason).toBe('tool_calls');
  });

  it('forwards Authorization Bearer none when apiKey=none', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callSGLang({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer none');
  });

  it('throws on HTTP 503', async () => {
    mockFetch(fail(503, 'down'));
    await expect(drain(callSGLang({ provider, messages: [{ role: 'user', content: 'q' }] }))).rejects.toThrow(/sglang HTTP 503/);
  });
});
