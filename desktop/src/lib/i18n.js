/**
 * i18n — 轻量国际化模块
 *
 * 用法：
 *   await i18n.load("zh");           // 加载语言包
 *   t("sidebar.title")               // → "对话"
 *   t("tool.bash.running", { name }) // → "💻 Lynn 正在小心翼翼地用你的电脑"
 *
 * 占位符：{key} 格式，在第二个参数对象中查找替换
 *
 * Per-agent override：
 *   i18n.setAgentOverrides({ thinking: { phrases: ["计算中..."] } })
 *   → t("thinking.phrases") 优先返回 agent 覆盖值，找不到才走全局语言包
 */

const i18n = {
  /** 全局语言包数据 */
  _data: {},

  /**
   * 英文语言包，作为其他语言的兜底。
   * ja / ko / zh-TW 的 key 覆盖落后于 zh/en，缺失时若直接返回 key 本身，
   * 界面上会出现 "settings.providers.keyUnreadable" 这类裸 key。
   */
  _fallback: {},

  /** 英文兜底是否已成功加载（失败时下轮重试） */
  _fallbackLoaded: false,

  /** Per-agent 局部覆盖（同 locale JSON 结构的子集） */
  _agentOverrides: {},

  /** 当前 locale（"zh" / "zh-TW" / "ja" / "ko" / "en"） */
  locale: "zh",

  /** 默认 agent 名（占位符 {name} 的 fallback） */
  defaultName: "Lynn",

  /** localStorage key：上次成功加载的 locale，用于首帧就选对语言 */
  _STORAGE_KEY: "lynn-locale",

  /** 读取上次的 locale；读不到时返回 null（隐私模式下 localStorage 可能抛错） */
  _readCachedLocale() {
    try {
      return window.localStorage?.getItem(this._STORAGE_KEY) || null;
    } catch {
      return null;
    }
  },

  /** 记住本次 locale，下次冷启动直接用它渲染首帧 */
  _writeCachedLocale(key) {
    try {
      window.localStorage?.setItem(this._STORAGE_KEY, key);
    } catch {
      /* 隐私模式/配额上限：缓存失败不影响本次运行 */
    }
  },

  /**
   * 加载语言包
   * @param {string} locale  "zh-CN" / "zh-TW" / "ja" / "ko" / "en" 等
   */
  async load(locale) {
    const key = this._resolveKey(locale);
    this.locale = key;
    this._writeCachedLocale(key);
    this._applyDocumentLang(key);
    if (key !== "en" && !this._fallbackLoaded) {
      await this._loadEnglishFallback();
    }
    try {
      const res = await fetch(`./locales/${key}.json`);
      if (!res.ok) throw new Error(res.statusText);
      this._data = await res.json();
    } catch (err) {
      console.error(`[i18n] Failed to load locale "${key}":`, err);
      if (key !== "en") {
        this._data = { ...this._fallback };
      } else {
        this._data = {};
      }
    }
  },

  /** 首次需要兜底时抓一次 en.json（失败不影响主语言包） */
  async _loadEnglishFallback() {
    try {
      const res = await fetch("./locales/en.json");
      if (res.ok) {
        this._fallback = await res.json();
        this._fallbackLoaded = true;
      }
    } catch (err) {
      console.warn("[i18n] Failed to load English fallback pack:", err);
    }
  },

  /** locale 字符串 → JSON 文件名 key */
  _resolveKey(locale) {
    if (!locale) return "zh";
    if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
    if (locale.startsWith("zh")) return "zh";
    if (locale.startsWith("ja")) return "ja";
    if (locale.startsWith("ko")) return "ko";
    return "en";
  },

  /**
   * 把当前 locale 同步到 <html lang>。
   * 很多组件用 document.documentElement.lang 判断中英文（DiffViewer、MessageCards、
   * SendButton…），html 里写死的 "zh-CN" 会导致英文界面下这些分支仍走中文。
   * @param {string} key 内部 locale key
   */
  _applyDocumentLang(key) {
    if (typeof document === "undefined") return;
    const tag = {
      zh: "zh-CN",
      "zh-TW": "zh-TW",
      ja: "ja",
      ko: "ko",
      en: "en",
    }[key] || "en";
    const root = document.documentElement;
    if (root) root.setAttribute("lang", tag);
  },

  /**
   * 设置当前 agent 的 locale 覆盖
   * @param {object|null} overrides  部分 locale 对象（同 zh.json 结构的子集），null 清空
   */
  setAgentOverrides(overrides) {
    this._agentOverrides = overrides || {};
  },

  /**
   * 按 dot path 取值（agent override > 全局语言包）
   * @param {string} path  如 "sidebar.title" 或 "tool.bash.running"
   * @returns {*}
   */
  _get(path) {
    const keys = path.split(".");
    const override = keys.reduce((obj, k) => obj?.[k], this._agentOverrides);
    if (override !== undefined && override !== null) return override;
    const value = keys.reduce((obj, k) => obj?.[k], this._data);
    if (value !== undefined && value !== null) return value;
    // 当前语言缺失 → 用英文兜底，避免界面直接显示裸 key
    return keys.reduce((obj, k) => obj?.[k], this._fallback);
  },

  /**
   * 翻译
   * @param {string} path   如 "sidebar.title"
   * @param {object} [vars] 占位符变量，如 { name: "Lynn", n: 3 }
   * @returns {string}
   */
  t(path, vars) {
    let val = this._get(path);
    if (val === undefined || val === null) return path; // fallback: 返回 key 本身
    if (typeof val !== "string") return val;

    // 替换占位符
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        val = val.replaceAll(`{${k}}`, v);
      }
    }
    // 未提供 name 时用 defaultName
    val = val.replaceAll("{name}", this.defaultName);

    return val;
  },
};

/**
 * 快捷函数
 * @param {string} path
 * @param {object} [vars]
 * @returns {string}
 */
function t(path, vars) {
  return i18n.t(path, vars);
}

// React module 通过 window.i18n / window.t 访问
window.i18n = i18n;
window.t = t;

// 首帧就选对语言：<html lang> 在 HTML 里写死为 zh-CN，English 用户会先看到一帧
// 中文（部分组件直接读 document.documentElement.lang）。这里在脚本求值阶段
// 用上次缓存的 locale 立刻修正，正式语言包仍由 initApp() 的 i18n.load() 覆盖。
(function primeLocaleFromCache() {
  const cached = i18n._readCachedLocale();
  if (!cached) return;
  const key = i18n._resolveKey(cached);
  i18n.locale = key;
  i18n._applyDocumentLang(key);
})();
