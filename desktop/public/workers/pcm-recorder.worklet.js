/**
 * AudioWorkletProcessor — 16kHz Mono Int16 PCM 采集
 *
 * 输入:AudioContext 默认 sampleRate(通常 48kHz),Float32 [-1, 1]
 * 输出:16kHz Int16Array chunks 通过 port.postMessage
 *
 * 重采样策略:线性下采样(48000 → 16000 = 取每 3 帧 1 帧)
 *            生产环境应用 SRC(sox/r8brain),spike 阶段够用
 *
 * Chunk 大小:每 100ms 一个 chunk = 1600 samples @ 16kHz
 *
 * 监控:每秒 postMessage 一次 stats(已采样多少 chunk + 平均 amplitude)
 */
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.chunkSize = 1600; // 100ms @ 16kHz
    this.inputBuffer = []; // 累积下采样后的 Float32 samples
    this.totalSamples = 0;
    this.totalChunks = 0;
    this.startTime = currentTime;
    this.lastStatsTime = currentTime;
    this.amplitudeSum = 0;
    this.amplitudeCount = 0;

    // 重采样比例(在 process 第一次调用时根据 sampleRate 全局变量算)
    this.resampleRatio = sampleRate / this.targetSampleRate; // sampleRate is global in AudioWorklet
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono
    if (!channel) return true;

    // 线性下采样 sampleRate → 16kHz
    for (let i = 0; i < channel.length; i += this.resampleRatio) {
      const idx = Math.floor(i);
      if (idx < channel.length) {
        const sample = channel[idx];
        this.inputBuffer.push(sample);
        this.amplitudeSum += Math.abs(sample);
        this.amplitudeCount++;
      }
    }

    // 输出满 chunkSize 的 chunk
    while (this.inputBuffer.length >= this.chunkSize) {
      const chunk = this.inputBuffer.splice(0, this.chunkSize);
      // Float32 → Int16
      const int16 = new Int16Array(this.chunkSize);
      for (let i = 0; i < this.chunkSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'pcm', payload: int16 }, [int16.buffer]);
      this.totalChunks++;
      this.totalSamples += this.chunkSize;
    }

    // 每秒发一次 stats
    if (currentTime - this.lastStatsTime >= 1.0) {
      const elapsed = currentTime - this.startTime;
      const avgAmp = this.amplitudeCount > 0 ? this.amplitudeSum / this.amplitudeCount : 0;
      this.port.postMessage({
        type: 'stats',
        elapsedSec: elapsed,
        totalChunks: this.totalChunks,
        totalSamples: this.totalSamples,
        chunksPerSec: this.totalChunks / elapsed,
        avgAmplitude: avgAmp,
        bufferLag: this.inputBuffer.length, // 应接近 0,大说明阻塞
      });
      this.lastStatsTime = currentTime;
      this.amplitudeSum = 0;
      this.amplitudeCount = 0;
    }

    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
