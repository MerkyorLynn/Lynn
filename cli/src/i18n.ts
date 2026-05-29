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
    "approval.prompt": "允许 {tool} 在 {cwd} 执行?[y/n/a](a = 本次会话全部允许) ",
    "banner.label.model": "模型",
    "banner.label.mode": "模式",
    "banner.label.byok": "BYOK",
    "banner.label.brain": "Brain",
    "banner.label.dir": "目录",
    "banner.hint.model": "/model 切换",
    "banner.hint.mode": "Shift+Tab 切换",
    "banner.hint.providers": "lynn providers",
    "banner.model.default": "MiMo · 经 Brain 路由(自动)",
    "banner.byok.default": "客户端 设置 > Providers",
    "code.route.mock": "模拟 Brain",
    "code.route.brain": "经本地 Brain 路由的 MiMo",
    "code.label.think": "思考",
    "code.maxsteps": "最多 {n} 步",
    "chat.fast": "✓ 快速模式 · 思考关闭(低延迟短回复)",
    "chat.think": "✓ 思考模式 · 推理强度高",
    "chat.cleared": "✓ 上下文已清空",
    "code.fast": "✓ 快速模式 · 思考关闭",
    "code.think": "✓ 思考模式 · 高",
    "help.usage": "用法:",
    "help.alias": "别名:",
    "help.aliasDesc": "lynn(小写)作为兼容别名保留。",
    "help.flags": "常用参数:",
    "providers.title": "Lynn 提供方 / BYOK",
    "providers.byok.gui": "打开 Lynn 客户端 设置 > Providers",
    "providers.byok.configured": "已配置 CLI BYOK 兜底;默认 Brain 路由由客户端 设置 > Providers 控制",
    "providers.byok.unconfigured": "安装 / 打开 Lynn 客户端 设置 > Providers 配置默认路由,或运行 lynn providers set 配置 CLI-only BYOK",
    "providers.keyPolicy": "提供方密钥仅存于 Lynn 设置 / 服务端存储;CLI 不打印也不存储。",
    "providers.route.default": "MiMo · 经本地 Brain 路由(自动)",
    "providers.guide": "默认模型:安装并运行 Lynn 客户端后,CLI 经本地 Brain 路由使用 MiMo。\n无客户端时,CLI-only 模式无法更改默认模型设置。\nCLI-only:用以下命令配置 BYOK(OpenAI 兼容端点):\n  lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id\n用 lynn model 或聊天里的 /model 查看当前路由;用 --brain-url 指向其他本地端点。",
    "chat.help": "/exit 退出聊天\n/clear 清空上下文\n/model 显示模型 / BYOK 路由\n/providers 显示 BYOK 配置\n/fast 低延迟回复\n/think 深度推理\n/reasoning 查看或设置推理模式\n/mode 显示权限模式\n/mode ask|yolo|read-only|workspace|danger 切换权限模式\n/help 显示命令",
    "chat.reasoning.show": "推理:{effort} · 显示 {display}\n用 /fast、/think,或 /reasoning off|auto|low|medium|high|xhigh。",
    "chat.mode.show": "模式:{mode}\n用 /mode yolo 开放本地工具权限,/mode ask 守护模式,或 Shift+Tab 切换。",
    "code.help": "/exit 退出代码模式\n/tools 列出本地编码工具\n/fast 低延迟回复\n/think 深度推理\n/reasoning 查看或设置推理模式\n/model 显示当前 Brain / BYOK 路由\n/providers 显示提供方与 BYOK 配置\n/mode 显示权限模式\n/mode ask 守护型 workspace-write 模式\n/mode yolo 允许本地写入与 shell 命令",
    "code.reasoning.show": "思考:{effort} / 显示 {display}\n用 /fast、/think,或 /reasoning off|auto|low|medium|high|xhigh。",
    "code.mode.show": "模式:{mode}\n用 /mode yolo 开放本地工具权限,或 /mode ask 守护模式。",
    "tool.approval.suffix": " (需审批)",
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
    "approval.prompt": "Allow {tool} in {cwd}? [y/n/a] (a = allow all this session) ",
    "banner.label.model": "model",
    "banner.label.mode": "mode",
    "banner.label.byok": "BYOK",
    "banner.label.brain": "brain",
    "banner.label.dir": "directory",
    "banner.hint.model": "/model to change",
    "banner.hint.mode": "Shift+Tab to toggle",
    "banner.hint.providers": "lynn providers",
    "banner.model.default": "MiMo via Brain router (auto)",
    "banner.byok.default": "client GUI Settings > Providers",
    "code.route.mock": "mock Brain",
    "code.route.brain": "MiMo via local Brain router",
    "code.label.think": "think",
    "code.maxsteps": "max steps {n}",
    "chat.fast": "✓ fast mode · thinking off (short, low-latency replies)",
    "chat.think": "✓ thinking mode · reasoning high",
    "chat.cleared": "✓ context cleared",
    "code.fast": "✓ fast mode · thinking off",
    "code.think": "✓ thinking mode · high",
    "help.usage": "Usage:",
    "help.alias": "Alias:",
    "help.aliasDesc": "lynn is kept as a lowercase compatibility alias.",
    "help.flags": "Common flags:",
    "providers.title": "Lynn Providers / BYOK",
    "providers.byok.gui": "Open Lynn client GUI > Settings > Providers",
    "providers.byok.configured": "CLI BYOK fallback configured; client GUI Settings > Providers controls the default Brain route",
    "providers.byok.unconfigured": "Install/open Lynn client GUI > Settings > Providers for default route, or run lynn providers set for CLI-only BYOK",
    "providers.keyPolicy": "Provider keys stay in Lynn settings/server storage; the CLI does not print or store them.",
    "providers.route.default": "MiMo via local Brain router (auto)",
    "providers.guide": "Default model: with the Lynn client installed and running, the CLI uses MiMo via the local Brain router.\nWithout the client, CLI-only mode cannot change the default model.\nCLI-only: set a BYOK OpenAI-compatible endpoint with:\n  lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id\nUse lynn model or /model in chat to review the route; use --brain-url to point at another local endpoint.",
    "chat.help": "/exit leave chat\n/clear reset context\n/model show model / BYOK route\n/providers show BYOK setup\n/fast low-latency replies\n/think deeper reasoning\n/reasoning show or set reasoning mode\n/mode show permission mode\n/mode ask|yolo|read-only|workspace|danger change permission mode\n/help show commands",
    "chat.reasoning.show": "reasoning: {effort} · display {display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.",
    "chat.mode.show": "mode: {mode}\nUse /mode yolo for full local tool permission, /mode ask for guarded mode, or Shift+Tab to toggle.",
    "code.help": "/exit leave code mode\n/tools list local coding tools\n/fast low-latency replies\n/think deeper reasoning\n/reasoning show or set reasoning mode\n/model show current Brain / BYOK route\n/providers show provider and BYOK setup\n/mode show permission mode\n/mode ask guarded workspace-write mode\n/mode yolo allow local writes and shell commands",
    "code.reasoning.show": "think: {effort} / display {display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.",
    "code.mode.show": "mode: {mode}\nUse /mode yolo for full local tool permission, or /mode ask for guarded mode.",
    "tool.approval.suffix": " (approval required)",
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
