/**
 * TTS reference signal queue for Jarvis AEC.
 *
 * PcmPlayer enqueues the same audio it sends to speakers here. The mic capture
 * side can later take time-aligned 10ms/100ms chunks as far-end reference for
 * WebRTC AEC.
 */

export class TtsReferenceSignalQueue {
  private chunks: Int16Array[] = [];
  private queuedSamples = 0;
  private readonly maxSamples: number;

  constructor(maxSamples = 16000 * 10) {
    this.maxSamples = Math.max(0, Math.floor(maxSamples));
  }

  enqueue(pcm: Int16Array): void {
    if (!pcm.length || this.maxSamples <= 0) return;
    const copy = new Int16Array(pcm);
    this.chunks.push(copy);
    this.queuedSamples += copy.length;
    this.trimToMax();
  }

  take(sampleCount: number): Int16Array {
    const count = Math.max(0, Math.floor(sampleCount));
    const out = new Int16Array(count);
    let offset = 0;

    while (offset < count && this.chunks.length > 0) {
      const head = this.chunks[0];
      const needed = count - offset;
      const n = Math.min(needed, head.length);
      out.set(head.subarray(0, n), offset);
      offset += n;
      this.queuedSamples -= n;

      if (n === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(n);
      }
    }

    return out;
  }

  clear(): void {
    this.chunks = [];
    this.queuedSamples = 0;
  }

  size(): number {
    return this.queuedSamples;
  }

  private trimToMax(): void {
    while (this.queuedSamples > this.maxSamples && this.chunks.length > 0) {
      const overflow = this.queuedSamples - this.maxSamples;
      const head = this.chunks[0];
      if (overflow >= head.length) {
        this.chunks.shift();
        this.queuedSamples -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.queuedSamples -= overflow;
      }
    }
  }
}
