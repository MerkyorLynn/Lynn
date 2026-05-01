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
