/**
 * AEC frame adapter for Lynn Jarvis Runtime.
 *
 * The AudioWorklet recorder emits 100ms Int16 chunks. The native WebRTC AEC
 * binding requires strict 10ms Float32 frames, so this adapter does the
 * mechanical split/merge at the browser boundary.
 */

export const AEC_SAMPLE_RATE = 16000;
export const AEC_FRAME_MS = 10;
export const AEC_SAMPLES_PER_FRAME = (AEC_SAMPLE_RATE * AEC_FRAME_MS) / 1000;

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] < 0 ? input[i] / 0x8000 : input[i] / 0x7fff;
  }
  return out;
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function splitPcm100msToAecFrames(pcm: Int16Array): Float32Array[] {
  if (pcm.length % AEC_SAMPLES_PER_FRAME !== 0) {
    throw new Error(`PCM chunk length ${pcm.length} is not divisible by ${AEC_SAMPLES_PER_FRAME}`);
  }
  const frames: Float32Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += AEC_SAMPLES_PER_FRAME) {
    frames.push(int16ToFloat32(pcm.subarray(offset, offset + AEC_SAMPLES_PER_FRAME)));
  }
  return frames;
}

export function mergeAecFramesToPcm(frames: Float32Array[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    if (frame.length !== AEC_SAMPLES_PER_FRAME) {
      throw new Error(`AEC frame length ${frame.length} != ${AEC_SAMPLES_PER_FRAME}`);
    }
    out.set(float32ToInt16(frame), offset);
    offset += frame.length;
  }
  return out;
}
