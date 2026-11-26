import { useStore } from '../stores';
import { isChineseLocale } from '../utils/locale';

/** Inline zh/en picker for playback errors. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);
import { PcmPlayer } from './audio-playback';

export type TtsStreamPlaybackController = {
  stop: () => void;
  finished: Promise<void>;
};

export interface PlayTtsSpeechStreamOptions {
  text: string;
  voice?: string;
  speed?: number;
  filename?: string;
  timeoutMs?: number;
}

type WavStreamFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
};
type Bytes = Uint8Array<ArrayBufferLike>;

const TARGET_SAMPLE_RATE = 16_000;

function concatBytes(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function ascii(bytes: Bytes, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function readU16(bytes: Bytes, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Bytes, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function parseWavStreamHeader(bytes: Bytes): WavStreamFormat | null {
  if (bytes.length < 44) return null;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WAVE') {
    return {
      sampleRate: 22_050,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 0,
    };
  }

  let sampleRate = 22_050;
  let channels = 1;
  let bitsPerSample = 16;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, offset + 4);
    const chunkSize = readU32(bytes, offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'fmt ' && dataStart + 16 <= bytes.length) {
      channels = Math.max(1, readU16(bytes, dataStart + 2));
      sampleRate = readU32(bytes, dataStart + 4) || sampleRate;
      bitsPerSample = readU16(bytes, dataStart + 14) || bitsPerSample;
    } else if (chunkId === 'data') {
      return { sampleRate, channels, bitsPerSample, dataOffset: dataStart };
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return null;
}

function pcmBytesToMonoInt16(bytes: Bytes, channels: number): Int16Array {
  const frameSize = Math.max(1, channels) * 2;
  const frames = Math.floor(bytes.length / frameSize);
  const out = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const offset = frame * frameSize + ch * 2;
      const value = (bytes[offset] | (bytes[offset + 1] << 8));
      sum += value >= 0x8000 ? value - 0x10000 : value;
    }
    out[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }
  return out;
}

function resampleInt16Mono(input: Int16Array, fromRate: number, toRate = TARGET_SAMPLE_RATE): Int16Array {
  if (!input.length || !fromRate || fromRate === toRate) return input;
  const outLength = Math.max(1, Math.round(input.length * toRate / fromRate));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * fromRate / toRate;
    const i0 = Math.min(input.length - 1, Math.floor(src));
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(input[i0] + (input[i1] - input[i0]) * t)));
  }
  return out;
}

function createAuthorizedFetchInit(body: unknown, signal: AbortSignal): RequestInit {
  const { serverToken } = useStore.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (serverToken) headers.Authorization = `Bearer ${serverToken}`;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  };
}

export async function playTtsSpeechStream({
  text,
  voice,
  speed,
  filename,
  timeoutMs = 70_000,
}: PlayTtsSpeechStreamOptions): Promise<TtsStreamPlaybackController> {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error(D('没有可朗读的文本', 'There is no text to read aloud'));

  const { serverPort } = useStore.getState();
  const abort = new AbortController();
  const player = new PcmPlayer();
  let stopped = false;
  let streamDone = false;
  let totalEnqueuedSamples = 0;
  let resolveFinished: () => void = () => {};

  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const finish = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    void player.flush().catch(() => {}).finally(() => {
      player.destroy();
      resolveFinished();
    });
  };

  await player.init((stats) => {
    if (streamDone && stats.totalConsumed >= totalEnqueuedSamples) {
      finish();
    }
  });

  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${serverPort}/api/plugins/tts-bridge/audio/speech/stream`,
      createAuthorizedFetchInit({ text: trimmed.slice(0, 3000), voice, speed, filename }, abort.signal),
    );
  } catch (err) {
    player.destroy();
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok || !res.body) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.clone().json() as { error?: string; message?: string; provider?: string };
      detail = [data.error, data.message, data.provider ? `provider=${data.provider}` : ''].filter(Boolean).join(': ') || detail;
    } catch {
      // Keep HTTP status text.
    }
    player.destroy();
    throw new Error(`TTS stream unavailable: ${detail}`);
  }

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  let pcmRemainder: Bytes = new Uint8Array(0);
  let format: WavStreamFormat | null = null;

  const consumePcmBytes = (bytes: Bytes) => {
    const combined = concatBytes(pcmRemainder, bytes);
    const frameSize = Math.max(1, format?.channels || 1) * 2;
    const usableLength = combined.length - (combined.length % frameSize);
    if (usableLength <= 0) {
      pcmRemainder = combined;
      return;
    }
    const pcmBytes = combined.slice(0, usableLength);
    pcmRemainder = combined.slice(usableLength);
    const mono = pcmBytesToMonoInt16(pcmBytes, format?.channels || 1);
    const resampled = resampleInt16Mono(mono, format?.sampleRate || 22_050);
    totalEnqueuedSamples += resampled.length;
    player.enqueue(resampled);
  };

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        if (!value?.length) continue;
        if (!format) {
          pending = concatBytes(pending, value);
          format = parseWavStreamHeader(pending);
          if (!format) continue;
          if (format.bitsPerSample !== 16) {
            throw new Error(`unsupported stream bit depth: ${format.bitsPerSample}`);
          }
          consumePcmBytes(pending.slice(format.dataOffset));
          pending = new Uint8Array(0);
        } else {
          consumePcmBytes(value);
        }
      }
    } catch (err) {
      console.warn('[tts-stream] playback stream failed:', err);
    } finally {
      streamDone = true;
      if (totalEnqueuedSamples === 0) {
        finish();
      } else {
        setTimeout(() => {
          if (!stopped) finish();
        }, Math.max(500, Math.min(30_000, totalEnqueuedSamples / TARGET_SAMPLE_RATE * 1000 + 500)));
      }
    }
  })();

  return { stop: finish, finished };
}
