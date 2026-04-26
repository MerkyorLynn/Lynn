/**
 * TTS Provider Registry · v0.77
 *
 * 统一接口：synthesize({ text, voice, speed, outPath })
 * 支持 provider：edge（默认）/ say / openai
 *
 * 配置来源：engine.config.voice.tts
 */
import { createCosyVoiceProvider } from "./providers/cosyvoice.js";
import { createEdgeTTSProvider } from "./providers/edge-tts.js";
import { createMacOSSayProvider } from "./providers/macos-say.js";
import { createOpenAITTSProvider } from "./providers/openai-tts.js";

const PROVIDERS = {
  cosyvoice: createCosyVoiceProvider,
  edge: createEdgeTTSProvider,
  say: createMacOSSayProvider,
  openai: createOpenAITTSProvider,
};

export function listTTSProviders() {
  return [
    { id: "cosyvoice", label: "CosyVoice 2 (阿里・推荐)", needsKey: false, default: true },
    { id: "edge", label: "Edge TTS (免费在线)", needsKey: false },
    { id: "say", label: "macOS say (本地)", needsKey: false, platform: "darwin" },
    { id: "openai", label: "OpenAI TTS API", needsKey: true },
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
