/**
 * Browser-side Voice WS client for Lynn V0.79 Jarvis Runtime.
 *
 * This is the thin orchestration layer between the AudioWorklet PCM services
 * and the `/voice-ws` binary protocol. UI surfaces can use it without knowing
 * frame opcodes or server auth details.
 */

import { PcmPlayer, type PlaybackStats } from './audio-playback';
import { PcmStream, type PcmStats, type PcmStreamOptions } from './audio-stream';

export const VOICE_FRAME = {
  PCM_AUDIO: 0x01,
  PCM_TTS: 0x02,
  PING: 0x10,
  PONG: 0x11,
  TRANSCRIPT_PARTIAL: 0x12,
  TRANSCRIPT_FINAL: 0x13,
  EMOTION: 0x14,
  STATE_CHANGE: 0x15,
  HEALTH_STATUS: 0x16,
  ASSISTANT_REPLY: 0x17,
  INTERRUPT: 0x20,
  END_OF_TURN: 0x30,
  TEXT_TURN: 0x31,
  SPEAK_TEXT: 0x32,
  // 2026-05-01 P0-① 增量 TTS append 帧:SPEAKING 中往 active queue 末尾推新 segments
  SPEAK_TEXT_APPEND: 0x33,
} as const;

export const VOICE_STATE = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  DEGRADED: 'degraded',
} as const;

export type VoiceState = typeof VOICE_STATE[keyof typeof VOICE_STATE];
export type VoiceFrameType = typeof VOICE_FRAME[keyof typeof VOICE_FRAME];

export interface VoiceFrame {
  type: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
}

export interface VoiceWsClientStats {
  pcmFramesOut: number;
  pcmBytesOut: number;
  ttsFramesIn: number;
  ttsBytesIn: number;
  rttMs: number | null;
}

export interface VoiceProviderHealth {
  name?: string;
  ok: boolean;
  fallbackOk?: boolean;
  degraded?: boolean;
  error?: string;
}

export interface VoiceHealthStatus {
  ok: boolean;
  degraded?: boolean;
  providers?: {
    asr?: VoiceProviderHealth;
    ser?: VoiceProviderHealth;
    tts?: VoiceProviderHealth;
  };
  // DS V4 Pro 反馈 #5 · Phase 2.5 降级编排附加字段(2026-05-01)
  tier?: 1 | 2 | 3 | 4 | 5 | 6;
  orbColor?: 'green' | 'yellow' | 'red';
  tierLabel?: string;
}

export interface VoiceWsClientEvents {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
  onState?: (state: VoiceState | string) => void;
  onTranscriptPartial?: (text: string) => void;
  onTranscriptFinal?: (text: string) => void;
  onAssistantReply?: (text: string) => void;
  onEmotion?: (emotion: unknown) => void;
  onHealth?: (health: VoiceHealthStatus) => void;
  onStats?: (stats: VoiceWsClientStats) => void;
  onCaptureStats?: (stats: PcmStats) => void;
  onPlaybackStats?: (stats: PlaybackStats) => void;
}

type WebSocketLike = {
  binaryType: BinaryType;
  readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
};

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

interface PcmStreamLike {
  start(): Promise<number>;
  stop(): void;
  isRunning(): boolean;
}

interface PcmPlayerLike {
  init(onStats?: (stats: PlaybackStats) => void): Promise<void>;
  enqueue(pcm: Int16Array): void;
  flush(): Promise<void>;
  destroy(): void;
  isInitialized(): boolean;
}

export interface VoiceWsClientOptions extends VoiceWsClientEvents {
  url?: string;
  port?: string | number | null;
  token?: string | null;
  websocketCtor?: WebSocketCtor;
  pcmStream?: PcmStreamLike;
  pcmPlayer?: PcmPlayerLike;
  pcmStreamFactory?: (opts: PcmStreamOptions) => PcmStreamLike;
  pcmPlayerFactory?: () => PcmPlayerLike;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  stopCaptureOnEndTurn?: boolean;
  mode?: 'direct' | 'chat';
}

const WS_OPEN = 1;
const decoder = new TextDecoder();

export function resolveVoiceWsUrl(port?: string | number | null, mode?: 'direct' | 'chat'): string {
  const suffix = mode ? `?mode=${encodeURIComponent(mode)}` : '';
  if (port) return `ws://127.0.0.1:${port}/voice-ws${suffix}`;
  const loc = globalThis.location;
  if (loc?.protocol === 'https:') return `wss://${loc.host}/voice-ws${suffix}`;
  if (loc?.host) return `ws://${loc.host}/voice-ws${suffix}`;
  return `ws://127.0.0.1:3000/voice-ws${suffix}`;
}

export function makeVoiceFrame(type: number, seq: number, payload?: Uint8Array | Int16Array | ArrayBuffer): ArrayBuffer {
  const payloadBytes = toUint8(payload);
  const out = new Uint8Array(4 + payloadBytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, type & 0xff);
  view.setUint8(1, 0);
  view.setUint16(2, seq & 0xffff, false);
  out.set(payloadBytes, 4);
  return out.buffer;
}

export function parseVoiceFrame(data: ArrayBuffer | ArrayBufferView): VoiceFrame | null {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint8(0),
    flags: view.getUint8(1),
    seq: view.getUint16(2, false),
    payload: bytes.slice(4),
  };
}

export function decodeVoiceText(payload: Uint8Array): string {
  return decoder.decode(payload);
}

function toUint8(payload?: Uint8Array | Int16Array | ArrayBuffer): Uint8Array {
  if (!payload) return new Uint8Array(0);
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof Int16Array) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return new Uint8Array(payload);
}

function payloadToInt16(payload: Uint8Array): Int16Array {
  const copy = payload.byteOffset % 2 === 0
    ? payload.slice()
    : new Uint8Array(payload);
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
}

function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err || 'Voice WS error'));
}

export class VoiceWsClient {
  private opts: VoiceWsClientOptions;
  private ws: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private stream: PcmStreamLike | null = null;
  private player: PcmPlayerLike | null = null;
  private seq = 0;
  private state: VoiceState | string = VOICE_STATE.IDLE;
  private pingSentAt = new Map<number, number>();
  private stats: VoiceWsClientStats = {
    pcmFramesOut: 0,
    pcmBytesOut: 0,
    ttsFramesIn: 0,
    ttsBytesIn: 0,
    rttMs: null,
  };

  constructor(opts: VoiceWsClientOptions = {}) {
    this.opts = opts;
    this.stream = opts.pcmStream || null;
    this.player = opts.pcmPlayer || null;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    const WebSocketImpl = this.opts.websocketCtor || globalThis.WebSocket;
    if (!WebSocketImpl) throw new Error('WebSocket is unavailable in this environment');
    this.dropStaleSocket();

    const url = this.opts.url || resolveVoiceWsUrl(this.opts.port, this.opts.mode);
    const protocols = this.opts.token ? ['hana-v1', `token.${this.opts.token}`] : ['hana-v1'];
    const ws = new WebSocketImpl(url, protocols);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      ws.onopen = () => {
        this.opts.onOpen?.();
        settleResolve();
      };
      ws.onerror = () => {
        const err = new Error('Voice WS connection failed');
        this.opts.onError?.(err);
        settleReject(err);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.opts.onClose?.();
        settleReject(new Error('Voice WS connection closed'));
      };
      ws.onmessage = (event) => {
        void this.handleMessage(event).catch((err) => this.opts.onError?.(normalizeError(err)));
      };
    });
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  async startListening(): Promise<void> {
    await this.connect();
    await this.ensurePlayer();
    if (this.state === VOICE_STATE.SPEAKING || this.state === VOICE_STATE.THINKING) {
      await this.interrupt();
    }
    if (!this.stream) {
      const factory = this.opts.pcmStreamFactory || ((opts: PcmStreamOptions) => new PcmStream(opts));
      this.stream = this.opts.pcmStream || factory({
        onPcm: (pcm) => this.sendPcm(pcm),
        onStats: this.opts.onCaptureStats,
        onError: (err) => this.opts.onError?.(err),
        echoCancellation: this.opts.echoCancellation ?? true,
        noiseSuppression: this.opts.noiseSuppression ?? true,
        autoGainControl: this.opts.autoGainControl ?? true,
      });
    }
    if (!this.stream.isRunning()) await this.stream.start();
  }

  async endTurn(): Promise<boolean> {
    const sent = this.sendFrame(VOICE_FRAME.END_OF_TURN);
    if (this.opts.stopCaptureOnEndTurn !== false) {
      this.stream?.stop();
    }
    return sent;
  }

  async sendTextTurn(text: string): Promise<void> {
    await this.connect();
    const payload = new TextEncoder().encode(String(text || '').trim());
    this.sendFrame(VOICE_FRAME.TEXT_TURN, payload);
  }

  async speakText(text: string): Promise<void> {
    await this.connect();
    const payload = new TextEncoder().encode(String(text || '').trim());
    if (!this.sendFrame(VOICE_FRAME.SPEAK_TEXT, payload)) {
      throw new Error('Voice WS connection closed before speech request');
    }
  }

  /**
   * 2026-05-01 P0-① — 增量 TTS append。
   *
   * 当前在 SPEAKING 时:把新 segment 推到 server-side activeSpeakingQueue 末尾。
   * 当前 IDLE/其他态:server 自动当 fresh speakText 处理(向后兼容)。
   *
   * 用法(典型):JarvisRuntimeOverlay 订阅 chat WS 的 text_delta,见到句尾标点
   * 立刻吐一段。第一段调 speakText,后续段调 speakTextAppend。
   */
  async speakTextAppend(text: string): Promise<void> {
    const value = String(text || '').trim();
    if (!value) return;
    await this.connect();
    const payload = new TextEncoder().encode(value);
    if (!this.sendFrame(VOICE_FRAME.SPEAK_TEXT_APPEND, payload)) {
      throw new Error('Voice WS connection closed before speech append');
    }
  }

  async interrupt(): Promise<boolean> {
    const sent = this.sendFrame(VOICE_FRAME.INTERRUPT);
    await this.player?.flush();
    return sent;
  }

  sendPcm(pcm: Int16Array): void {
    if (!this.sendFrame(VOICE_FRAME.PCM_AUDIO, pcm)) return;
    this.stats.pcmFramesOut++;
    this.stats.pcmBytesOut += pcm.byteLength;
    this.emitStats();
  }

  ping(): void {
    const seq = this.nextSeq();
    this.pingSentAt.set(seq, performance.now());
    if (!this.sendRaw(makeVoiceFrame(VOICE_FRAME.PING, seq))) {
      this.pingSentAt.delete(seq);
    }
  }

  stopCapture(): void {
    this.stream?.stop();
  }

  async disconnect(): Promise<void> {
    this.stream?.stop();
    await this.player?.flush();
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
  }

  destroy(): void {
    this.stream?.stop();
    this.player?.destroy();
    this.ws?.close();
    this.stream = null;
    this.player = null;
    this.ws = null;
    this.connectPromise = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  getStats(): VoiceWsClientStats {
    return { ...this.stats };
  }

  getState(): VoiceState | string {
    return this.state;
  }

  private async ensurePlayer(): Promise<PcmPlayerLike> {
    if (!this.player) {
      const factory = this.opts.pcmPlayerFactory || (() => new PcmPlayer());
      this.player = this.opts.pcmPlayer || factory();
    }
    if (!this.player.isInitialized()) {
      await this.player.init(this.opts.onPlaybackStats);
    }
    return this.player;
  }

  private sendFrame(type: VoiceFrameType, payload?: Uint8Array | Int16Array | ArrayBuffer): boolean {
    return this.sendRaw(makeVoiceFrame(type, this.nextSeq(), payload));
  }

  private sendRaw(frame: ArrayBuffer): boolean {
    if (!this.isConnected()) return false;
    try {
      this.ws!.send(frame);
      return true;
    } catch (err) {
      this.opts.onError?.(normalizeError(err));
      return false;
    }
  }

  private dropStaleSocket(): void {
    if (!this.ws || this.isConnected()) return;
    const stale = this.ws;
    this.ws = null;
    try {
      stale.close();
    } catch {
      // ignored: closing a stale browser WebSocket is best-effort.
    }
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    return seq;
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (!(event.data instanceof ArrayBuffer) && !ArrayBuffer.isView(event.data)) return;
    const frame = parseVoiceFrame(event.data);
    if (!frame) return;

    switch (frame.type) {
      case VOICE_FRAME.PCM_TTS: {
        const player = await this.ensurePlayer();
        player.enqueue(payloadToInt16(frame.payload));
        this.stats.ttsFramesIn++;
        this.stats.ttsBytesIn += frame.payload.byteLength;
        this.emitStats();
        break;
      }
      case VOICE_FRAME.STATE_CHANGE:
        this.state = decodeVoiceText(frame.payload);
        if (this.opts.stopCaptureOnEndTurn !== false && this.state !== VOICE_STATE.LISTENING) {
          this.stream?.stop();
        }
        this.opts.onState?.(this.state);
        break;
      case VOICE_FRAME.TRANSCRIPT_PARTIAL:
        this.opts.onTranscriptPartial?.(decodeVoiceText(frame.payload));
        break;
      case VOICE_FRAME.TRANSCRIPT_FINAL:
        this.opts.onTranscriptFinal?.(decodeVoiceText(frame.payload));
        break;
      case VOICE_FRAME.ASSISTANT_REPLY:
        this.opts.onAssistantReply?.(decodeVoiceText(frame.payload));
        break;
      case VOICE_FRAME.EMOTION:
        this.opts.onEmotion?.(JSON.parse(decodeVoiceText(frame.payload)));
        break;
      case VOICE_FRAME.HEALTH_STATUS:
        this.opts.onHealth?.(JSON.parse(decodeVoiceText(frame.payload)) as VoiceHealthStatus);
        break;
      case VOICE_FRAME.PONG: {
        const sentAt = this.pingSentAt.get(frame.seq);
        if (sentAt !== undefined) {
          this.pingSentAt.delete(frame.seq);
          this.stats.rttMs = performance.now() - sentAt;
          this.emitStats();
        }
        break;
      }
      default:
        break;
    }
  }

  private emitStats(): void {
    this.opts.onStats?.({ ...this.stats });
  }
}

export async function createVoiceWsClientFromPlatform(opts: Omit<VoiceWsClientOptions, 'port' | 'token'> = {}): Promise<VoiceWsClient> {
  const port = await globalThis.window?.platform?.getServerPort?.();
  const token = await globalThis.window?.platform?.getServerToken?.();
  return new VoiceWsClient({ ...opts, port, token });
}
