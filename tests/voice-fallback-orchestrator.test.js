/**
 * Voice Fallback Orchestrator — DS V4 Pro 反馈 #5 Phase 2.5 降级编排测试
 */
import { describe, expect, it } from "vitest";
import {
  computeVoiceTier,
  enrichHealthWithTier,
} from "../server/chat/voice-fallback-orchestrator.js";

const GREEN = { ok: true, fallbackOk: false, degraded: false };
const DEGRADED = { ok: false, fallbackOk: true, degraded: true };
const DEAD = { ok: false, fallbackOk: false, degraded: true };
const SER_DEAD = { ok: false, fallbackOk: false, degraded: true };

describe("computeVoiceTier — Phase 2.5 五档降级", () => {
  it("Tier 1 全绿 → 绿呼吸无提示", () => {
    const r = computeVoiceTier({ asr: GREEN, ser: GREEN, tts: GREEN });
    expect(r.tier).toBe(1);
    expect(r.orbColor).toBe("green");
    expect(r.label).toBe("");
  });

  it("Tier 2 SER 挂 → 绿(SER 不阻塞主链)", () => {
    const r = computeVoiceTier({ asr: GREEN, ser: SER_DEAD, tts: GREEN });
    expect(r.tier).toBe(2);
    expect(r.orbColor).toBe("green");
    expect(r.label).toBe("");
  });

  it("Tier 3 ASR 降级 → 黄呼吸提示", () => {
    const r = computeVoiceTier({ asr: DEGRADED, ser: GREEN, tts: GREEN });
    expect(r.tier).toBe(3);
    expect(r.orbColor).toBe("yellow");
    expect(r.label).toContain("ASR 降级");
    expect(r.label).toContain("SenseVoice");
  });

  it("Tier 4 TTS 降级 → 黄呼吸提示", () => {
    const r = computeVoiceTier({ asr: GREEN, ser: GREEN, tts: DEGRADED });
    expect(r.tier).toBe(4);
    expect(r.orbColor).toBe("yellow");
    expect(r.label).toContain("TTS 降级");
    expect(r.label).toContain("Edge TTS");
  });

  it("Tier 5 ASR + TTS 双降级 → 黄呼吸", () => {
    const r = computeVoiceTier({ asr: DEGRADED, ser: GREEN, tts: DEGRADED });
    expect(r.tier).toBe(5);
    expect(r.orbColor).toBe("yellow");
    expect(r.label).toContain("都在降级");
  });

  it("Tier 6 ASR 彻底死 → 红色硬提示", () => {
    const r = computeVoiceTier({ asr: DEAD, ser: GREEN, tts: GREEN });
    expect(r.tier).toBe(6);
    expect(r.orbColor).toBe("red");
    expect(r.label).toContain("ASR");
    expect(r.label).toContain("不可用");
  });

  it("Tier 6 TTS 彻底死 → 红色", () => {
    const r = computeVoiceTier({ asr: GREEN, ser: GREEN, tts: DEAD });
    expect(r.tier).toBe(6);
    expect(r.orbColor).toBe("red");
    expect(r.label).toContain("TTS");
  });

  it("Tier 6 ASR + TTS 双死 → 红色 + 复合提示", () => {
    const r = computeVoiceTier({ asr: DEAD, ser: SER_DEAD, tts: DEAD });
    expect(r.tier).toBe(6);
    expect(r.orbColor).toBe("red");
    expect(r.label).toContain("ASR/TTS 双挂");
  });

  it("Tier 优先级:红先于黄(双死 > 单降级)", () => {
    const r = computeVoiceTier({ asr: DEAD, ser: GREEN, tts: DEGRADED });
    expect(r.tier).toBe(6);
    expect(r.orbColor).toBe("red");
  });

  it("空输入不崩(默认 Tier 1)", () => {
    const r = computeVoiceTier({});
    expect(r.tier).toBe(1);
    expect(r.orbColor).toBe("green");
  });

  it("部分 provider 缺席不崩", () => {
    const r = computeVoiceTier({ asr: GREEN });
    expect(r.tier).toBe(1);
    expect(r.orbColor).toBe("green");
  });
});

describe("enrichHealthWithTier — 向后兼容", () => {
  it("原 health JSON 全部保留 + 附加 tier 字段", () => {
    const raw = {
      ok: true,
      degraded: false,
      providers: { asr: GREEN, ser: GREEN, tts: GREEN },
    };
    const enriched = enrichHealthWithTier(raw);
    expect(enriched.ok).toBe(true);
    expect(enriched.degraded).toBe(false);
    expect(enriched.providers).toEqual(raw.providers);
    expect(enriched.tier).toBe(1);
    expect(enriched.orbColor).toBe("green");
    expect(enriched.tierLabel).toBe("");
  });

  it("没有 providers 字段时原样返回(不崩)", () => {
    const raw = { ok: true };
    const enriched = enrichHealthWithTier(raw);
    expect(enriched).toEqual(raw);
  });

  it("null 输入返回 null", () => {
    expect(enrichHealthWithTier(null)).toBe(null);
  });

  it("降级路径翻译:ASR degraded → tier 3 + yellow + 文案", () => {
    const raw = {
      ok: false,
      degraded: true,
      providers: { asr: DEGRADED, ser: GREEN, tts: GREEN },
    };
    const enriched = enrichHealthWithTier(raw);
    expect(enriched.tier).toBe(3);
    expect(enriched.orbColor).toBe("yellow");
    expect(enriched.tierLabel).toContain("SenseVoice");
  });
});
