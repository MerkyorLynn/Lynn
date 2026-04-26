/**
 * ASR Provider Registry · v0.77
 *
 * 统一接口：transcribe(audioBuffer, opts) + health()
 * 支持 provider：faster-whisper（默认）/ openai-whisper / azure-stt
 *
 * 配置来源（优先级从高到低）：
 *   1. engine.config.voice.asr
 *   2. 环境变量 LYNN_ASR_URL
 *   3. 内置默认值
 */
import { createSenseVoiceProvider } from "./sensevoice.js";
import { createFasterWhisperProvider } from "./faster-whisper.js";
import { createOpenAIWhisperProvider } from "./openai-whisper.js";
import { createAzureSTTProvider } from "./azure-stt.js";

const PROVIDERS = {
  "sensevoice": createSenseVoiceProvider,
  "faster-whisper": createFasterWhisperProvider,
  "openai": createOpenAIWhisperProvider,
  "openai-whisper": createOpenAIWhisperProvider,
  "azure": createAzureSTTProvider,
  "azure-stt": createAzureSTTProvider,
};

export function listASRProviders() {
  return [
    { id: "sensevoice", label: "SenseVoice (达摩院・推荐)", needsKey: false, default: true },
    { id: "faster-whisper", label: "Faster Whisper (自托管)", needsKey: false },
    { id: "openai", label: "OpenAI Whisper API", needsKey: true },
    { id: "azure", label: "Azure Speech-to-Text", needsKey: true },
  ];
}

export function createASRProvider(config = {}) {
  const providerId = config.provider || "sensevoice";
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[ASR] Unknown provider "${providerId}", falling back to sensevoice`);
    return createSenseVoiceProvider(config);
  }
  return factory(config);
}
