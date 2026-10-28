import { getProvider } from '../provider-registry.js';
// Brain v2 · Generic OpenAI-compat wire adapter tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockFetch, ok, fail, makeSSEBody, sseEvent, sseDone, drain } from './helpers.js';
import { call as callOpenAI } from '../wire-adapter/openai-compat.js';

const provider = {
  id: 'deepseek-chat',
  endpoint: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  capability: { vision: false, tools: true, thinking: true },
};

describe('OpenAI-compat wire adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends bearer token + model in body', async () => {
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
    await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const init = f.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body).model).toBe('deepseek-v4-flash');
  });

  it('preserves HTTP status and does not expose billing response bodies', async () => {
    mockFetch(fail(402, 'Insufficient Balance private-account-value'));
    await expect(drain(callOpenAI({ provider, messages: [] }))).rejects.toMatchObject({ status: 402, message: 'deepseek-chat HTTP 402 billing unavailable: insufficient balance or subscription quota' });
  });

  it('does NOT include tools field when tools is null/empty', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('forwards reasoning + content (DeepSeek thinking mode)', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ reasoning_content: 'reason ' }),
      sseEvent({ content: 'answer' }),
      sseEvent({}, { finishReason: 'stop' }),
      sseDone(),
    )));
    const chunks = await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.map(c => c.type)).toEqual(['reasoning', 'content', 'finish']);
  });

  it('skips empty content delta (null vs empty string both ignored)', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ content: null }),
      sseEvent({ content: '' }),
      sseEvent({ content: 'real' }),
      sseDone(),
    )));
    const chunks = await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta).toBe('real');
  });

  it('respects provider.max_tokens override', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callOpenAI({ provider: { ...provider, max_tokens: 8192 }, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(8192);
  });

  it('asks upstream streaming APIs to include usage for cache telemetry', async () => {
    const f = mockFetch(ok(makeSSEBody(
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } }) + '\n\n',
      sseDone(),
    )));
    const chunks = await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(chunks).toContainEqual({ type: 'usage', usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } });
  });

  it('uses provider default reasoning effort and token budget for StepFun head route', async () => {
    const stepProvider = {
      id: 'step-3.7-flash',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKey: 'sk-step',
      model: 'step-3.7-flash',
      capability: { vision: false, tools: true, thinking: true },
      default_thinking: false,
      default_reasoning_effort: 'high',
      max_tokens: 32_768,
    };
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
    await drain(callOpenAI({
      provider: stepProvider,
      messages: [{ role: 'user', content: '请分析一下这个架构问题' }],
      reasoningEffort: 'auto',
    }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_tokens).toBe(32_768);
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('throws with provider.id in error message on 401', async () => {
    mockFetch(fail(401, 'invalid key'));
    await expect(drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }))).rejects.toThrow(/deepseek-chat HTTP 401/);
  });

  // ── 2026-06-08 default_thinking flag(Spark distilled A3B Brain v2 fallback 加固) ──
  describe('provider.default_thinking semantics', () => {
    const sparkProvider = {
      id: 'apex-spark-i-balanced',
      endpoint: 'http://127.0.0.1:18098/v1',
      apiKey: 'none',
      model: 'qwen36-35b-a3b-dsv4pro-distill-q4km-imatrix',
      capability: { vision: false, tools: true, thinking: true },
      default_thinking: false,
      thinking_control: 'qwen_chat_template',
    };

    it('default_thinking:false → 注入 chat_template_kwargs.enable_thinking=false', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({ provider: sparkProvider, messages: [{ role: 'user', content: 'q' }] }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.max_tokens).toBe(512);
    });

    it('default_thinking:false + reasoningEffort=high → opt-in thinking=true', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        reasoningEffort: 'high',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
      expect(body.reasoning_effort).toBe('high');
      expect(body.max_tokens).toBe(4096);
    });

    it('default_thinking:false + reasoningEffort=off → 保持 thinking=false', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        reasoningEffort: 'off',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      expect(body.max_tokens).toBe(512);
    });

    it('default_thinking:false + reasoningEffort=auto → 短答自动关闭 thinking', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: '你好' }],
        reasoningEffort: 'auto',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      expect(body.max_tokens).toBe(512);
      expect(body.reasoning_effort).toBe('auto');
    });

    it('default_thinking:false + realtime short query keeps answer budget', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: '今天天气怎样' }],
        reasoningEffort: 'auto',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      expect(body.max_tokens).toBe(4096);
    });

    it('default_thinking:false + reasoningEffort=auto → 复杂问题自动打开 thinking', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: '请分析一下本地模型默认安装 9B 和 4B 降级入口的产品取舍' }],
        reasoningEffort: 'auto',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
      expect(body.max_tokens).toBe(4096);
    });

    it('default_thinking:false + auto short answer respects explicit max_tokens override', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: '今天天气怎么样?' }],
        reasoningEffort: 'auto',
        extraBody: { max_tokens: 2048 },
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      expect(body.max_tokens).toBe(2048);
    });

    it('extraBody.chat_template_kwargs.enable_thinking 显式覆盖 default_thinking', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        extraBody: { chat_template_kwargs: { enable_thinking: true } },
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
    });

    it('未设 default_thinking 的 provider 不注入 chat_template_kwargs(default 行为不变)', async () => {
      // 即 deepseek-chat / glm 等老 provider 不受影响
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs).toBeUndefined();
    });

    it('default_thinking:false without qwen thinking_control does not leak chat_template_kwargs to cloud providers', async () => {
      const stepProvider = {
        id: 'step-3.7-flash',
        endpoint: 'https://api.stepfun.com/step_plan/v1',
        apiKey: 'sk-step',
        model: 'step-3.7-flash',
        capability: { vision: true, tools: true, thinking: true },
        default_thinking: false,
      };
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: stepProvider,
        messages: [{ role: 'user', content: '你好' }],
        reasoningEffort: 'auto',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.max_tokens).toBe(4096);
    });

    it('forwards explicit cloud reasoning effort but filters UI-only off/auto values', async () => {
      const stepProvider = {
        id: 'step-3.7-flash',
        endpoint: 'https://api.stepfun.com/step_plan/v1',
        apiKey: 'sk-step',
        model: 'step-3.7-flash',
        capability: { vision: true, tools: true, thinking: true },
        default_thinking: false,
      };
      const high = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: stepProvider,
        messages: [{ role: 'user', content: '请分析这个问题' }],
        reasoningEffort: 'high',
      }));
      expect(JSON.parse(high.mock.calls[0][1].body).reasoning_effort).toBe('high');

      const off = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: stepProvider,
        messages: [{ role: 'user', content: 'q' }],
        reasoningEffort: 'off',
      }));
      expect(JSON.parse(off.mock.calls[0][1].body).reasoning_effort).toBeUndefined();
    });

    it('keeps recent image content for native multimodal base models without vision_model', async () => {
      const mimoProvider = {
        id: 'mimo-multimodal',
        endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: 'sk-mimo',
        model: 'mimo-v2.5',
        capability: { vision: true, audio: true, video: true, tools: false, thinking: true },
        default_thinking: true,
      };
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({
        provider: mimoProvider,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '描述图片' },
            { type: 'input_image', image_url: { url: 'https://example.com/a.png' } },
          ],
        }],
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.model).toBe('mimo-v2.5');
      expect(body.messages[0].content[1].type).toBe('input_image');
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it.each(['image_url', 'input_image'])('keeps older %s blocks for native vision models instead of guessing they are irrelevant', async (type) => {
      const image = { type, image_url: { url: 'https://example.com/original.png' } };
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Remember this image' }, image] },
        ...Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', content: 'Context turn' })),
        { role: 'user', content: 'What color was the object in the image?' },
      ];
      const request = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({ provider: { ...provider, model: 'native-vision-model', capability: { vision: true, tools: true } }, messages }));
      const body = JSON.parse(request.mock.calls[0][1].body);
      expect(body.model).toBe('native-vision-model');
      expect(body.messages[0].content[1]).toEqual(image);
    });

    it('keeps native audio content for multimodal providers', async () => {
      const mimoProvider = {
        id: 'mimo-multimodal',
        endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: 'sk-mimo',
        model: 'mimo-v2.5',
        capability: { vision: true, audio: true, video: true, tools: false, thinking: true },
        default_thinking: true,
      };
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({
        provider: mimoProvider,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '听一下这段音频' },
            { type: 'input_audio', input_audio: { data: 'ZmFrZQ==', format: 'mp3' } },
            { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
          ],
        }],
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { data: 'ZmFrZQ==', format: 'mp3' } });
      expect(body.messages[0].content[2]).toEqual({ type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } });
      expect(body.tools).toBeUndefined();
    });

    it('keeps native video content for multimodal providers', async () => {
      const mimoProvider = {
        id: 'mimo-multimodal',
        endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: 'sk-mimo',
        model: 'mimo-v2.5',
        capability: { vision: true, audio: true, video: true, tools: false, thinking: true },
        default_thinking: true,
      };
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({
        provider: mimoProvider,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '总结这个视频' },
            { type: 'input_video', input_video: { url: 'https://example.com/v.mp4' } },
            { type: 'video_url', video_url: { url: 'https://example.com/b.mp4' } },
          ],
        }],
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.messages[0].content[1]).toEqual({ type: 'input_video', input_video: { url: 'https://example.com/v.mp4' } });
      expect(body.messages[0].content[2]).toEqual({ type: 'video_url', video_url: { url: 'https://example.com/b.mp4' } });
      expect(body.tools).toBeUndefined();
    });

    it('still strips images before sending models without vision capability', async () => {
      const textOnlyProvider = { ...provider, capability: { vision: false, tools: true, thinking: true } };
      const messages = [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/old.png' } }] },
        { role: 'assistant', content: 'seen' },
        { role: 'user', content: '1' },
        { role: 'assistant', content: '2' },
        { role: 'user', content: '3' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: '继续聊,不要看旧图' },
      ];
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({ provider: textOnlyProvider, messages }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.messages[0].content[0]).toEqual({ type: 'text', text: '[earlier image omitted]' });
    });

    it('does not send tool schema to providers that explicitly disable tool support', async () => {
      const noToolProvider = {
        id: 'mimo-multimodal',
        endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: 'sk-mimo',
        model: 'mimo-v2.5',
        capability: { vision: true, audio: true, video: true, tools: false, thinking: true },
        default_thinking: true,
      };
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'ok' }), sseDone())));
      await drain(callOpenAI({
        provider: noToolProvider,
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }],
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });
  });
});


describe('GLM cloud review reasoning defaults', () => {
  it.each([[undefined, 'low'], ['auto', 'low'], ['high', 'high']])('preserves requested effort %s while bounding the default', async (effort, expected) => {
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: '核验完成' }), sseDone())));
    await drain(callOpenAI({ provider: { ...getProvider('glm-coding'), apiKey: 'test-only' }, messages: [{ role: 'user', content: '复查回答' }], reasoningEffort: effort }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe(expected);
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });
});
