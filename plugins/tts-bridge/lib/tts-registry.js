/**
 * TTS Provider Registry · v0.77 (mimo added 2026-05-27)
 *
 * 统一接口：synthesize({ text, voice, speed, outPath })
 * 支持 provider：cosyvoice (默认) / edge / say / openai / mimo
 *
 * 配置来源：engine.config.voice.tts
 */
import { createCosyVoiceProvider } from "./providers/cosyvoice.js";
import { createEdgeTTSProvider } from "./providers/edge-tts.js";
import { createMacOSSayProvider } from "./providers/macos-say.js";
import { createOpenAITTSProvider } from "./providers/openai-tts.js";
import { createMiMoTTSProvider } from "./providers/mimo-tts.js";

const PROVIDERS = {
  cosyvoice: createCosyVoiceProvider,
  edge: createEdgeTTSProvider,
  say: createMacOSSayProvider,
  openai: createOpenAITTSProvider,
  mimo: createMiMoTTSProvider,
};

export function listTTSProviders() {
  return [
    { id: "cosyvoice", label: "CosyVoice 2 (阿里・推荐)", needsKey: false, default: true },
    { id: "edge", label: "Edge TTS (免费在线)", needsKey: false },
    { id: "say", label: "macOS say (本地)", needsKey: false, platform: "darwin" },
    { id: "openai", label: "OpenAI TTS API", needsKey: true },
    { id: "mimo", label: "MiMo V2.5 TTS (preset/voicedesign/voiceclone)", needsKey: true },
  ];
}

export function createTTSProvider(config = {}) {
  const providerId = config.provider || "cosyvoice";
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[TTS] Unknown provider "${providerId}", falling back to cosyvoice`);
    return createCosyVoiceProvider(config);
  }
  return factory(config);
}
