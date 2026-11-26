import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve("desktop/src");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const CJK = /[\u4e00-\u9fff]/;

function flatten(node: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, keyPath));
    } else {
      out[keyPath] = value;
    }
  }
  return out;
}

const packs = {
  zh: flatten(JSON.parse(read("locales/zh.json"))),
  en: flatten(JSON.parse(read("locales/en.json"))),
};

describe("English locale completeness", () => {
  it("has no Chinese text left in the English pack", () => {
    const chinese = Object.entries(packs.en)
      .filter(([, value]) => typeof value === "string" && CJK.test(value))
      .map(([key]) => key);
    expect(chinese).toEqual([]);
  });

  it("covers every zh key so English never falls back to a raw key", () => {
    const missing = Object.keys(packs.zh).filter((key) => !(key in packs.en));
    expect(missing).toEqual([]);
  });

  it("declares the same keys in both packs", () => {
    const extra = Object.keys(packs.en).filter((key) => !(key in packs.zh));
    expect(extra).toEqual([]);
  });

  it("nests every key so lookups can actually reach it", () => {
    // i18n resolves a dotted path by walking nested objects. A key stored as a
    // literal "error.llmTimeout" at the top level is unreachable and renders as
    // the raw dotted string in every language.
    for (const locale of ["zh", "en", "ja", "ko", "zh-TW"]) {
      const raw = JSON.parse(read(`locales/${locale}.json`)) as Record<string, unknown>;
      const flat = Object.keys(raw).filter((key) => key.includes("."));
      expect({ locale, flat }).toEqual({ locale, flat: [] });
    }
  });
});

describe("locale plumbing keeps the UI in sync", () => {
  it("mirrors the active locale onto <html lang> so lang-based branches flip", () => {
    const source = read("lib/i18n.js");
    expect(source).toContain("_applyDocumentLang");
    expect(source).toContain('root.setAttribute("lang", tag)');
    // zh-CN must come from the loaded locale, not a hardcoded document value.
    expect(source).toContain('zh: "zh-CN"');
    expect(source).toContain('en: "en"');
  });

  it("falls back to English instead of rendering bare i18n keys", () => {
    const source = read("lib/i18n.js");
    expect(source).toContain("_fallback");
    expect(source).toContain("_loadEnglishFallback");
    expect(source).toContain("this._fallback");
  });

  it("applies the cached locale before the first paint", () => {
    const source = read("lib/i18n.js");
    // Without this, English users get one frame of Chinese because the HTML
    // shells hardcode lang="zh-CN".
    expect(source).toContain("_readCachedLocale");
    expect(source).toContain("_writeCachedLocale");
    expect(source).toContain("primeLocaleFromCache");
  });

  it("exposes a shared locale helper for inline copy", () => {
    const source = read("react/utils/locale.ts");
    expect(source).toContain("export function isChineseLocale");
    expect(source).toContain("export function normalizeLocale");
    expect(source).toContain("export function currentLocale");
  });
});

describe("localized surfaces that used to be Chinese-only", () => {
  const expectations: Array<[string, string[]]> = [
    ["react/settings/tabs/VoiceTab.tsx", ["Voice input (ASR)", "Save voice settings", "Fallback order"]],
    ["react/settings/tabs/providers/ProviderDetail.tsx", ["Stop local model", "Hardware detection", "Download to this machine"]],
    ["react/components/desk/DeskSkillsSection.tsx", ["Installed skills", "Recommended skills", "Link existing skills"]],
    ["react/components/input/LocalQwenStatusStack.tsx", ["Diagnostics", "Show status"]],
    ["react/components/debug/DiagnosticsPanel.tsx", ["Developer diagnostics", "Startup diagnostics"]],
    ["react/components/voice/JarvisRuntimeOverlay.tsx", ["Voice service unavailable: "]],
    ["react/components/voice/PressToTalkButton.tsx", ["Recording", "Transcribing..."]],
    ["react/components/chat/TtsControlButton.tsx", ["Stop reading", "Reading stopped"]],
    ["react/components/chat/TranslationMenu.tsx", ["Translate reply"]],
    ["react/components/input/DeepResearchPanel.tsx", ["Start research"]],
    ["react/settings/tabs/McpTab.helpers.ts", ["Tencent Docs", "Zhipu vision boost"]],
    ["react/components/input/LocalModelSetupChoice.tsx", ["Install option", "main model", "Reserve about"]],
    ["react/onboarding/steps/LocalModelDownloadStep.tsx", ["Pause download", "Resume download", "Download paused."]],
    ["react/components/input/useLocalQwenStatusController.ts", ["is not running", "Could not start"]],
    ["react/components/input/local-qwen-status.ts", ["Local Qwen3.8-27B", "No token stats from the service yet"]],
    ["react/components/input/ModelSelector.tsx", ["Assigned by role · ready", "Not started"]],
    ["react/settings/tabs/providers/ProviderDetail.helpers.ts", ["Local Qwen3.8-27B Coder390", "Not enough disk space."]],
    ["react/utils/humanize-ui-error.ts", ["Network connection failed.", "Authentication failed."]],
    ["react/settings/store.ts", ["Not configured", "Sign-in required"]],
    ["react/components/ActivityPanel.tsx", ["Open session", "Parallel tasks"]],
    ["react/components/voice/JarvisRuntimeOverlay.tsx", ["voice connection failed: ", "Speech recognition"]],
    ["react/services/websocket.ts", ["Connecting WebSocket", "WebSocket connection error"]],
    ["react/components/input/usePlaceholderRotation.ts", ["Drag files here to add context", "Type / to see quick commands"]],
    ["react/settings/helpers.ts", ["Tencent Hunyuan", "Volcengine (Doubao)"]],
    ["react/components/SessionList.tsx", ["Search sessions, labels and content", "Insights"]],
    ["react/utils/composer-state.ts", ["[Quoted excerpt]", "chars"]],
  ];

  for (const [file, needles] of expectations) {
    it(`${file} ships English copy for its visible text`, () => {
      const source = read(file);
      for (const needle of needles) {
        expect(source).toContain(needle);
      }
    });
  }
});
