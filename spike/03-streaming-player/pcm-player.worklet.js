/**
 * AudioWorkletProcessor — 流式 PCM 播放 + 中途清空 + 淡出
 *
 * 输入:Int16Array PCM chunks(16kHz mono),通过 port.postMessage 推入
 * 输出:AudioWorklet 渲染时取队列前面的 samples 输出到 destination
 *
 * 中途清空:port.postMessage({type: 'flush'}) → 立即清队列 + 20ms 线性淡出
 *
 * 重要约束:
 *   - AudioContext sampleRate 由设备决定(通常 48kHz),内部上采样 16k → 设备 rate
 *   - 队列空时输出静音,不报错(避免 underrun 噪音)
 *   - 监控 underrun count 和 queue size
 */
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceSampleRate = 16000;
    this.upsampleRatio = sampleRate / this.sourceSampleRate; // device / source

    // 缓冲队列 - Float32 samples already upsampled to device rate
    this.queue = [];
    this.totalEnqueued = 0;
    this.totalConsumed = 0;
    this.underruns = 0;

    // 淡出状态
    this.fadeOut = false;
    this.fadeOutSamples = 0;
    this.fadeOutDuration = Math.floor(sampleRate * 0.02); // 20ms

    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm') {
        // Int16Array → Float32 + linear upsample to device rate
        const int16 = e.data.payload;
        const sourceLen = int16.length;
        const targetLen = Math.floor(sourceLen * this.upsampleRatio);
        const float32 = new Float32Array(targetLen);
        for (let i = 0; i < targetLen; i++) {
          const srcIdx = i / this.upsampleRatio;
          const idx0 = Math.floor(srcIdx);
          const idx1 = Math.min(idx0 + 1, sourceLen - 1);
          const t = srcIdx - idx0;
          // 简单线性插值(spike 用,生产用 src/sox)
          const s0 = int16[idx0] / 32768;
          const s1 = int16[idx1] / 32768;
          float32[i] = s0 + (s1 - s0) * t;
        }
        this.queue.push(float32);
        this.totalEnqueued += float32.length;
      } else if (e.data.type === 'flush') {
        // 立即触发淡出,然后清空队列
        this.fadeOut = true;
        this.fadeOutSamples = 0;
      } else if (e.data.type === 'reset') {
        this.queue = [];
        this.totalEnqueued = 0;
        this.totalConsumed = 0;
        this.underruns = 0;
        this.fadeOut = false;
      } else if (e.data.type === 'getStats') {
        this.port.postMessage({
          type: 'stats',
          queueChunks: this.queue.length,
          queueSamples: this.queue.reduce((s, c) => s + c.length, 0),
          totalEnqueued: this.totalEnqueued,
          totalConsumed: this.totalConsumed,
          underruns: this.underruns,
        });
      }
    };

    this.head = null;
    this.headPos = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0]; // mono
    const N = channel.length;

    for (let i = 0; i < N; i++) {
      // 取下一个 sample
      while (!this.head || this.headPos >= this.head.length) {
        if (this.queue.length === 0) {
          this.head = null;
          break;
        }
        this.head = this.queue.shift();
        this.headPos = 0;
      }

      let sample;
      if (this.head) {
        sample = this.head[this.headPos++];
        this.totalConsumed++;
      } else {
        sample = 0;
        this.underruns++;
      }

      // 淡出处理
      if (this.fadeOut) {
        const fadeMul = 1 - (this.fadeOutSamples / this.fadeOutDuration);
        sample *= Math.max(0, fadeMul);
        this.fadeOutSamples++;
        if (this.fadeOutSamples >= this.fadeOutDuration) {
          // 淡出完毕 → 清队列
          this.queue = [];
          this.head = null;
          this.headPos = 0;
          this.fadeOut = false;
          this.port.postMessage({ type: 'flushed' });
        }
      }

      channel[i] = sample;
    }

    return true;
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
