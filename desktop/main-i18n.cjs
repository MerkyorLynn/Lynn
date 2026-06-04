"use strict";

// Main-process i18n, extracted from main.cjs. Pure pieces (resolveLocaleKey,
// interpolate) are unit-tested; the loader takes lynnHome + localesDir injected
// from main.cjs (lynnHome has non-trivial fallbacks there — don't duplicate).
// Stays .cjs because Electron runs main.cjs raw in dev (no .ts loader).

const fs = require("fs");
const path = require("path");

function resolveLocaleKey(locale) {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

function interpolate(text, vars) {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

function createMainI18n({ lynnHome, localesDir }) {
  let data = null;
  function getMainI18n() {
    if (data) return data;
    try {
      // 从 preferences.json 读取全局 locale（和 server/renderer 一致）
      let locale = null;
      try {
        const prefs = JSON.parse(fs.readFileSync(path.join(lynnHome, "preferences.json"), "utf-8"));
        locale = prefs.locale || null;
      } catch { /* preferences.json 不存在时 fallback */ }
      const key = resolveLocaleKey(locale);
      const all = JSON.parse(fs.readFileSync(path.join(localesDir, `${key}.json`), "utf-8"));
      data = all.main || {};
    } catch {
      data = {};
    }
    return data;
  }
  function mt(dotPath, vars, fallback) {
    const d = getMainI18n();
    const val = dotPath.split(".").reduce((obj, k) => obj?.[k], d);
    const text = typeof val === "string" ? val : fallback || dotPath;
    return interpolate(text, vars);
  }
  function resetMainI18n() {
    data = null;
  }
  return { mt, resetMainI18n, getMainI18n };
}

module.exports = { resolveLocaleKey, interpolate, createMainI18n };
