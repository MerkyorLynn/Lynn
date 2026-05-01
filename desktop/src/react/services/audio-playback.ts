/**
 * audio-playback.ts — Lynn V0.79 Jarvis Runtime,流式 PCM 播放
 *
 * 用 AudioWorklet(`/workers/pcm-player.worklet.js`)接收 PCM chunks 流式播放,
 * 支持中途清空(打断)+ 20ms 淡出避免音爆。
 *
 * Phase 1 范围:基础流式播放
 * Phase 2 集成:暴露 ref signal queue 给 native AEC(参考 docs v2.3 AEC Layer 1)
 *
 * 实测验证(spike 03,2026-04-30):
 *   - 1000 次自动 flush stress test
 *   - avg flush 18.83 ms (< 25 目标)
 *   - max flush 22.5 ms (< 50 目标)
 */
import { TtsReferenceSignalQueue } from './tts-reference-signal';

export interface PlaybackStats {
  queueChunks: number;
  queueSamples: number;
  totalEnqueued: number;
  totalConsumed: number;
  underruns: number;
}

function resolveWorkletUrl(path: string): string {
  return new URL(path, window.location.href).href;
}

export class PcmPlayer {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private flushedCallbacks = new Set<() => void>();
  private statsCallback: ((s: PlaybackStats) => void) | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private referenceQueue = new TtsReferenceSignalQueue();

  /**
   * 初始化(必须在用户 gesture 后调,因为 AudioContext 创建会被浏览器阻塞)
   * @param onStats 可选的统计回调
   */
  async init(onStats?: (s: PlaybackStats) => void): Promise<void> {
    this.audioCtx = new AudioContext({ latencyHint: "interactive" });
    await this.audioCtx.audioWorklet.addModule(resolveWorkletUrl("workers/pcm-player.worklet.js"));
    this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-player");
    this.workletNode.connect(this.audioCtx.destination);

    this.workletNode.port.onmessage = (e) => {
      if (e.data?.type === "flushed") {
        for (const cb of this.flushedCallbacks) cb();
        this.flushedCallbacks.clear();
      } else if (e.data?.type === "stats") {
        this.statsCallback?.(e.data as PlaybackStats);
      }
    };

    if (onStats) {
      this.statsCallback = onStats;
      this.statsTimer = setInterval(() => {
        this.workletNode?.port.postMessage({ type: "getStats" });
      }, 500);
    }
  }

  /**
   * 推入一个 PCM chunk
   * @param pcm Int16Array (16kHz mono),建议 100ms 一片(1600 samples)
   */
  enqueue(pcm: Int16Array): void {
    if (!this.workletNode) throw new Error("PcmPlayer not initialized — call init() first");
    this.referenceQueue.enqueue(pcm);
    // transferable buffer,避免拷贝
    this.workletNode.port.postMessage(
      { type: "pcm", payload: pcm },
      [pcm.buffer],
    );
  }

  /**
   * 中途清空 + 20ms 淡出
   * @returns Promise resolves when fade-out 完成 + queue 已清
   */
  flush(): Promise<void> {
    if (!this.workletNode) return Promise.resolve();
    this.referenceQueue.clear();
    return new Promise((resolve) => {
      this.flushedCallbacks.add(resolve);
      this.workletNode!.port.postMessage({ type: "flush" });
      // 兜底 timeout:50ms 后还没回 flushed 也 resolve(spike 03 实测最大 22.5ms)
      setTimeout(resolve, 50);
    });
  }

  /** 立刻重置 queue + stats */
  reset(): void {
    this.referenceQueue.clear();
    this.workletNode?.port.postMessage({ type: "reset" });
  }

  /**
   * 取出即将/正在播放的 TTS reference PCM。样本不足时用 0 补齐。
   * Native AEC 集成会按 10ms 或 100ms 从这里取 far-end reference。
   */
  takeReferencePcm(sampleCount: number): Int16Array {
    return this.referenceQueue.take(sampleCount);
  }

  getReferenceQueuedSamples(): number {
    return this.referenceQueue.size();
  }

  destroy(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    this.workletNode = null;
    this.audioCtx = null;
    this.flushedCallbacks.clear();
    this.statsCallback = null;
    this.referenceQueue.clear();
  }

  isInitialized(): boolean {
    return this.workletNode !== null;
  }
}
