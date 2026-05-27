// @ts-nocheck
// Brain v2 · Audio Transcribe Fallback Middleware
//
// 当 router 选中的 provider 不支持原生 audio(capability.audio === false),但 messages
// 含 audio content part 时,brain 端用 Whisper 把 audio 转录成文本,把 audio part 替换为
// 文本段后继续 forward。这样 MiMo audio 挂了的情况下,Spark/DeepSeek 也能"听懂"音频
// (信息量损失但不阻断,符合"失败降级保底"原则)。
//
// 设计要点(对齐 search-context.ts 模式):
//   - feature flag: BRAIN_V2_AUDIO_FALLBACK=1,默认 OFF
//   - 仅在 provider.capability.audio === false && messages 含 audio 时触发
//   - MiMo 自带 audio:true,跳过(原生处理质量更好)
//   - 失败不阻断:transcribe 挂了 → 返回原 messages → adapter 自己面对(可能 400)
//   - per-request 缓存(audio 数据哈希为 key),fallback 链不重复转录
//
// Whisper backend(按优先级):
//   1. LYNN_WHISPER_URL — 自定义 endpoint(faster-whisper / sensevoice 兼容
//      OpenAI Whisper API:POST /audio/transcriptions multipart file → { text })
//   2. OpenAI Whisper API — OPENAI_API_KEY + OPENAI_BASE(默认 api.openai.com/v1)
//   3. 都没配 → log warn → 返回原 messages
//
// 不做的事情:
//   - 不修改 audio capability gate(由 router 控制,中间件只在 provider 不支持时介入)
//   - 不对 video content 降级(无现成 video→text 通用方案,留 TODO)
//   - 不替换 system / assistant message 的 audio part(只转 user 消息)

import { createHash } from 'node:crypto';

const FLAG = 'BRAIN_V2_AUDIO_FALLBACK';
const WHISPER_URL_ENV = 'LYNN_WHISPER_URL';
const OPENAI_KEY_ENV = 'OPENAI_API_KEY';
const OPENAI_BASE_ENV = 'OPENAI_BASE';

export function createAudioRequestCache() {
  return new Map();
}

function hashAudioRef(audioRef) {
  return createHash('sha256').update(String(audioRef)).digest('hex').slice(0, 32);
}

function extractAudioParts(messages) {
  const refs = [];
  if (!Array.isArray(messages)) return refs;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (let pi = 0; pi < c.length; pi++) {
      const part = c[pi];
      if (!part || typeof part !== 'object') continue;
      const t = part.type;
      if (t === 'input_audio') {
        // OpenAI 标准:{ data: base64, format: 'mp3'|'wav'|... }
        const data = part.input_audio?.data;
        const format = part.input_audio?.format || 'mp3';
        if (data) refs.push({ mi, pi, kind: 'b64', data, format });
      } else if (t === 'audio_url') {
        const url = typeof part.audio_url === 'string' ? part.audio_url : part.audio_url?.url;
        if (url) refs.push({ mi, pi, kind: 'url', url });
      }
    }
  }
  return refs;
}

async function fetchAudioBuffer(ref) {
  if (ref.kind === 'b64') {
    return { buffer: Buffer.from(ref.data, 'base64'), filename: `audio.${ref.format}`, mime: `audio/${ref.format}` };
  }
  if (ref.kind === 'url') {
    // 支持 data: URI 和 http(s)
    if (ref.url.startsWith('data:')) {
      const m = ref.url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('audio data URI parse failed');
      const mime = m[1];
      const ext = mime.split('/')[1] || 'mp3';
      return { buffer: Buffer.from(m[2], 'base64'), filename: `audio.${ext}`, mime };
    }
    const r = await fetch(ref.url);
    if (!r.ok) throw new Error(`fetch audio HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || 'audio/mpeg';
    const ext = mime.split('/')[1]?.split(';')[0] || 'mp3';
    return { buffer: buf, filename: `audio.${ext}`, mime };
  }
  throw new Error('unknown audio ref kind');
}

/**
 * 调用 Whisper-compat API。
 * 优先 LYNN_WHISPER_URL,fallback 到 OpenAI Whisper API。
 * 期望 endpoint 兼容 OpenAI:POST /audio/transcriptions multipart,form field 'file'
 * + 'model'(可选)→ JSON { text }。
 */
async function transcribeViaWhisper({ buffer, filename, mime }, signal) {
  const customUrl = process.env[WHISPER_URL_ENV] || '';
  let endpoint;
  let headers = {};

  if (customUrl) {
    endpoint = customUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  } else if (process.env[OPENAI_KEY_ENV]) {
    const base = (process.env[OPENAI_BASE_ENV] || 'https://api.openai.com/v1').replace(/\/+$/, '');
    endpoint = base + '/audio/transcriptions';
    headers.Authorization = 'Bearer ' + process.env[OPENAI_KEY_ENV];
  } else {
    throw new Error('no whisper backend configured (set LYNN_WHISPER_URL or OPENAI_API_KEY)');
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  const res = await fetch(endpoint, { method: 'POST', headers, body: form, signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`whisper HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('whisper empty transcript');
  return text;
}

function replaceAudioPart(messages, ref, transcript) {
  // Deep clone 浅层(只动我们要改的 part)
  const newMessages = messages.map((m, mi) => {
    if (mi !== ref.mi) return m;
    const newContent = m.content.map((part, pi) => {
      if (pi !== ref.pi) return part;
      return {
        type: 'text',
        text: `[Audio Transcript]\n${transcript}\n[/Audio Transcript]`,
      };
    });
    return { ...m, content: newContent };
  });
  return newMessages;
}

/**
 * 中间件入口。返回 { messages: 原 or 替换后, meta }。
 * meta.applied === true 时,caller(router)可以 emit audio_fallback SSE chunk
 * 让 UI 显示"已用 Whisper 转录"。
 */
export async function applyAudioTranscribe(opts) {
  const { messages, provider, signal, log, requestCache } = opts;

  // 1. Feature flag
  if (process.env[FLAG] !== '1') {
    return { messages, meta: { applied: false, skipReason: 'flag-off' } };
  }

  // 2. Provider 已有原生 audio → 不降级
  if (provider?.capability?.audio) {
    return { messages, meta: { applied: false, skipReason: 'provider-native-audio' } };
  }

  // 3. 提取 audio refs
  const refs = extractAudioParts(messages);
  if (refs.length === 0) {
    return { messages, meta: { applied: false, skipReason: 'no-audio-content' } };
  }

  // 4. 转录(逐个,带 per-request 缓存)
  let workingMessages = messages;
  let transcripts = 0;
  const t0 = Date.now();
  const usedSources = [];

  for (const ref of refs) {
    const key = hashAudioRef(ref.kind === 'b64' ? ref.data : ref.url);
    let text = null;
    if (requestCache && requestCache.has(key)) {
      text = requestCache.get(key);
      usedSources.push('cache');
    } else {
      try {
        const audio = await fetchAudioBuffer(ref);
        text = await transcribeViaWhisper(audio, signal);
        if (requestCache) requestCache.set(key, text);
        usedSources.push(process.env[WHISPER_URL_ENV] ? 'whisper-custom' : 'openai-whisper');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log && log('warn', `audio-transcribe: failed ref kind=${ref.kind}: ${msg.slice(0, 200)}`);
        continue; // 跳过这个 ref,留原 audio part(adapter 自己处理)
      }
    }
    if (!text) continue;
    workingMessages = replaceAudioPart(workingMessages, ref, text);
    transcripts++;
  }

  const ms = Date.now() - t0;
  if (transcripts === 0) {
    return {
      messages,
      meta: { applied: false, skipReason: 'all-failed', attempted: refs.length, ms },
    };
  }

  log && log('info', `audio-transcribe: replaced ${transcripts}/${refs.length} audio parts (${ms}ms, sources=${usedSources.join(',')})`);
  return {
    messages: workingMessages,
    meta: { applied: true, transcripts, total: refs.length, ms, source: usedSources[0] },
  };
}

// for tests
export const __testing__ = {
  extractAudioParts,
  replaceAudioPart,
  hashAudioRef,
  fetchAudioBuffer,
  transcribeViaWhisper,
};
