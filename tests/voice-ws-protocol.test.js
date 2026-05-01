/**
 * Voice WS 二进制帧协议单测 — Lynn V0.79 Phase 1
 */
import { describe, expect, it } from "vitest";
import { FRAME, STATE, parseFrame, makeFrame } from "../server/routes/voice-ws.js";

describe("voice-ws protocol — parseFrame / makeFrame", () => {
  it("round-trip empty payload", () => {
    const frame = makeFrame(FRAME.PING, 0, 42, Buffer.alloc(0));
    const parsed = parseFrame(frame);
    expect(parsed).toEqual({
      type: FRAME.PING,
      flags: 0,
      seq: 42,
      payload: Buffer.alloc(0),
    });
  });

  it("round-trip with PCM payload", () => {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    const frame = makeFrame(FRAME.PCM_AUDIO, 0, 1234, pcm);
    const parsed = parseFrame(frame);
    expect(parsed.type).toBe(FRAME.PCM_AUDIO);
    expect(parsed.seq).toBe(1234);
    expect(Buffer.compare(parsed.payload, pcm)).toBe(0);
  });

  it("seq wraps at u16 boundary", () => {
    // 0xFFFF is the largest u16
    const frame = makeFrame(FRAME.PCM_AUDIO, 0, 0xffff, Buffer.alloc(0));
    expect(parseFrame(frame).seq).toBe(0xffff);
    // 0x10000 wraps to 0
    const wrapped = makeFrame(FRAME.PCM_AUDIO, 0, 0x10000, Buffer.alloc(0));
    expect(parseFrame(wrapped).seq).toBe(0);
  });

  it("flags byte preserved", () => {
    const frame = makeFrame(FRAME.PCM_TTS, 0xaa, 7, Buffer.from("x"));
    expect(parseFrame(frame).flags).toBe(0xaa);
  });

  it("returns null for short buffer", () => {
    expect(parseFrame(Buffer.alloc(0))).toBeNull();
    expect(parseFrame(Buffer.alloc(3))).toBeNull();
    expect(parseFrame(Buffer.alloc(4))).not.toBeNull(); // exactly 4 bytes = OK (empty payload)
  });

  it("accepts ArrayBuffer input(client-side WS message)", () => {
    const ab = new Uint8Array([FRAME.PING, 0, 0, 5, 0x99]).buffer;
    const parsed = parseFrame(ab);
    expect(parsed.type).toBe(FRAME.PING);
    expect(parsed.seq).toBe(5);
    expect(parsed.payload[0]).toBe(0x99);
  });

  it("type / state enums are stable", () => {
    expect(FRAME.PCM_AUDIO).toBe(0x01);
    expect(FRAME.PCM_TTS).toBe(0x02);
    expect(FRAME.ASSISTANT_REPLY).toBe(0x17);
    expect(FRAME.INTERRUPT).toBe(0x20);
    expect(FRAME.END_OF_TURN).toBe(0x30);
    expect(STATE.IDLE).toBe("idle");
    expect(STATE.LISTENING).toBe("listening");
    expect(STATE.SPEAKING).toBe("speaking");
    expect(STATE.DEGRADED).toBe("degraded");
  });
});
