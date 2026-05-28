// Brain v2 · Audio Transcribe Fallback Middleware
//
// Pre-call middleware that transcribes user audio when the selected provider
// has no native audio capability. The audio parts are replaced with text
// transcripts so non-audio providers (Spark, DeepSeek, GLM) can still answer
// the user. MiMo and other native_audio providers bypass this middleware.
//
// Design constraints:
//   - feature flag: BRAIN_V2_AUDIO_FALLBACK=1 (default off)
//   - only triggers when provider.capability.audio === false AND messages
//     contain audio content
//   - Whisper backend priority: LYNN_WHISPER_URL > OPENAI_API_KEY > skip
//   - per-request cache (sha256 of audio data) so fallback chain doesn't
//     transcribe the same clip twice
//   - failure is non-blocking: transcription error returns original messages
//     so the adapter still sees what the caller provided
//
// Reference: docs/ops/multi-cli-collaboration-guide.md calls this file out as
// the reference pattern for replacing @ts-nocheck with explicit types.

import { createHash } from 'node:crypto';
import type { ChatMessage, LogFn, Provider } from './types.js';

const AUDIO_FALLBACK_FLAG = 'BRAIN_V2_AUDIO_FALLBACK';
const WHISPER_URL_ENV = 'LYNN_WHISPER_URL';
const OPENAI_KEY_ENV = 'OPENAI_API_KEY';
const OPENAI_BASE_ENV = 'OPENAI_BASE';

// ── public types ─────────────────────────────────────────────────────────
export type AudioRequestCache = Map<string, string>;

export type WhisperSource = 'lynn-whisper' | 'openai-whisper' | 'cache';

export type AudioTranscribeSkipReason =
  | 'flag-off'
  | 'provider-native-audio'
  | 'no-audio-content'
  | 'all-failed';

export type AudioTranscribeMeta =
  | {
      applied: true;
      source: WhisperSource;
      transcripts: number;
      total: number;
      ms: number;
    }
  | {
      applied: false;
      skipReason: AudioTranscribeSkipReason;
      attempted?: number;
      ms?: number;
    };

export interface ApplyAudioTranscribeOptions {
  messages?: ChatMessage[];
  provider?: Provider | null;
  signal?: AbortSignal;
  log?: LogFn | null;
  requestCache?: AudioRequestCache;
}

export interface ApplyAudioTranscribeResult {
  messages?: ChatMessage[];
  meta: AudioTranscribeMeta;
}

// ── internal types ───────────────────────────────────────────────────────
type AudioRefKind = 'b64' | 'url';

interface AudioRefBase {
  mi: number;
  pi: number;
  kind: AudioRefKind;
}

interface AudioRefB64 extends AudioRefBase {
  kind: 'b64';
  data: string;
  format: string;
}

interface AudioRefUrl extends AudioRefBase {
  kind: 'url';
  url: string;
}

type AudioRef = AudioRefB64 | AudioRefUrl;

interface FetchedAudio {
  buffer: Buffer;
  filename: string;
  mime: string;
}

interface AudioPartObject {
  type?: string;
  input_audio?: { data?: string; format?: string };
  audio_url?: string | { url?: string };
}

// ── helpers ──────────────────────────────────────────────────────────────
export function createAudioRequestCache(): AudioRequestCache {
  return new Map<string, string>();
}

function hashAudioRef(ref: string): string {
  return createHash('sha256').update(ref).digest('hex').slice(0, 32);
}

function extractAudioParts(messages: ChatMessage[] | undefined): AudioRef[] {
  const refs: AudioRef[] = [];
  if (!Array.isArray(messages)) return refs;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (!m || m.role !== 'user') continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi] as AudioPartObject | string | null;
      if (!part || typeof part !== 'object') continue;
      const t = part.type;
      if (t === 'input_audio') {
        const data = part.input_audio?.data;
        const format = part.input_audio?.format || 'mp3';
        if (typeof data === 'string' && data) {
          refs.push({ mi, pi, kind: 'b64', data, format });
        }
      } else if (t === 'audio_url') {
        const audioUrl = part.audio_url;
        const url = typeof audioUrl === 'string' ? audioUrl : audioUrl?.url;
        if (typeof url === 'string' && url) {
          refs.push({ mi, pi, kind: 'url', url });
        }
      }
    }
  }
  return refs;
}

async function fetchAudioBuffer(ref: AudioRef): Promise<FetchedAudio> {
  if (ref.kind === 'b64') {
    return {
      buffer: Buffer.from(ref.data, 'base64'),
      filename: `audio.${ref.format}`,
      mime: `audio/${ref.format}`,
    };
  }
  // url ref
  if (ref.url.startsWith('data:')) {
    const match = ref.url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('audio data URI parse failed');
    const mime = match[1];
    const ext = mime.split('/')[1] || 'mp3';
    return {
      buffer: Buffer.from(match[2], 'base64'),
      filename: `audio.${ext}`,
      mime,
    };
  }
  const response = await fetch(ref.url);
  if (!response.ok) {
    throw new Error(`fetch audio HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = response.headers.get('content-type') || 'audio/mpeg';
  const ext = mime.split('/')[1]?.split(';')[0] || 'mp3';
  return { buffer, filename: `audio.${ext}`, mime };
}

interface WhisperBackendInfo {
  endpoint: string;
  headers: Record<string, string>;
  source: WhisperSource;
}

function resolveWhisperBackend(): WhisperBackendInfo | null {
  const customUrl = process.env[WHISPER_URL_ENV];
  if (customUrl) {
    return {
      endpoint: customUrl.replace(/\/+$/, '') + '/audio/transcriptions',
      headers: {},
      source: 'lynn-whisper',
    };
  }
  const openaiKey = process.env[OPENAI_KEY_ENV];
  if (openaiKey) {
    const base = (process.env[OPENAI_BASE_ENV] || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return {
      endpoint: base + '/audio/transcriptions',
      headers: { Authorization: 'Bearer ' + openaiKey },
      source: 'openai-whisper',
    };
  }
  return null;
}

interface TranscribeResponse {
  text?: string;
}

async function transcribeViaWhisper(
  audio: FetchedAudio,
  signal: AbortSignal | undefined,
): Promise<{ text: string; source: WhisperSource }> {
  const backend = resolveWhisperBackend();
  if (!backend) {
    throw new Error('no whisper backend configured (set LYNN_WHISPER_URL or OPENAI_API_KEY)');
  }
  const form = new FormData();
  form.append('file', new Blob([audio.buffer], { type: audio.mime }), audio.filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  const response = await fetch(backend.endpoint, {
    method: 'POST',
    headers: backend.headers,
    body: form,
    signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`whisper HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = (await response.json()) as TranscribeResponse;
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('whisper empty transcript');
  return { text, source: backend.source };
}

function replaceAudioPart(
  messages: ChatMessage[],
  ref: AudioRef,
  transcript: string,
): ChatMessage[] {
  return messages.map((m, mi) => {
    if (mi !== ref.mi) return m;
    const content = m.content;
    if (!Array.isArray(content)) return m;
    const nextContent = content.map((part, pi) => {
      if (pi !== ref.pi) return part;
      return {
        type: 'text',
        text: `[Audio Transcript]\n${transcript}\n[/Audio Transcript]`,
      };
    });
    return { ...m, content: nextContent };
  });
}

// ── public entry ─────────────────────────────────────────────────────────
/**
 * Apply audio fallback transcription. Called from router runRound before the
 * wire adapter, after the provider has been selected. Returns either the
 * original messages unchanged (with skipReason metadata) or a new messages
 * array with audio parts replaced by text transcripts.
 */
export async function applyAudioTranscribe(
  opts: ApplyAudioTranscribeOptions,
): Promise<ApplyAudioTranscribeResult> {
  const { messages, provider, signal, log, requestCache } = opts;

  if (process.env[AUDIO_FALLBACK_FLAG] !== '1') {
    return { messages, meta: { applied: false, skipReason: 'flag-off' } };
  }
  if (provider?.capability?.audio) {
    return { messages, meta: { applied: false, skipReason: 'provider-native-audio' } };
  }

  const refs = extractAudioParts(messages);
  if (refs.length === 0) {
    return { messages, meta: { applied: false, skipReason: 'no-audio-content' } };
  }

  const startedAt = Date.now();
  let workingMessages: ChatMessage[] = Array.isArray(messages) ? messages : [];
  let transcripts = 0;
  let lastSource: WhisperSource | null = null;
  const sourcesSeen: WhisperSource[] = [];

  for (const ref of refs) {
    const refKey = ref.kind === 'b64' ? ref.data : ref.url;
    const cacheKey = hashAudioRef(refKey);
    let text: string | null = null;
    let source: WhisperSource = 'cache';

    if (requestCache?.has(cacheKey)) {
      text = requestCache.get(cacheKey) || null;
      source = 'cache';
    } else {
      try {
        const audio = await fetchAudioBuffer(ref);
        const result = await transcribeViaWhisper(audio, signal);
        text = result.text;
        source = result.source;
        if (requestCache) requestCache.set(cacheKey, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log?.('warn', `audio-transcribe: ref kind=${ref.kind} failed: ${message.slice(0, 200)}`);
        continue;
      }
    }

    if (!text) continue;
    workingMessages = replaceAudioPart(workingMessages, ref, text);
    transcripts++;
    lastSource = source;
    sourcesSeen.push(source);
  }

  const ms = Date.now() - startedAt;
  if (transcripts === 0 || !lastSource) {
    return {
      messages,
      meta: { applied: false, skipReason: 'all-failed', attempted: refs.length, ms },
    };
  }

  log?.(
    'info',
    `audio-transcribe: replaced ${transcripts}/${refs.length} audio parts (${ms}ms, sources=${sourcesSeen.join(',')})`,
  );
  return {
    messages: workingMessages,
    meta: { applied: true, source: lastSource, transcripts, total: refs.length, ms },
  };
}

// ── test-only exports ───────────────────────────────────────────────────
export const __testing__ = {
  extractAudioParts,
  replaceAudioPart,
  hashAudioRef,
  fetchAudioBuffer,
  transcribeViaWhisper,
  resolveWhisperBackend,
};
