/**
 * TTS Provider Registry · Lynn V0.79 Jarvis Runtime
 *
 * Voice WS uses byte-returning providers. The older tts-bridge plugin remains
 * the file-saving tool path for chat message朗读.
 */
import { createCosyVoice2TtsProvider } from "./cosyvoice2.js";
import { createEdgeTtsProvider } from "./edge.js";

const PROVIDERS = {
  cosyvoice: createCosyVoice2TtsProvider,
  cosyvoice2: createCosyVoice2TtsProvider,
  "cosyvoice-2": createCosyVoice2TtsProvider,
  edge: createEdgeTtsProvider,
  "edge-tts": createEdgeTtsProvider,
};

export function createTTSProvider(config = {}) {
  const providerId = config.provider || "cosyvoice2";
  const factory = PROVIDERS[providerId];
  if (!factory) {
    throw new Error(`Unknown TTS provider: ${providerId}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return factory(config);
}

export function createTTSFallbackProvider(config = {}, deps = {}) {
  const primaryProvider = config.provider || "cosyvoice2";
  const primary = deps.primaryProvider || createTTSProvider({ ...config, provider: primaryProvider });
  const fallbackProvider = config.fallback?.provider || config.fallback_provider || "edge";

  if (primaryProvider === fallbackProvider && !deps.fallbackProvider) {
    return primary;
  }

  const fallbackConfig = {
    ...(config.fallback || {}),
    provider: fallbackProvider,
  };
  const fallback = deps.fallbackProvider || createTTSProvider(fallbackConfig);

  // 2026-05-01 P0-② — primary 支持 synthesizeStream 时透传(优先);否则不暴露,
  // voice-ws 看到 provider 没 synthesizeStream 自动回退到 synthesize 整段路径
  const supportsStream = typeof primary.synthesizeStream === "function";

  return {
    name: `${primary.name || "tts"}+fallback`,
    label: `${primary.label || primary.name || "TTS"} with fallback`,

    async synthesize(text, opts = {}) {
      try {
        return await primary.synthesize(text, opts);
      } catch (err) {
        const result = await fallback.synthesize(text, opts);
        return {
          ...result,
          fallbackUsed: true,
          primaryError: err?.message || String(err),
        };
      }
    },

    // 2026-05-01 P0-② 流式接力:首 chunk 出来就吐,fallback 失败时改走 synthesize 整段
    ...(supportsStream ? {
      async *synthesizeStream(text, opts = {}) {
        try {
          for await (const chunk of primary.synthesizeStream(text, opts)) {
            yield chunk;
          }
          return;
        } catch (err) {
          // 主链流式失败 → fallback synthesize 整段 → 包装成单 chunk yield
          const fallbackResult = await fallback.synthesize(text, opts);
          yield {
            ...fallbackResult,
            fallbackUsed: true,
            primaryError: err?.message || String(err),
          };
        }
      },
    } : {}),

    async health() {
      const [primaryOk, fallbackOk] = await Promise.all([
        healthOf(primary),
        healthOf(fallback),
      ]);
      return {
        ok: primaryOk,
        fallbackOk,
        degraded: !primaryOk && fallbackOk,
      };
    },
  };
}

async function healthOf(provider) {
  if (!provider || typeof provider.health !== "function") return true;
  try {
    const value = await provider.health();
    if (typeof value === "object" && value && "ok" in value) return !!value.ok;
    return !!value;
  } catch {
    return false;
  }
}

export { createCosyVoice2TtsProvider, createEdgeTtsProvider };
