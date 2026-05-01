import { describe, expect, it } from "vitest";
import {
  AEC_SAMPLES_PER_FRAME,
  float32ToInt16,
  int16ToFloat32,
  mergeAecFramesToPcm,
  splitPcm100msToAecFrames,
} from "../desktop/src/react/services/aec-frame-adapter";

describe("AEC frame adapter", () => {
  it("splits a 100ms 16kHz Int16 chunk into ten 10ms Float32 frames", () => {
    const pcm = new Int16Array(1600);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i - 800;
    const frames = splitPcm100msToAecFrames(pcm);
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.length === AEC_SAMPLES_PER_FRAME)).toBe(true);
    expect(frames[0]).toBeInstanceOf(Float32Array);
  });

  it("merges ten AEC frames back into a 100ms Int16 chunk", () => {
    const frames = Array.from({ length: 10 }, (_, idx) => {
      const frame = new Float32Array(AEC_SAMPLES_PER_FRAME);
      frame.fill(idx / 10);
      return frame;
    });
    const pcm = mergeAecFramesToPcm(frames);
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm).toHaveLength(1600);
  });

  it("round-trips representative Int16 values through Float32 conversion", () => {
    const input = new Int16Array([-32768, -1234, 0, 1234, 32767]);
    const output = float32ToInt16(int16ToFloat32(input));
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it("rejects chunks that cannot be split into strict 10ms frames", () => {
    expect(() => splitPcm100msToAecFrames(new Int16Array(1599))).toThrow(/not divisible/);
    expect(() => mergeAecFramesToPcm([new Float32Array(100)])).toThrow(/frame length/);
  });
});
