/**
 * locale.ts — locale helpers shared by the renderer.
 *
 * The i18n module keeps a small set of resolved keys ("zh" / "zh-TW" / "ja" /
 * "ko" / "en"). Several components ship short inline copy that is not (yet) in
 * the locale packs; they must still follow the user's language choice, so they
 * branch on `isChineseLocale()` instead of hardcoding Chinese.
 *
 * Prefer `t('some.key')` for anything that lives in the locale packs. Use these
 * helpers only for inline copy that has an zh/en pair next to it.
 */

export type LocaleKey = 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en';

/** Normalize any locale-ish string into one of the supported pack keys. */
export function normalizeLocale(locale?: string | null): LocaleKey {
  const value = String(locale || '').trim();
  if (value === 'zh-TW' || value === 'zh-Hant') return 'zh-TW';
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

/** The locale currently loaded by lib/i18n.js (falls back to <html lang>). */
export function currentLocale(): string {
  if (typeof window !== 'undefined' && window.i18n?.locale) return String(window.i18n.locale);
  if (typeof document !== 'undefined' && document.documentElement?.lang) {
    return String(document.documentElement.lang);
  }
  return 'zh';
}

/** True for every Chinese variant (zh, zh-TW, zh-Hant, …). */
export function isChineseLocale(locale?: string | null): boolean {
  const value = String(locale ?? currentLocale()).toLowerCase();
  return value.startsWith('zh');
}

/**
 * Pick between an inline Chinese/English pair for the current locale.
 *
 * Usage: `localeText('正在加载', 'Loading')`
 */
export function localeText(zh: string, en: string, locale?: string | null): string {
  return isChineseLocale(locale) ? zh : en;
}

/**
 * Short alias for {@link localeText}, matching the `D(zh, en)` idiom used across
 * the renderer for copy that ships inline rather than in the locale packs.
 */
export const D = localeText;
