import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve("desktop/src/react/settings/tabs/VoiceTab.tsx"), "utf8");

describe("Voice settings StepFun Realtime contract", () => {
  it("keeps StepFun Realtime TTS on Lynn cloud key instead of asking the user for BYOK", () => {
    expect(source).toContain("Lynn 云端");
    expect(source).toContain("无需 Key");
    const needsAsrKeyLine = source.split("\n").find((line) => line.includes("needsAsrKey")) || "";
    const needsTtsKeyLine = source.split("\n").find((line) => line.includes("needsTtsKey")) || "";
    expect(needsAsrKeyLine).not.toContain("stepfun");
    expect(needsTtsKeyLine).not.toContain("stepfun");
  });

  it("exposes StepFun Realtime ASR as the Lynn cloud default instead of local Spark", () => {
    expect(source).toContain("value: 'stepfun-realtime'");
    expect(source).toContain("StepFun Realtime ASR");
    expect(source).toContain("GUI/CLI 语音输入通过 Lynn Brain 托管 StepFun Realtime 转写");
    // Both locales are provided; the English arm keeps the label readable in en mode.
    expect(source).toContain("StepFun Realtime ASR (Lynn Cloud · default)");
    expect(source).toContain("LEGACY_ASR_FALLBACKS.has(value)) return 'stepfun-realtime'");
  });

  it("migrates legacy Spark-era TTS engines back to the StepFun primary chain", () => {
    expect(source).toContain("const LEGACY_TTS_FALLBACKS = new Set(['spark', 'spark-local', 'cosyvoice', 'cosyvoice2', 'cosyvoice-2', 'edge', 'edge-tts', 'say'])");
    expect(source).toContain("LEGACY_TTS_FALLBACKS.has(value)) return 'stepfun-realtime'");
  });

  it("does not expose local TTS fallback engines as primary provider choices", () => {
    const asrBlock = source.match(/function asrProviderOptions\([\s\S]*?\n\}/)?.[0] || "";
    const ttsBlock = source.match(/function ttsProviderOptions\([\s\S]*?\n\}/)?.[0] || "";
    expect(asrBlock).toContain("StepFun Realtime ASR");
    expect(asrBlock).not.toContain("SenseVoice");
    expect(ttsBlock).toContain("StepFun Realtime TTS");
    expect(ttsBlock).not.toContain("CosyVoice");
    expect(ttsBlock).not.toContain("Spark local");
  });
});
