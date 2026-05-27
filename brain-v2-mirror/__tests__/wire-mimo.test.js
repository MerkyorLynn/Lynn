// Brain v2 · MiMo wire adapter tests
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockFetch, ok, fail, makeSSEBody, sseEvent, sseDone, drain } from './helpers.js';
import { call as callMimo, __testing__ } from '../wire-adapter/mimo.js';

const provider = {
  id: 'mimo',
  endpoint: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'mimo-v2.5-pro',
  capability: { vision: true, audio: true, tools: true, native_search: true },
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

describe('MiMo wire adapter — multimodal model switch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MIMO_MULTIMODAL_MODEL;
  });
  afterEach(() => {
    delete process.env.MIMO_MULTIMODAL_MODEL;
  });

  it('hasMultimodalContent detects image_url part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
      ]},
    ])).toBe(true);
  });

  it('hasMultimodalContent detects input_image part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://x' }] },
    ])).toBe(true);
  });

  it('hasMultimodalContent detects input_audio part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [
        { type: 'input_audio', input_audio: { data: 'b64...', format: 'mp3' } },
      ]},
    ])).toBe(true);
  });

  it('hasMultimodalContent detects audio_url part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [{ type: 'audio_url', audio_url: { url: 'https://x.mp3' } }] },
    ])).toBe(true);
  });

  it('hasMultimodalContent detects video_url part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://x.mp4' } }] },
    ])).toBe(true);
  });

  it('hasMultimodalContent detects input_video part', () => {
    expect(__testing__.hasMultimodalContent([
      { role: 'user', content: [{ type: 'input_video', video_url: 'https://x.mp4' }] },
    ])).toBe(true);
  });

  it('request body switches to multimodal model when video present', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callMimo({
      provider,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'summarize this video' },
        { type: 'video_url', video_url: { url: 'https://x.mp4', fps: 2 } },
      ]}],
    }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.model).toBe('mimo-v2.5');
  });

  it('hasMultimodalContent is false for plain text', () => {
    expect(__testing__.hasMultimodalContent([{ role: 'user', content: 'hello' }])).toBe(false);
    expect(__testing__.hasMultimodalContent([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(false);
  });

  it('pickModel returns provider.model for text-only', () => {
    expect(__testing__.pickModel(provider, [{ role: 'user', content: 'hi' }])).toBe('mimo-v2.5-pro');
  });

  it('pickModel returns mimo-v2.5 for multimodal content (default)', () => {
    expect(__testing__.pickModel(provider, [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
    ])).toBe('mimo-v2.5');
  });

  it('pickModel honors MIMO_MULTIMODAL_MODEL env override', () => {
    process.env.MIMO_MULTIMODAL_MODEL = 'mimo-v2-omni';
    expect(__testing__.pickModel(provider, [
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'b', format: 'wav' } }] },
    ])).toBe('mimo-v2-omni');
  });

  it('request body switches to multimodal model when image present', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callMimo({
      provider,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,zz' } },
      ]}],
    }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.model).toBe('mimo-v2.5');
    expect(body.enable_search).toBe(true);
    expect(body.stream).toBe(true);
  });

  it('request body keeps mimo-v2.5-pro for text-only after multimodal-capable provider', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callMimo({ provider, messages: [{ role: 'user', content: 'plain question' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.model).toBe('mimo-v2.5-pro');
  });

  it('tools work alongside multimodal (image + tools)', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    const tools = [{ type: 'function', function: { name: 'web_search', parameters: {} } }];
    await drain(callMimo({
      provider,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'x' } },
      ]}],
      tools,
    }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.model).toBe('mimo-v2.5');
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
  });
});
