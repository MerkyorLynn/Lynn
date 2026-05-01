import { describe, expect, it } from "vitest";
import { TtsReferenceSignalQueue } from "../desktop/src/react/services/tts-reference-signal";

describe("TTS reference signal queue", () => {
  it("returns time-ordered PCM and zero-pads when reference is short", () => {
    const q = new TtsReferenceSignalQueue(20);
    q.enqueue(new Int16Array([1, 2, 3]));
    q.enqueue(new Int16Array([4, 5]));

    expect(Array.from(q.take(4))).toEqual([1, 2, 3, 4]);
    expect(q.size()).toBe(1);
    expect(Array.from(q.take(4))).toEqual([5, 0, 0, 0]);
    expect(q.size()).toBe(0);
  });

  it("keeps an internal copy before PcmPlayer transfers the original buffer", () => {
    const q = new TtsReferenceSignalQueue(20);
    const pcm = new Int16Array([7, 8, 9]);
    q.enqueue(pcm);
    pcm.fill(0);

    expect(Array.from(q.take(3))).toEqual([7, 8, 9]);
  });

  it("trims oldest samples to stay under the configured cap", () => {
    const q = new TtsReferenceSignalQueue(5);
    q.enqueue(new Int16Array([1, 2, 3]));
    q.enqueue(new Int16Array([4, 5, 6, 7]));

    expect(q.size()).toBe(5);
    expect(Array.from(q.take(5))).toEqual([3, 4, 5, 6, 7]);
  });

  it("clear drops pending far-end reference", () => {
    const q = new TtsReferenceSignalQueue(20);
    q.enqueue(new Int16Array([1, 2, 3]));
    q.clear();

    expect(q.size()).toBe(0);
    expect(Array.from(q.take(2))).toEqual([0, 0]);
  });
});
