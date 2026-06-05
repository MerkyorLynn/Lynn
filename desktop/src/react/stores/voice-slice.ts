export type TtsProviderPreference = 'cosyvoice' | 'edge' | 'openai' | 'say' | string;

const TTS_AUTO_PREFETCH_KEY = 'lynn-tts-auto-prefetch';
const TTS_STREAMING_KEY = 'lynn-tts-streaming-enabled';
const TTS_BROWSER_FALLBACK_KEY = 'lynn-tts-browser-fallback-enabled';

function readBoolPreference(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored === '1';
  } catch {
    return fallback;
  }
}

function writeBoolPreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // localStorage may be unavailable in tests / hardened browser contexts.
  }
}

export interface VoiceSlice {
  ttsAutoPrefetch: boolean;
  ttsStreamingEnabled: boolean;
  ttsBrowserFallbackEnabled: boolean;
  ttsProviderPreference: TtsProviderPreference | null;
  setTtsAutoPrefetch: (enabled: boolean) => void;
  setTtsStreamingEnabled: (enabled: boolean) => void;
  setTtsBrowserFallbackEnabled: (enabled: boolean) => void;
  setTtsProviderPreference: (provider: TtsProviderPreference | null) => void;
}

export const createVoiceSlice = (
  set: (partial: Partial<VoiceSlice>) => void,
): VoiceSlice => ({
  ttsAutoPrefetch: readBoolPreference(TTS_AUTO_PREFETCH_KEY, false),
  ttsStreamingEnabled: readBoolPreference(TTS_STREAMING_KEY, true),
  ttsBrowserFallbackEnabled: readBoolPreference(TTS_BROWSER_FALLBACK_KEY, true),
  ttsProviderPreference: null,
  setTtsAutoPrefetch: (enabled) => {
    writeBoolPreference(TTS_AUTO_PREFETCH_KEY, enabled);
    set({ ttsAutoPrefetch: enabled });
  },
  setTtsStreamingEnabled: (enabled) => {
    writeBoolPreference(TTS_STREAMING_KEY, enabled);
    set({ ttsStreamingEnabled: enabled });
  },
  setTtsBrowserFallbackEnabled: (enabled) => {
    writeBoolPreference(TTS_BROWSER_FALLBACK_KEY, enabled);
    set({ ttsBrowserFallbackEnabled: enabled });
  },
  setTtsProviderPreference: (provider) => set({ ttsProviderPreference: provider }),
});
