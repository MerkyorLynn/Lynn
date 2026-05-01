/**
 * translate.js — Lynn 内部快速翻译路由
 *
 * POST /api/translate
 *   body: { text, targetLanguage? }
 */

import { Hono } from "hono";
import { translateText } from "../../core/llm-utils.js";
import { normalizeTranslationTarget, TRANSLATION_TARGET_LABELS } from "../chat/translation-intent.js";
import { safeJson } from "../hono-helpers.js";

export const MAX_TRANSLATE_CHARS = 3_000;

export function createTranslateRoute(engine) {
  const route = new Hono();

  route.post("/translate", async (c) => {
    const body = await safeJson(c, {});
    const text = String(body?.text || "").trim();
    if (!text) {
      return c.json({ error: "missing_text" }, 400);
    }
    if (text.length > MAX_TRANSLATE_CHARS) {
      return c.json({
        error: "text_too_long",
        maxChars: MAX_TRANSLATE_CHARS,
      }, 400);
    }

    const rawTarget = body?.targetLanguage;
    const targetLanguage = rawTarget === undefined || String(rawTarget || "").trim() === ""
      ? "中文"
      : normalizeTranslationTarget(rawTarget, null);
    if (!targetLanguage) {
      return c.json({
        error: "invalid_target_language",
        allowedTargets: TRANSLATION_TARGET_LABELS,
      }, 400);
    }
    try {
      const utilConfig = engine.resolveUtilityConfig?.();
      const translated = await translateText(utilConfig, text, targetLanguage, {
        timeoutMs: 60_000,
      });
      const cleaned = String(translated || "").trim();
      if (!cleaned) {
        return c.json({ error: "empty_translation" }, 502);
      }
      return c.json({ text: cleaned, targetLanguage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[translate] failed:", message);
      return c.json({ error: "translate_failed", message }, 502);
    }
  });

  return route;
}
