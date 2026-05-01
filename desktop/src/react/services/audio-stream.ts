/**
 * audio-stream.ts — Lynn V0.79 Jarvis Runtime,客户端 PCM 采集
 *
 * 用 AudioWorklet(`/workers/pcm-recorder.worklet.js`)采集 16kHz Int16 PCM,
 * 通过 callback 推到上层(VoiceWS client 等)。
 *
 * Phase 1 范围:基础采集 + WS frame 协议
 * Phase 2 集成:接 native AEC module(`window.platform.aecCreate`),
 *               TTS 播放期 ref signal 喂 AEC,清掉自回声后再发 WS
 *
 * AEC 三档体验承诺(参考 docs/PLAN-v0.79-JARVIS-MODE.md v2.3):
 *   Tier 1 全双工:有 native AEC,echoCancellation: false 浏览器
 *   Tier 2 半双工:无 AEC,echoCancellation: true 浏览器(部分平台 broken,但能 fallback 到 VAD)
 *   Tier 3 PTT:不用此服务,走 V0.78 PressToTalkButton
 */

export interface PcmStats {
  elapsedSec: number;
  totalChunks: number;
  totalSamples: number;
  chunksPerSec: number;
  avgAmplitude: number;
  bufferLag: number;
}

export interface PcmStreamOptions {
  /** 采集回调:每 100ms 一个 chunk(1600 samples @ 16kHz Int16) */
  onPcm: (pcm: Int16Array) => void;
  /** 统计回调:每秒一次 */
  onStats?: (stats: PcmStats) => void;
  /** 错误回调 */
  onError?: (err: Error) => void;
  /**
   * Tier 决定是否开浏览器原生 AEC:
   * - Tier 1 全双工(native AEC 接管):false
   * - Tier 2 半双工(浏览器 AEC 兜底):true
   * - Tier 3 PTT 模式(此 service 不启用)
   */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

function resolveWorkletUrl(path: string): string {
  return new URL(path, window.location.href).href;
}

export class PcmStream {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private opts: PcmStreamOptions;
  private running = false;

  constructor(opts: PcmStreamOptions) {
    this.opts = opts;
  }

  /**
   * 启动采集
   * @returns 设备 sampleRate (通常 48000)
   */
  async start(): Promise<number> {
    if (this.running) return this.audioCtx!.sampleRate;
    this.running = true;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.opts.echoCancellation ?? true,
          noiseSuppression: this.opts.noiseSuppression ?? true,
          autoGainControl: this.opts.autoGainControl ?? true,
          sampleRate: 16000, // hint, not enforced
          channelCount: 1,
        },
      });

      this.audioCtx = new AudioContext({ latencyHint: "interactive" });
      await this.audioCtx.audioWorklet.addModule(resolveWorkletUrl("workers/pcm-recorder.worklet.js"));

      this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-recorder");
      this.workletNode.port.onmessage = (e) => {
        if (e.data?.type === "pcm") {
          this.opts.onPcm(e.data.payload as Int16Array);
        } else if (e.data?.type === "stats") {
          this.opts.onStats?.(e.data as PcmStats);
        }
      };

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.workletNode);
      // 不连 destination,避免 monitor loopback

      return this.audioCtx.sampleRate;
    } catch (err) {
      this.running = false;
      this.opts.onError?.(err as Error);
      throw err;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }
    this.workletNode = null;
    this.sourceNode = null;
    this.audioCtx = null;
    this.mediaStream = null;
  }

  isRunning(): boolean {
    return this.running;
  }
}
