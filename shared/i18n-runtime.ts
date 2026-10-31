/**
 * Shared i18n runtime — 从 locale JSON 加载翻译
 */
import fs from "fs";
import path from "path";
import { fromRoot } from "./lynn-root.js";

const localesDir = fromRoot("desktop", "src", "locales");

let data: Record<string, unknown> = {};
let currentLocale = "zh";

/**
 * locale 字符串 → JSON 文件名 key
 */
function resolveKey(locale?: string | null): string {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

/**
 * 加载语言包
 * @param {string} locale  config.yaml 里的 locale 值，如 "zh-CN" / "zh-TW" / "ja" / "ko" / "en"
 */
export function loadLocale(locale?: string | null): void {
  const key = resolveKey(locale);
  currentLocale = key;
  try {
    const file = path.join(localesDir, `${key}.json`);
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[i18n] Failed to load locale "${key}":`, message);
    if (key !== "en") {
      try {
        data = JSON.parse(fs.readFileSync(path.join(localesDir, "en.json"), "utf-8"));
      } catch { data = {}; }
    } else {
      data = {};
    }
  }
}

/**
 * 按 dot path 取值
 */
function get(p: string): unknown {
  return p.split(".").reduce<unknown>((obj, k) => {
    if (!obj || typeof obj !== "object") return undefined;
    return (obj as Record<string, unknown>)[k];
  }, data);
}

/**
 * 翻译
 * @param {string} path
 * @param {object} [vars]  占位符变量
 * @returns {string}
 */
export function t(path: string, vars?: Record<string, unknown>): string {
  let val = get(path);
  if (val === undefined || val === null) return path;
  if (typeof val !== "string") return String(val);
  let text = val;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, () => String(v));
    }
  }
  return text;
}

export function getLocale(): string {
  return currentLocale;
}
