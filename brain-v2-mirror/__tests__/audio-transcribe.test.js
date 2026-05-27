// Brain v2 · Audio Transcribe Fallback tests
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAudioTranscribe, createAudioRequestCache, __testing__ } from '../audio-transcribe.js';

const providerMimo = {
  id: 'mimo',
  capability: { vision: true, audio: true, video: true, tools: true, thinking: true, native_search: true },
};

const providerSpark = {
  id: 'apex-spark-i-balanced',
  capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
};

const msgsAudioB64 = [
  { role: 'user', content: [
    { type: 'text', text: '听这个音频' },
    { type: 'input_audio', input_audio: { data: 'BASE64AUDIO', format: 'mp3' } },
  ]},
];

const msgsAudioUrl = [
  { role: 'user', content: [
    { type: 'audio_url', audio_url: { url: 'https://example.com/x.mp3' } },
  ]},
];

const msgsPlain = [{ role: 'user', content: 'just text' }];

let origFetch;

beforeEach(() => {
  origFetch = global.fetch;
  delete process.env.BRAIN_V2_AUDIO_FALLBACK;
  delete process.env.LYNN_WHISPER_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE;
});
afterEach(() => {
  global.fetch = origFetch;
  delete process.env.BRAIN_V2_AUDIO_FALLBACK;
  delete process.env.LYNN_WHISPER_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE;
});

describe('extractAudioParts', () => {
  it('finds input_audio parts in user messages', () => {
    const refs = __testing__.extractAudioParts(msgsAudioB64);
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe('b64');
    expect(refs[0].format).toBe('mp3');
  });

  it('finds audio_url parts', () => {
    const refs = __testing__.extractAudioParts(msgsAudioUrl);
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe('url');
    expect(refs[0].url).toBe('https://example.com/x.mp3');
  });

  it('ignores audio parts in non-user messages', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'audio_url', audio_url: { url: 'https://x' } }] },
    ];
    expect(__testing__.extractAudioParts(msgs).length).toBe(0);
  });

  it('returns empty for plain text', () => {
    expect(__testing__.extractAudioParts(msgsPlain).length).toBe(0);
  });
});

describe('replaceAudioPart', () => {
  it('replaces single audio part with text', () => {
    const ref = { mi: 0, pi: 1, kind: 'b64', data: 'X' };
    const out = __testing__.replaceAudioPart(msgsAudioB64, ref, 'this is a transcript');
    expect(out).not.toBe(msgsAudioB64);
    expect(out[0].content[1].type).toBe('text');
    expect(out[0].content[1].text).toContain('this is a transcript');
    expect(out[0].content[1].text).toContain('[Audio Transcript]');
    // 原 text part 不动
    expect(out[0].content[0].type).toBe('text');
    expect(out[0].content[0].text).toBe('听这个音频');
  });
});

describe('applyAudioTranscribe — gating', () => {
  it('skips when flag off', async () => {
    process.env.OPENAI_API_KEY = 'k';
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: createAudioRequestCache(),
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('flag-off');
    expect(r.messages).toBe(msgsAudioB64);
  });

  it('skips when provider has native audio (mimo)', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'k';
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerMimo, requestCache: createAudioRequestCache(),
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('provider-native-audio');
  });

  it('skips when no audio content', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'k';
    const r = await applyAudioTranscribe({
      messages: msgsPlain, provider: providerSpark, requestCache: createAudioRequestCache(),
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('no-audio-content');
  });

  it('skips with all-failed when no backend configured', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    // 不设 LYNN_WHISPER_URL / OPENAI_API_KEY
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('all-failed');
  });
});

describe('applyAudioTranscribe — applied path', () => {
  beforeEach(() => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  it('transcribes single base64 audio and replaces part with text', async () => {
    global.fetch = vi.fn(async (url) => {
      expect(url).toContain('/audio/transcriptions');
      return {
        ok: true, status: 200,
        json: async () => ({ text: 'hello world' }),
        text: async () => '{"text":"hello world"}',
      };
    });
    const cache = createAudioRequestCache();
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: cache, log: () => {},
    });
    expect(r.meta.applied).toBe(true);
    expect(r.meta.transcripts).toBe(1);
    expect(r.meta.total).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // 验证 fetch 是 multipart(FormData)
    const init = global.fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    // body 是 FormData,不是 string
    expect(typeof init.body).not.toBe('string');
    // 验证 messages 已替换
    expect(r.messages[0].content[1].type).toBe('text');
    expect(r.messages[0].content[1].text).toContain('hello world');
  });

  it('per-request cache: 2nd call reuses transcription without re-fetching', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ text: 'cached' }),
      text: async () => '{"text":"cached"}',
    }));
    const cache = createAudioRequestCache();
    await applyAudioTranscribe({ messages: msgsAudioB64, provider: providerSpark, requestCache: cache, log: () => {} });
    await applyAudioTranscribe({ messages: msgsAudioB64, provider: providerSpark, requestCache: cache, log: () => {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('honors LYNN_WHISPER_URL custom endpoint(no OPENAI auth)', async () => {
    process.env.LYNN_WHISPER_URL = 'http://local-whisper:8000/v1';
    let captured;
    global.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ text: 'ok' }), text: async () => '' };
    });
    await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: createAudioRequestCache(), log: () => {},
    });
    expect(captured.url).toBe('http://local-whisper:8000/v1/audio/transcriptions');
    // 自定义 endpoint 不带 OpenAI Authorization
    expect(captured.init.headers?.Authorization).toBeUndefined();
  });

  it('whisper HTTP failure → applied=false, original messages, no throw', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'oops', json: async () => ({}),
    }));
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: createAudioRequestCache(), log: () => {},
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('all-failed');
    expect(r.messages).toBe(msgsAudioB64);
  });

  it('empty transcript → applied=false', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ text: '   ' }), text: async () => '',
    }));
    const r = await applyAudioTranscribe({
      messages: msgsAudioB64, provider: providerSpark, requestCache: createAudioRequestCache(), log: () => {},
    });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('all-failed');
  });

  it('handles multiple audio parts (partial success counted)', async () => {
    const msgs = [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'AAA', format: 'mp3' } },
        { type: 'input_audio', input_audio: { data: 'BBB', format: 'wav' } },
      ],
    }];
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => ({ text: 'first' }), text: async () => '' };
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'fail' };
    });
    const r = await applyAudioTranscribe({
      messages: msgs, provider: providerSpark, requestCache: createAudioRequestCache(), log: () => {},
    });
    expect(r.meta.applied).toBe(true);
    expect(r.meta.transcripts).toBe(1);
    expect(r.meta.total).toBe(2);
    // 第一个 part 替换为 text,第二个保留原 audio(失败的 ref 不动)
    expect(r.messages[0].content[0].type).toBe('text');
    expect(r.messages[0].content[1].type).toBe('input_audio');
  });

  it('parses data:audio/mpeg;base64,... URL form', async () => {
    const msgs = [{
      role: 'user',
      content: [{
        type: 'audio_url',
        audio_url: { url: 'data:audio/mpeg;base64,SGVsbG8=' },
      }],
    }];
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ text: 'decoded' }), text: async () => '',
    }));
    const r = await applyAudioTranscribe({
      messages: msgs, provider: providerSpark, requestCache: createAudioRequestCache(), log: () => {},
    });
    expect(r.meta.applied).toBe(true);
    // data URI 是同 process 内 decode,不应触发外部 fetch fetchAudioBuffer
    // (但 transcribe 那次 fetch 还是会发)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
