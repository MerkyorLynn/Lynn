/**
 * i18n.ts — tiny, dependency-free localization for the Lynn CLI.
 *
 * Lynn is a Chinese-market product (GUI defaults to zh; README is 中文-first),
 * so the CLI defaults to Chinese. A user's POSIX `LANG` is intentionally NOT
 * consulted for the default — many Chinese users run an `en_US.UTF-8` locale and
 * would otherwise get an all-English CLI. English is an explicit opt-in via
 * `LYNN_LANG=en` (or `LYNN_LOCALE=en`).
 *
 * Scope note: only the first-impression / interactive surfaces are localized in
 * this pass (startup tips, offline hint, code placeholder/tip, mock output,
 * spinner labels). `lynn help` usage text and deep error strings stay English for
 * now — tracked as a follow-up.
 */

export type Lang = "zh" | "en";

let cachedLang: Lang | null = null;

/** Resolve the active language from env. Pure — pass `env` in tests. */
export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const explicit = (env.LYNN_LANG || env.LYNN_LOCALE || "").trim().toLowerCase();
  if (explicit.startsWith("en")) return "en";
  if (explicit.startsWith("zh")) return "zh";
  return "zh"; // Chinese-market default; English is opt-in via LYNN_LANG=en
}

export function currentLang(): Lang {
  if (cachedLang == null) cachedLang = detectLang();
  return cachedLang;
}

/** Override the cached language (tests / explicit runtime switch). */
export function setLang(lang: Lang | null): void {
  cachedLang = lang;
}

type Vars = Record<string, string | number>;

const STRINGS: Record<Lang, Record<string, string>> = {
  zh: {
    "tips.banner":
      '提示:lynn -p "问题" 走本地 Brain 路由(默认 MiMo,在 Lynn 客户端配置)。\n' +
      "     聊天 / 代码里用 /fast 低延迟,/think 深度推理。\n" +
      "     lynn providers 配置 CLI 专用 BYOK,lynn help 查看全部命令。",
    "offline.body":
      "Brain 离线 —— 打开 Lynn 客户端即可使用默认 MiMo 路由,或:\n" +
      "  lynn doctor --offline       自检环境\n" +
      "  lynn providers              查看 / 配置 BYOK\n" +
      '  lynn -p "你好" --mock-brain   离线试用',
    "code.placeholder": "描述一个编码任务,或输入 /help",
    "code.tip": "提示:/fast 快速编辑,/think 深度推理,/mode yolo 允许本地改动。",
    "mock.response": "模拟回复:{text}",
    "mock.code": "模拟编码任务:{task}",
    "mock.code.cwd": "目录:{cwd}",
    "mock.code.git": "Git:{status}",
    "mock.vision": "模拟 {command}:{path}",
    "git.clean": "干净",
    "git.dirty": "有改动",
    "spinner.thinking": "Lynn 思考中",
    "spinner.coding": "Lynn 编码中",
    "spinner.reviewing": "Lynn 正在查看工具输出",
  },
  en: {
    "tips.banner":
      'Tip: lynn -p "prompt" uses the local Brain router (MiMo by default, configured in the Lynn client).\n' +
      "     In chat / code, use /fast for low latency or /think for deeper reasoning.\n" +
      "     Run lynn providers for CLI-only BYOK, or lynn help to see every command.",
    "offline.body":
      "Brain offline — open the Lynn client for the default MiMo route, or:\n" +
      "  lynn doctor --offline       check setup\n" +
      "  lynn providers              view / configure BYOK\n" +
      '  lynn -p "hello" --mock-brain   try it offline',
    "code.placeholder": "Describe a coding task, or type /help",
    "code.tip": "Tip: /fast for quick edits, /think for deeper reasoning, /mode yolo to allow local edits.",
    "mock.response": "Mock reply: {text}",
    "mock.code": "Mock code task: {task}",
    "mock.code.cwd": "Directory: {cwd}",
    "mock.code.git": "Git: {status}",
    "mock.vision": "Mock {command}: {path}",
    "git.clean": "clean",
    "git.dirty": "dirty",
    "spinner.thinking": "Lynn is thinking",
    "spinner.coding": "Lynn is coding",
    "spinner.reviewing": "Lynn is reviewing tool output",
  },
};

/** Translate `key` for the active language, interpolating `{var}` placeholders. */
export function t(key: string, vars?: Vars): string {
  const lang = currentLang();
  let value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}
