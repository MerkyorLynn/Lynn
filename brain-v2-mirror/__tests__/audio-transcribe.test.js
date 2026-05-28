// Brain v2 · Audio Transcribe Fallback tests
//
// Style follows tests/STYLE.md: English describe/it names, vi.spyOn for
// boundary mocks, vi.restoreAllMocks() in afterEach. Behavior coverage is
// the same 16 cases as before — only the structure is aligned to the
// shared style contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAudioTranscribe,
  createAudioRequestCache,
  __testing__,
} from '../audio-transcribe.js';

const providerMimo = {
  id: 'mimo',
  endpoint: 'https://example.com/v1',
  apiKey: 'k',
  model: 'mimo-v2.5-pro',
  capability: { vision: true, audio: true, video: true, tools: true, thinking: true, native_search: true },
  wire: 'mimo',
  cooldown_ms: 300_000,
  default_thinking: true,
};

const providerSpark = {
  id: 'apex-spark-i-balanced',
  endpoint: 'http://127.0.0.1:18098/v1',
  apiKey: 'none',
  model: 'qwen36-35b-a3b-apex-mtp',
  capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
  wire: 'openai',
  cooldown_ms: 300_000,
  default_thinking: false,
};

const msgsAudioB64 = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '听这个音频' },
      { type: 'input_audio', input_audio: { data: 'BASE64AUDIO', format: 'mp3' } },
    ],
  },
];

const msgsAudioUrl = [
  {
    role: 'user',
    content: [{ type: 'audio_url', audio_url: { url: 'https://example.com/x.mp3' } }],
  },
];

const msgsPlain = [{ role: 'user', content: 'just text' }];

function whisperJsonResponse(text = 'transcribed text') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ text }),
    text: async () => JSON.stringify({ text }),
  };
}

function clearAudioEnv() {
  delete process.env.BRAIN_V2_AUDIO_FALLBACK;
  delete process.env.LYNN_WHISPER_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE;
}

describe('extractAudioParts', () => {
  it('finds input_audio parts in user messages', () => {
    const refs = __testing__.extractAudioParts(msgsAudioB64);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual(expect.objectContaining({ kind: 'b64', format: 'mp3' }));
  });

  it('finds audio_url parts', () => {
    const refs = __testing__.extractAudioParts(msgsAudioUrl);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual(expect.objectContaining({ kind: 'url', url: 'https://example.com/x.mp3' }));
  });

  it('ignores audio parts in non-user messages', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'audio_url', audio_url: { url: 'https://x' } }] },
    ];
    expect(__testing__.extractAudioParts(msgs)).toHaveLength(0);
  });

  it('returns empty list for plain text user messages', () => {
    expect(__testing__.extractAudioParts(msgsPlain)).toHaveLength(0);
  });
});

describe('replaceAudioPart', () => {
  it('replaces a single audio part with a text transcript and keeps siblings intact', () => {
    const ref = { mi: 0, pi: 1, kind: 'b64', data: 'X' };
    const next = __testing__.replaceAudioPart(msgsAudioB64, ref, 'this is a transcript');

    expect(next).not.toBe(msgsAudioB64);
    expect(next[0].content[1]).toEqual({
      type: 'text',
      text: expect.stringContaining('this is a transcript'),
    });
    expect(next[0].content[1].text).toContain('[Audio Transcript]');
    expect(next[0].content[0]).toEqual({ type: 'text', text: '听这个音频' });
  });
});

describe('applyAudioTranscribe gating', () => {
  beforeEach(() => {
    clearAudioEnv();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAudioEnv();
  });

  it('skips when the feature flag is off', async () => {
    process.env.OPENAI_API_KEY = 'k';
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
    });
    expect(result.meta).toEqual({ applied: false, skipReason: 'flag-off' });
    expect(result.messages).toBe(msgsAudioB64);
  });

  it('skips when the provider already has native audio', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'k';
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerMimo,
      requestCache: createAudioRequestCache(),
    });
    expect(result.meta).toEqual({ applied: false, skipReason: 'provider-native-audio' });
  });

  it('skips when no audio content is present', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'k';
    const result = await applyAudioTranscribe({
      messages: msgsPlain,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
    });
    expect(result.meta).toEqual({ applied: false, skipReason: 'no-audio-content' });
  });

  it('reports all-failed when no whisper backend is configured', async () => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(result.meta.applied).toBe(false);
    expect(result.meta.skipReason).toBe('all-failed');
  });
});

describe('applyAudioTranscribe applied path', () => {
  beforeEach(() => {
    process.env.BRAIN_V2_AUDIO_FALLBACK = '1';
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAudioEnv();
  });

  it('transcribes a base64 audio part and replaces it with a text transcript', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toContain('/audio/transcriptions');
      return whisperJsonResponse('hello world');
    });
    const cache = createAudioRequestCache();
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: cache,
      log: () => {},
    });

    expect(result.meta.applied).toBe(true);
    expect(result.meta.transcripts).toBe(1);
    expect(result.meta.total).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const call = fetchSpy.mock.calls[0];
    const init = call[1];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(typeof init.body).not.toBe('string');

    expect(result.messages[0].content[1].type).toBe('text');
    expect(result.messages[0].content[1].text).toContain('hello world');
  });

  it('per-request cache reuses transcripts without re-hitting whisper', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(whisperJsonResponse('cached'));
    const cache = createAudioRequestCache();
    await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: cache,
      log: () => {},
    });
    await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: cache,
      log: () => {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honors LYNN_WHISPER_URL custom endpoint without OpenAI auth header', async () => {
    process.env.LYNN_WHISPER_URL = 'http://local-whisper:8000/v1';
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(whisperJsonResponse('ok'));
    await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('http://local-whisper:8000/v1/audio/transcriptions');
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('treats whisper HTTP failure as all-failed without throwing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'oops',
      json: async () => ({}),
    });
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(result.meta.applied).toBe(false);
    expect(result.meta.skipReason).toBe('all-failed');
    expect(result.messages).toBe(msgsAudioB64);
  });

  it('treats an empty whisper transcript as all-failed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(whisperJsonResponse('   '));
    const result = await applyAudioTranscribe({
      messages: msgsAudioB64,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(result.meta.applied).toBe(false);
    expect(result.meta.skipReason).toBe('all-failed');
  });

  it('handles multiple audio parts with partial transcription success', async () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: 'AAA', format: 'mp3' } },
          { type: 'input_audio', input_audio: { data: 'BBB', format: 'wav' } },
        ],
      },
    ];
    let callCount = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return whisperJsonResponse('first');
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'fail' };
    });
    const result = await applyAudioTranscribe({
      messages: msgs,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(result.meta.applied).toBe(true);
    expect(result.meta.transcripts).toBe(1);
    expect(result.meta.total).toBe(2);
    expect(result.messages[0].content[0].type).toBe('text');
    expect(result.messages[0].content[1].type).toBe('input_audio');
  });

  it('decodes data:audio/...;base64 URLs without an extra network round-trip', async () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'audio_url',
            audio_url: { url: 'data:audio/mpeg;base64,SGVsbG8=' },
          },
        ],
      },
    ];
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(whisperJsonResponse('decoded'));
    const result = await applyAudioTranscribe({
      messages: msgs,
      provider: providerSpark,
      requestCache: createAudioRequestCache(),
      log: () => {},
    });
    expect(result.meta.applied).toBe(true);
    // Only the whisper transcription call, no separate audio download
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
