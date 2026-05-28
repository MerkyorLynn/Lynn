/**
 * TTS Provider Registry · v0.77 (mimo added 2026-05-27, defaults aligned 2026-05-28)
 *
 * 统一接口:synthesize({ text, voice, speed, outPath, cloneAudio?, voiceDescription? })
 * 支持 provider:edge (默认) / cosyvoice / say / openai / mimo
 *
 * 默认值对齐 manifest.json provider.default = 'edge':
 *   - edge 流式低延迟 + 免费 + 不需要 key,普通用户场景最佳起点
 *   - cosyvoice / mimo / openai 需要 user 显式配 key 或本地服务
 *
 * 配置来源:engine.config.voice.tts
 */
import { createCosyVoiceProvider } from "./providers/cosyvoice.js";
import { createEdgeTTSProvider } from "./providers/edge-tts.js";
import { createMacOSSayProvider } from "./providers/macos-say.js";
import { createOpenAITTSProvider } from "./providers/openai-tts.js";
import { createMiMoTTSProvider } from "./providers/mimo-tts.js";

const PROVIDERS = {
  edge: createEdgeTTSProvider,
  cosyvoice: createCosyVoiceProvider,
  say: createMacOSSayProvider,
  openai: createOpenAITTSProvider,
  mimo: createMiMoTTSProvider,
};

export function listTTSProviders() {
  return [
    { id: "edge", label: "Edge TTS (免费在线・默认・流式低延迟)", needsKey: false, default: true },
    { id: "cosyvoice", label: "CosyVoice 2 (阿里)", needsKey: false },
    { id: "say", label: "macOS say (本地)", needsKey: false, platform: "darwin" },
    { id: "openai", label: "OpenAI TTS API", needsKey: true },
    { id: "mimo", label: "MiMo V2.5 TTS (preset/voicedesign/voiceclone)", needsKey: true },
  ];
}

/**
 * 自动 provider 路由:
 *   - config.voice_clone_audio_path 设置 → 强制 mimo + voiceclone(覆盖 config.provider)
 *   - config.voice_description 设置 → 强制 mimo + voicedesign(覆盖 config.provider)
 *   - 否则按 config.provider(manifest 默认 'edge')
 */
function pickProvider(config) {
  if (config?.voice_clone_audio_path || config?.cloneAudio) return "mimo";
  if (config?.voice_description || config?.voiceDescription) return "mimo";
  return config?.provider || "edge";
}

export function createTTSProvider(config = {}) {
  const providerId = pickProvider(config);
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[TTS] Unknown provider "${providerId}", falling back to edge`);
    return createEdgeTTSProvider(config);
  }
  return factory(config);
}
