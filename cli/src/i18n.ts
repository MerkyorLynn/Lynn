/**
 * i18n.ts — tiny, dependency-free localization for the Lynn CLI.
 *
 * Lynn is a Chinese-market product (GUI defaults to zh; README is 中文-first),
 * so the CLI defaults to Chinese. A user's POSIX `LANG` is intentionally NOT
 * consulted for the default — many Chinese users run an `en_US.UTF-8` locale and
 * would otherwise get an all-English CLI. English is an explicit opt-in via
 * `LYNN_LANG=en` (or `LYNN_LOCALE=en`).
 *
 * Scope note: this intentionally covers the first-impression / interactive
 * surfaces without pulling in a full i18n framework.
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
      '提示:Lynn -p "问题" 走本地 Brain 路由(默认 StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算),MiMo V2.5 Pro 第二兜底)。\n' +
      "     聊天 / 代码里用 /fast 低延迟,/think 深度推理。\n" +
      "     Lynn providers 配置 CLI 专用 BYOK,Lynn help 查看全部命令。",
    "startup.label.model": "模型",
    "startup.label.mode": "权限",
    "startup.label.byok": "BYOK",
    "startup.label.brain": "Brain",
    "startup.label.directory": "目录",
    "startup.hint.model": "/model 切换",
    "startup.hint.mode": "Shift+Tab 切换",
    "startup.hint.dir": "cd / --cwd 切换",
    "startup.byok.default": "客户端 Providers",
    "startup.byok.cliFallback": "CLI BYOK 兜底",
    "status.chat.prefix": "MiMo/Brain",
    "offline.body":
      "默认 StepFun 3.7 Flash→MiMo V2.5 Pro 路由暂不可用(本地 Brain 离线)。你可以直接启动本地 Brain,或配置 CLI-only BYOK:\n" +
      "  Lynn brain start             启动本地 Brain/router\n" +
      "  Lynn doctor --offline       自检环境\n" +
      "  Lynn providers              查看 / 配置 BYOK\n" +
      '  Lynn -p "你好" --mock-brain   离线试用',
    "offline.body.byok": "本地 Brain 离线;将直接使用 CLI BYOK provider:{provider} / {model}。",
    "chat.error.brainOffline": "默认 StepFun 3.7 Flash→MiMo V2.5 Pro 路由不可用:本地 Brain 离线。在终端运行 Lynn brain start 或打开 Lynn 客户端即可使用默认高速路由;也可运行 /providers 配置 CLI-only BYOK。({brainUrl})",
    "brain.recovery.offline": "Brain 离线。运行 Lynn brain start 或打开 Lynn 客户端使用默认 StepFun 3.7 Flash→MiMo V2.5 Pro 路由;也可运行 Lynn providers set --preset stepfun 配置 CLI-only BYOK,或用 --mock-brain 做离线试用。",
    "brain.connection.error": "无法连接 Lynn Brain:{brainUrl}{detail}。",
    "brain.connection.recovery": "打开 Lynn 客户端以启动本地 Brain/router,或用 --brain-url 指向其他兼容端点。",
    "brain.connection.byok": "CLI-only 使用方式:运行 Lynn providers set 配置 BYOK 端点;冒烟测试用 --mock-brain。",
    "brain.error.allProvidersFailed": "默认 StepFun 3.7 Flash→MiMo V2.5 Pro 路由在线,但 Brain v2 当前没有可用 provider。请在 Lynn 客户端 Providers 配置 Brain 路由密钥；只有想让 CLI 脱离客户端单独使用时,才运行: Lynn providers set --preset stepfun --api-key <key>",
    "prompt.empty.retry": "Brain 本轮没有返回可见答案,正在自动重试一次…",
    "prompt.empty": "Brain 没有返回可见答案,请重试。若反复出现,可切换模型或运行 /ask。",
    "prompt.emptyAfterReasoning": "Brain 只返回了隐藏思考,没有返回可见答案。请重试;若反复出现,可切换模型或运行 /ask。",
    "code.placeholder": "/yolo 静默黑灯工厂模式;输入编码任务开始",
    "code.placeholder.yolo": "/yolo 静默黑灯工厂模式;输入编码任务开始",
    "code.placeholder.longrun": "/goal 长任务 · /resume 续跑 · /ask 守护模式",
    "code.placeholder.context": "@文件路径 补全上下文 · /help 查看全部命令",
    "chat.placeholder": "/yolo 静默黑灯工厂模式;输入消息开始",
    "chat.placeholder.yolo": "/yolo 静默黑灯工厂模式;输入消息开始",
    "chat.placeholder.route": "/model 查看 StepFun/MiMo/Spark · /ask 守护模式",
    "chat.placeholder.media": "粘贴图片/音频/视频路径可分析 · /help 查看全部命令",
    "code.tip": "提示:/yolo 进入静默黑灯工厂模式,/fast 快速编辑,/think 深度推理。",
    "code.route.mock": "模拟 Brain",
    "code.route.brain": "经本地 Brain 路由的 StepFun 3.7 Flash→MiMo V2.5 Pro",
    "code.label.think": "思考",
    "code.maxsteps": "最多 {n} 步",
    "chat.fast": "✓ 快速模式 · 思考关闭(低延迟短回复)",
    "chat.think": "✓ 思考模式 · 推理强度高",
    "chat.think.set": "✓ 思考模式 · 推理强度 {value}",
    "chat.cleared": "✓ 上下文已清空",
    "chat.help":
      "/exit 退出聊天\n" +
      "/clear 清空上下文\n" +
      "/version 查看 Lynn CLI 本地版本和当前 Brain 路由\n" +
      "/model 查看 Brain 三段模型路由; /model stepfun|mimo|spark 切换 StepFun 3.7 Flash / MiMo V2.5 Pro / Spark Qwen 3.6 35B A3B\n" +
      "/memory 查看长期记忆; /memory add <事实> 保存长期事实; /memory forget <id> 删除\n" +
      "/tool 查看最近工具详情; /tool <编号> 展开搜索来源/工具结果\n" +
      "/cwd 查看工作目录;默认是启动 Lynn 时终端所在目录,可先 cd 或用 --cwd 指定\n" +
      "/image <图片路径> [问题] 添加图片;也可以直接粘贴图片路径和多段文字\n" +
      "/setup 打开 CLI-only BYOK 三步向导\n" +
      "/providers 查看提供方和 BYOK 设置\n" +
      "/providers set --base-url ... --api-key ... --model ... 配置 CLI BYOK\n" +
      "/providers unset 清除 CLI BYOK\n" +
      "/providers test 测试 CLI BYOK\n" +
      "/fast 低延迟回复\n" +
      "/think low|medium|high 切换推理强度\n" +
      "/reasoning 查看或设置推理模式\n" +
      "/mode 查看权限模式\n" +
      "/yolo 开启零审批 YOLO 模式(本地写入和 shell 命令)\n" +
      "/ask 回到守护模式(workspace-write)\n" +
      "/mode ask|yolo|read-only|workspace|danger 切换权限\n" +
      "/help 显示命令",
    "chat.reasoning.show": "reasoning:{effort} · display {display}\n用 /fast、/think low|medium|high 或 /reasoning off|auto|low|medium|high|xhigh 切换。",
    "chat.mode.show": "mode:{mode}\n用 /yolo 开启零审批本地工具权限,/ask 回到守护模式,或 Shift+Tab 切换。",
    "chat.providers.usage":
      "用法:\n" +
      "  /providers                     查看当前路由\n" +
      "  /providers set --base-url https://api.example.com/v1 --api-key <key> --model model-id\n" +
      "  /providers set --preset stepfun --api-key <key>\n" +
      "  /providers unset               清除 CLI BYOK\n" +
      "  /providers test                测试 CLI BYOK",
    "chat.providers.setUsage":
      "请在一行里给出 OpenAI 兼容三步配置:\n" +
      "  /providers set --base-url https://api.example.com/v1 --api-key <key> --model model-id\n" +
      "或使用 preset:\n" +
      "  /providers set --preset stepfun --api-key <key>",
    "chat.providers.routeReloaded": "✓ 当前聊天路由已刷新:{route}",
    "chat.providers.routeUnchanged": "✓ Provider 配置已处理;当前聊天路由仍是:{route}",
    "chat.image.defaultPrompt": "请分析这些图片。",
    "chat.image.usage": "用法:/image <图片路径> [问题]。也支持 /attach 或直接粘贴图片路径。",
    "chat.image.attached": "已加入图片上下文:{summary}",
    "chat.image.readError": "图片上下文无法读取:{error}",
    "code.fast": "✓ 快速模式 · 思考关闭",
    "code.think": "✓ 思考模式 · 高",
    "code.think.set": "✓ 思考模式 · {value}",
    "code.help":
      "/exit 退出 code 模式\n" +
      "/tools 查看本地编码工具\n" +
      "/fast 低延迟 MiMo/Brain 回复\n" +
      "/think low|medium|high 切换推理强度\n" +
      "/reasoning 查看或设置推理模式\n" +
      "/goal <任务> 穷尽最优模式:300 步预算 + ultra 分解 + 对抗验收 + 自动断点\n" +
      "/best <任务> 同 /goal,显式进入穷尽最优模式\n" +
      "/resume [last|session.jsonl] [说明] 继续上次长任务\n" +
      "/memory 查看长期记忆; /memory add <事实> 保存长期事实; /memory forget <id> 删除\n" +
      "/cwd 查看工作目录;默认是启动 Lynn 时终端所在目录,可先 cd 或用 --cwd 指定\n" +
      "/version 查看 Lynn CLI 本地版本和当前 Brain 路由\n" +
      "/model 查看 Brain 三段模型路由; /model stepfun|mimo|spark 切换 StepFun 3.7 Flash / MiMo V2.5 Pro / Spark Qwen 3.6 35B A3B\n" +
      "/setup 打开 CLI-only BYOK 三步向导\n" +
      "/providers 查看提供方和 BYOK 设置\n" +
      "/providers set --base-url ... --api-key ... --model ... 配置 CLI BYOK\n" +
      "/providers unset 清除 CLI BYOK\n" +
      "/providers test 测试 CLI BYOK\n" +
      "/mode 查看权限模式\n" +
      "/yolo 开启零审批 YOLO 模式(本地写入和 shell 命令)\n" +
      "/ask 回到守护模式(workspace-write)\n" +
      "/mode ask 守护模式(workspace-write)\n" +
      "/mode yolo 允许本地写入和 shell 命令",
    "code.reasoning.show": "think:{effort} / display {display}\n用 /fast、/think low|medium|high 或 /reasoning off|auto|low|medium|high|xhigh 切换。",
    "code.mode.show": "mode:{mode}\n用 /yolo 开启零审批本地工具权限,/ask 回到守护模式。",
    "code.resume.maxSteps": "已保存断点。继续: {command}",
    "code.resume.maxStepsFallback": "已到达步数上限。用 /resume 继续最近的长任务,或用 --resume <session.jsonl> --long。",
    "code.goal.usage": "用法:/goal <长任务描述>。它会开启 300 步预算、ultra 分解、对抗验收和自动断点。",
    "code.goal.started": "已进入穷尽最优模式:300 步预算 + ultra 分解 + 对抗验收 + 自动断点。",
    "code.best.usage": "用法:/best <任务> 或 /exhaustive <任务>。用于需要穷尽方案、并行分派和对抗验收的任务。",
    "code.best.started": "已进入穷尽最优模式:并行分派 + 原子 worker + 对抗验收。",
    "code.resume.started": "继续断点:{resume}",
    "code.session.resumed": "已恢复断点:{path} ({messages} 条上下文)",
    "code.session.saved": "会话已保存:{path}",
    "code.resume.summary": "↻ 续跑 {messages} 条消息{detail}",
    "code.resume.repaired": " · 修复 {n} 个中断工具",
    "code.resume.compacted": " · 旧轮已压缩",
    "code.resume.torn": " · 恢复 {n} 行残损记录",
    "code.resume.task": "↻ 续跑任务:{task}",
    "code.resume.cwdDrift": "⚠ 目录已变:断点存于 {saved},当前在 {current} — 引用的文件可能已移动",
    "code.resume.others": "  其他最近会话:{list}(用 --resume <路径> 指定)",
    "tool.approval.suffix": " (需要确认)",
    "tool.details.unavailable.short": "无展开明细",
    "tool.details.unavailable": "Brain 只返回了工具开始/结束状态,没有提供搜索摘要或来源明细。",
    "mode.yolo.enabled": "YOLO 静默黑灯工厂模式已开启。",
    "mode.ask.enabled": "守护模式已开启。",
    "mode.readonly.enabled": "只读模式已开启。",
    "mode.workspace.enabled": "工作区写入模式已开启。",
    "mode.danger.enabled": "YOLO full-access 模式已开启。",
    "mode.unknown": "未知权限模式:{raw}。试试 /ask 或 /yolo。",
    "mode.danger.warning": "YOLO 模式会直接编辑本地文件并运行 shell 命令,不再逐次询问。",
    "mode.yolo.factory": "YOLO 静默黑灯工厂模式:本地编辑和 shell 命令不再逐条询问。",
    "code.danger.warning": "YOLO 模式可直接编辑文件并运行 shell 命令,不会逐次询问。",
    "reasoning.effortSet": "推理强度已设为 {value}。",
    "reasoning.displayAlways": "推理显示已设为:始终。",
    "reasoning.displayNever": "推理显示已设为:从不。",
    "reasoning.unknown": "未知的推理模式:{raw}。",
    "reasoning.state": "推理:{effort} · 显示 {display}",
    "code.reasoning.state": "思考:{effort} / 显示 {display}",
    "approval.prompt": "选择 [y/a/n] > ",
    "approval.card.title": "需要授权: {tool}",
    "approval.card.cwd": "目录:",
    "approval.card.preview": "预览:",
    "approval.card.omitted": "... 省略 {n} 行",
    "approval.card.once": "允许一次",
    "approval.card.session": "本次会话全部允许",
    "approval.card.deny": "拒绝",
    "slash.unknown": "未知命令 · 输入 /help 查看全部命令",
    "slash.label.model": "路由/模型",
    "slash.label.providers": "BYOK",
    "slash.label.mode": "权限",
    "slash.label.fast": "快速",
    "slash.label.think": "推理",
    "slash.label.help": "帮助",
    "slash.label.exit": "退出",
    "slash.label.tools": "工具",
    "slash.label.clear": "清空",
    "slash.label.image": "图片",
    "slash.label.yolo": "静默工厂",
    "slash.label.ask": "守护模式",
    "slash.tabHint": "Tab 补全",
    "slash.moreHint": "继续输入筛选 · Tab 补全 · /help 查看全部",
    "cwd.info": "工作目录:{cwd}\n默认是你启动 Lynn 时终端所在的目录。切换方式:\n  cd /path/to/project && Lynn\n  Lynn code --cwd /path/to/project \"任务\"",
    "banner.label.model": "模型",
    "banner.label.mode": "模式",
    "banner.label.byok": "BYOK",
    "banner.label.brain": "Brain",
    "banner.label.dir": "目录",
    "banner.hint.model": "/model 切换",
    "banner.hint.mode": "Shift+Tab 切换",
    "banner.hint.providers": "Lynn providers",
    "banner.hint.dir": "cd / --cwd 切换",
    "banner.model.default": "StepFun 3.7 Flash → MiMo V2.5 Pro · Brain(自动)",
    "banner.byok.default": "客户端 Providers",
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
    "spinner.grounding": "Lynn 正在定位画面",
    "spinner.seeing": "Lynn 正在查看图片",
    "vision.error.imageRequired": "{command} 需要一个图片路径。",
    "providers.title": "Lynn 提供方 / BYOK",
    "providers.currentRoute": "当前路由",
    "providers.defaultRoute": "默认路由",
    "providers.brainUrl": "Brain URL",
    "providers.brainRoute": "Brain 路由",
    "providers.localServer": "客户端服务",
    "providers.byokEntry": "BYOK 入口",
    "providers.cliByok": "CLI BYOK",
    "providers.configured": "已配置",
    "providers.none": "暂未检测到",
    "providers.byok.default": "打开 Lynn 客户端 > 设置 > Providers",
    "providers.byok.gui": "打开 Lynn 客户端 设置 > Providers",
    "providers.byok.missing": "默认路由由本地 Brain 提供(运行 Lynn brain start 或打开 Lynn 客户端);或运行 Lynn providers set 配置 CLI-only BYOK",
    "providers.byok.unconfigured": "默认路由由本地 Brain 提供(运行 Lynn brain start 或打开 Lynn 客户端);或运行 Lynn providers set 配置 CLI-only BYOK",
    "providers.byok.configured": "已配置 CLI BYOK fallback;默认 Brain 路由仍由 Lynn 客户端设置 > Providers 控制",
    "providers.keyPolicy": "供应商密钥保存在 Lynn 客户端设置或 CLI 本地配置文件中;终端只显示脱敏值。",
    "providers.route.default": "StepFun 3.7 Flash → MiMo V2.5 Pro → Spark Qwen 3.6 35B A3B · 经本地 Brain 路由(自动)",
    "providers.defaultNote": "默认模型: CLI 通过本地 Brain/router 先用 StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算),MiMo V2.5 Pro 作为第二位多模态/原生搜索兜底,Spark Qwen 3.6 35B A3B 第三位本地兜底。需要本地 Brain 在线;可运行 Lynn brain start 或打开 Lynn 客户端。",
    "providers.clientNote": "没有客户端时,CLI-only 模式不能修改默认模型设置。",
    "providers.cliNote": "CLI-only: 可用 OpenAI 兼容三步配置 BYOK:",
    "providers.routeHint": "用 Lynn model 或聊天里的 /model 查看路由;用 --brain-url 指向其他本地端点。",
    "models.title": "Lynn 模型 / Brain 路由",
    "models.defaultOrder": "默认 Brain V2 顺序:",
    "models.currentRoute": "当前 CLI 路由",
    "models.brainRoute": "Brain 实时路由",
    "models.note.fixed": "默认 Brain V2 顺序固定为 StepFun 3.7 Flash → MiMo V2.5 Pro → Spark Qwen 3.6 35B A3B。",
    "models.note.byok": "CLI-only BYOK 可用这三个全称 preset;不配置 BYOK 时由本地 Brain 自动路由:",
    "providers.saved": "已保存 CLI BYOK provider。",
    "providers.savedHint": "当 Lynn 客户端/Brain 离线时,Lynn CLI 会用这个 provider 作为直接 fallback。",
    "providers.unset.deleted": "已清除 CLI-only BYOK provider。",
    "providers.unset.missing": "没有 CLI-only BYOK provider 需要清除。",
    "providers.unset.path": "配置文件",
    "providers.unset.hint": "之后 CLI 会回到默认 Lynn 客户端 StepFun 3.7 Flash→MiMo V2.5 Pro 路由;如需重新设置,运行 Lynn providers set。",
    "providers.presets.title": "Lynn CLI BYOK Presets",
    "providers.presets.model": "模型",
    "providers.presets.url": "URL",
    "providers.presets.about": "说明",
    "providers.presets.use": "使用",
    "providers.presets.note": "Preset 只填 API URL 和模型名;API key 仍需用户自己提供,不会内置。",
    "providers.test.ok": "Provider 测试通过",
    "providers.test.fail": "Provider 测试失败",
    "providers.test.latency": "延迟",
    "providers.test.preview": "预览",
    "providers.test.error": "错误",
    "providers.test.noProfile": "还没有 CLI BYOK provider 配置。",
    "providers.test.hint": "先运行: Lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id",
    "providers.wizard.title": "Lynn CLI BYOK 设置(OpenAI 兼容)",
    "providers.wizard.step1": "第 1/3 步:API URL",
    "providers.wizard.step1.help": "从提供商文档复制 OpenAI 兼容 base URL,通常以 /v1 结尾。",
    "providers.wizard.step1.examples": "示例:https://api.openai.com/v1,https://api.deepseek.com/v1,https://dashscope.aliyuncs.com/compatible-mode/v1",
    "providers.wizard.baseUrl": "API URL",
    "providers.wizard.step2": "第 2/3 步:API Key",
    "providers.wizard.step2.help": "在提供商控制台创建或复制 API key。Lynn 会本地保存,终端输出会脱敏。",
    "providers.wizard.apiKey": "API Key",
    "providers.wizard.apiKey.keep": "API Key [保留 {key}] ",
    "providers.wizard.step3": "第 3/3 步:Model name",
    "providers.wizard.step3.help": "从提供商模型列表复制精确 model id,例如 gpt-4o、deepseek-chat、qwen-plus 或你的自定义模型名。",
    "providers.wizard.model": "Model name",
    "agents.title": "Lynn worker agents",
    "agents.headless.title": "给其他智能体 / CLI Fleet 的无交互调用:",
    "agents.node.prereq": "前置:需要 Node.js 20 LTS 或 22 LTS + npm。macOS:brew install node@20;Linux/macOS:nvm install 20;Windows:winget install OpenJS.NodeJS.LTS",
    "agents.install.title": "安装:",
    "agents.launch.title": "启动:",
    "agents.headless.commands": "静默调用:",
    "agents.tip": "提示:内置 profile 通过 Lynn worker run 运行;外部 agent 需要已安装并在 PATH 中。",
    "permissions.saved": "已保存 CLI 权限配置。",
    "permissions.title": "Lynn CLI 权限",
    "permissions.approval": "审批",
    "permissions.sandbox": "沙盒",
    "permissions.source": "来源",
    "permissions.dataDir": "数据目录",
    "permissions.profile": "配置文件",
    "permissions.profile.missing": "{path} (未找到)",
    "permissions.precedence": "优先级:CLI 参数 > 环境变量 > Lynn 客户端权限配置 > 默认值。",
    "permissions.interop": "客户端互通:Lynn 客户端 Settings > Permissions 会写入同一份 profile。",
    "permissions.warning": "警告:YOLO/full-access 模式会直接编辑文件并运行 shell 命令,不再逐次询问。",
    "update.available": "发现 Lynn CLI 新版本 {version}{build}。现在更新吗? [y/N]",
    "update.installing": "正在更新 Lynn CLI...当前会话会继续使用现有版本。",
    "update.installed": "Lynn CLI 已更新。新开一个终端或重新运行 Lynn 即可使用新版。",
    "update.failed": "Lynn CLI 更新失败:{message}。当前版本不受影响,稍后可再试。",
    "update.skipped": "已跳过更新,继续使用当前版本。",
  },
  en: {
    "tips.banner":
      'Tip: Lynn -p "prompt" uses the local Brain router (StepFun 3.7 Flash first (256K context; high reasoning with a 32K reasoning/generation budget), MiMo V2.5 Pro second).\n' +
      "     In chat / code, use /fast for low latency or /think for deeper reasoning.\n" +
      "     Run Lynn providers for CLI-only BYOK, or Lynn help to see every command.",
    "startup.label.model": "model",
    "startup.label.mode": "mode",
    "startup.label.byok": "BYOK",
    "startup.label.brain": "brain",
    "startup.label.directory": "directory",
    "startup.hint.model": "/model to change",
    "startup.hint.mode": "Shift+Tab to toggle",
    "startup.hint.dir": "cd / --cwd",
    "startup.byok.default": "client Providers",
    "startup.byok.cliFallback": "CLI BYOK fallback",
    "status.chat.prefix": "MiMo/Brain",
    "offline.body":
      "Default StepFun 3.7 Flash→MiMo V2.5 Pro route unavailable (local Brain offline). Start the local Brain, or configure CLI-only BYOK:\n" +
      "  Lynn brain start             start local Brain/router\n" +
      "  Lynn doctor --offline       check setup\n" +
      "  Lynn providers              view / configure BYOK\n" +
      '  Lynn -p "hello" --mock-brain   try it offline',
    "offline.body.byok": "Local Brain is offline; using CLI BYOK provider directly: {provider} / {model}.",
    "chat.error.brainOffline": "Default StepFun 3.7 Flash→MiMo V2.5 Pro route unavailable: local Brain is offline. Run Lynn brain start in your terminal or open the Lynn client for the default fast route; run /providers to configure CLI-only BYOK. ({brainUrl})",
    "brain.recovery.offline": "Brain offline. Run Lynn brain start or open the Lynn client for StepFun 3.7 Flash→MiMo V2.5 Pro; configure CLI BYOK with Lynn providers set --preset stepfun, or run with --mock-brain.",
    "brain.connection.error": "Could not reach Lynn Brain at {brainUrl}{detail}.",
    "brain.connection.recovery": "Start the Lynn client GUI so the local Brain/router is running, or pass --brain-url to another compatible endpoint.",
    "brain.connection.byok": "For CLI-only use, run Lynn providers set with your BYOK endpoint; for smoke tests, use --mock-brain.",
    "brain.error.allProvidersFailed": "The default StepFun 3.7 Flash→MiMo V2.5 Pro route is online, but Brain v2 has no usable provider. Configure Brain route keys in the Lynn client Providers page; use Lynn providers set --preset stepfun --api-key <key> only for CLI-only BYOK without the client.",
    "prompt.empty.retry": "Brain returned no visible answer for this turn; retrying once automatically...",
    "prompt.empty": "Brain returned no visible answer. Please retry; if this repeats, switch model or use /ask.",
    "prompt.emptyAfterReasoning": "Brain returned hidden reasoning but no visible answer. Please retry; if this repeats, switch model or use /ask.",
    "code.placeholder": "/yolo for silent factory mode; type a coding task",
    "code.placeholder.yolo": "/yolo for silent factory mode; type a coding task",
    "code.placeholder.longrun": "/goal long task · /resume continue · /ask guarded mode",
    "code.placeholder.context": "@file path for context · /help for all commands",
    "chat.placeholder": "/yolo for silent factory mode; type a message",
    "chat.placeholder.yolo": "/yolo for silent factory mode; type a message",
    "chat.placeholder.route": "/model shows StepFun/MiMo/Spark · /ask guarded mode",
    "chat.placeholder.media": "Paste image/audio/video paths to analyze · /help for commands",
    "code.tip": "Tip: /yolo for silent factory mode, /fast for quick edits, /think for deeper reasoning.",
    "code.route.mock": "mock Brain",
    "code.route.brain": "StepFun 3.7 Flash→MiMo V2.5 Pro via local Brain router",
    "code.label.think": "think",
    "code.maxsteps": "max steps {n}",
    "chat.fast": "✓ fast mode · thinking off (short, low-latency replies)",
    "chat.think": "✓ thinking mode · reasoning high",
    "chat.think.set": "✓ thinking mode · reasoning {value}",
    "chat.cleared": "✓ context cleared",
    "chat.help":
      "/exit leave chat\n" +
      "/clear reset context\n" +
      "/version show the local Lynn CLI version and current Brain route\n" +
      "/model show the three Brain model choices; /model stepfun|mimo|spark switches StepFun 3.7 Flash / MiMo V2.5 Pro / Spark Qwen 3.6 35B A3B\n" +
      "/memory show durable memory; /memory add <fact> save a durable fact; /memory forget <id> delete\n" +
      "/tool show recent tool details; /tool <id> expands search sources/tool output\n" +
      "/cwd show working directory; default is the terminal directory where Lynn started, use cd or --cwd to change\n" +
      "/image <image-path> [prompt] attach images; pasted image paths and multi-line text work too\n" +
      "/setup open the CLI-only BYOK three-step wizard\n" +
      "/providers show BYOK setup\n" +
      "/providers set --base-url ... --api-key ... --model ... configure CLI BYOK\n" +
      "/providers unset clear CLI BYOK\n" +
      "/providers test test CLI BYOK\n" +
      "/fast low-latency replies\n" +
      "/think low|medium|high switch reasoning effort\n" +
      "/reasoning show or set reasoning mode\n" +
      "/mode show permission mode\n" +
      "/yolo enable zero-prompt YOLO mode for local writes and shell commands\n" +
      "/ask return to guarded workspace-write mode\n" +
      "/mode ask|yolo|read-only|workspace|danger change permission mode\n" +
      "/help show commands",
    "chat.reasoning.show": "reasoning: {effort} · display {display}\nUse /fast, /think low|medium|high, or /reasoning off|auto|low|medium|high|xhigh.",
    "chat.mode.show": "mode: {mode}\nUse /yolo for zero-prompt local tool permission, /ask for guarded mode, or Shift+Tab to toggle.",
    "chat.providers.usage":
      "Usage:\n" +
      "  /providers                     show current route\n" +
      "  /providers set --base-url https://api.example.com/v1 --api-key <key> --model model-id\n" +
      "  /providers set --preset stepfun --api-key <key>\n" +
      "  /providers unset               clear CLI BYOK\n" +
      "  /providers test                test CLI BYOK",
    "chat.providers.setUsage":
      "Provide the OpenAI-compatible three-step setup in one line:\n" +
      "  /providers set --base-url https://api.example.com/v1 --api-key <key> --model model-id\n" +
      "or use a preset:\n" +
      "  /providers set --preset stepfun --api-key <key>",
    "chat.providers.routeReloaded": "✓ Chat route refreshed: {route}",
    "chat.providers.routeUnchanged": "✓ Provider command handled; chat route is still: {route}",
    "chat.image.defaultPrompt": "Please analyze these images.",
    "chat.image.usage": "Usage: /image <image-path> [prompt]. /attach and pasted image paths work too.",
    "chat.image.attached": "Attached image context: {summary}",
    "chat.image.readError": "Could not read image context: {error}",
    "code.fast": "✓ fast mode · thinking off",
    "code.think": "✓ thinking mode · high",
    "code.think.set": "✓ thinking mode · {value}",
    "code.help":
      "/exit leave code mode\n" +
      "/tools list local coding tools\n" +
      "/fast low-latency MiMo/Brain replies\n" +
      "/think low|medium|high switch reasoning effort\n" +
      "/reasoning show or set reasoning mode\n" +
      "/goal <task> exhaustive best mode: 300-step budget + ultra decomposition + adversarial verification + checkpoints\n" +
      "/best <task> same as /goal, explicit exhaustive-best mode\n" +
      "/resume [last|session.jsonl] [note] continue a saved long task\n" +
      "/memory show durable memory; /memory add <fact> save a durable fact; /memory forget <id> delete\n" +
      "/cwd show working directory; default is the terminal directory where Lynn started, use cd or --cwd to change\n" +
      "/version show the local Lynn CLI version and current Brain route\n" +
      "/model show the three Brain model choices; /model stepfun|mimo|spark switches StepFun 3.7 Flash / MiMo V2.5 Pro / Spark Qwen 3.6 35B A3B\n" +
      "/setup open the CLI-only BYOK three-step wizard\n" +
      "/providers show provider and BYOK setup\n" +
      "/providers set --base-url ... --api-key ... --model ... configure CLI BYOK\n" +
      "/providers unset clear CLI BYOK\n" +
      "/providers test test CLI BYOK\n" +
      "/mode show permission mode\n" +
      "/yolo enable zero-prompt YOLO mode for local writes and shell commands\n" +
      "/ask return to guarded workspace-write mode\n" +
      "/mode ask guarded workspace-write mode\n" +
      "/mode yolo allow local writes and shell commands",
    "code.reasoning.show": "think: {effort} / display {display}\nUse /fast, /think low|medium|high, or /reasoning off|auto|low|medium|high|xhigh.",
    "code.mode.show": "mode: {mode}\nUse /yolo for zero-prompt local tool permission or /ask for guarded mode.",
    "code.resume.maxSteps": "Checkpoint saved. Continue with: {command}",
    "code.resume.maxStepsFallback": "Step budget reached. Use /resume for the latest long task, or --resume <session.jsonl> --long.",
    "code.goal.usage": "Usage: /goal <long-running task>. It enables a 300-step budget, ultra decomposition, adversarial verification, and automatic checkpoints.",
    "code.goal.started": "Exhaustive best mode enabled: 300-step budget + ultra decomposition + adversarial verification + checkpoints.",
    "code.best.usage": "Usage: /best <task> or /exhaustive <task>. Use it for exhaustive options, parallel dispatch, and adversarial verification.",
    "code.best.started": "Exhaustive best mode enabled: parallel dispatch + atomic workers + adversarial verification.",
    "code.resume.started": "Resuming checkpoint: {resume}",
    "code.session.resumed": "Resumed checkpoint: {path} ({messages} messages)",
    "code.session.saved": "Session saved: {path}",
    "code.resume.summary": "↻ Resumed {messages} messages{detail}",
    "code.resume.repaired": " · repaired {n} interrupted tool(s)",
    "code.resume.compacted": " · older turns compacted",
    "code.resume.torn": " · recovered {n} torn line(s)",
    "code.resume.task": "↻ Resuming task: {task}",
    "code.resume.cwdDrift": "⚠ Directory changed: checkpoint saved in {saved}, now in {current} — referenced files may have moved",
    "code.resume.others": "  Other recent sessions: {list} (use --resume <path>)",
    "tool.approval.suffix": " (approval required)",
    "tool.details.unavailable.short": "no expanded detail",
    "tool.details.unavailable": "Brain returned only tool start/end status and did not include a search summary or source details.",
    "mode.yolo.enabled": "YOLO silent factory mode enabled.",
    "mode.ask.enabled": "Guarded mode enabled.",
    "mode.readonly.enabled": "Read-only mode enabled.",
    "mode.workspace.enabled": "Workspace-write mode enabled.",
    "mode.danger.enabled": "YOLO full-access mode enabled.",
    "mode.unknown": "Unknown mode: {raw}. Try /ask or /yolo.",
    "mode.danger.warning": "YOLO mode can edit local files and run shell commands without asking again.",
    "mode.yolo.factory": "YOLO silent factory mode: local edits and shell commands run without per-step prompts.",
    "code.danger.warning": "YOLO mode can edit files and run shell commands without asking.",
    "reasoning.effortSet": "Reasoning effort set to {value}.",
    "reasoning.displayAlways": "Reasoning display set to always.",
    "reasoning.displayNever": "Reasoning display set to never.",
    "reasoning.unknown": "Unknown reasoning mode: {raw}.",
    "reasoning.state": "reasoning: {effort} · display {display}",
    "code.reasoning.state": "think: {effort} / display {display}",
    "approval.prompt": "Choose [y/a/n] > ",
    "approval.card.title": "Approval required: {tool}",
    "approval.card.cwd": "cwd:",
    "approval.card.preview": "preview:",
    "approval.card.omitted": "... omitted {n} line(s)",
    "approval.card.once": "allow once",
    "approval.card.session": "allow all this session",
    "approval.card.deny": "deny",
    "slash.unknown": "unknown command · type /help",
    "slash.label.model": "route/model",
    "slash.label.providers": "BYOK",
    "slash.label.mode": "permissions",
    "slash.label.fast": "fast",
    "slash.label.think": "reasoning",
    "slash.label.help": "help",
    "slash.label.exit": "exit",
    "slash.label.tools": "tools",
    "slash.label.clear": "clear",
    "slash.label.image": "image",
    "slash.label.yolo": "silent factory",
    "slash.label.ask": "guarded",
    "slash.tabHint": "Tab completes",
    "slash.moreHint": "keep typing to filter · Tab completes · /help shows all",
    "cwd.info": "working directory:{cwd}\nDefault is the terminal directory where Lynn was started. To change it:\n  cd /path/to/project && Lynn\n  Lynn code --cwd /path/to/project \"task\"",
    "banner.label.model": "model",
    "banner.label.mode": "mode",
    "banner.label.byok": "BYOK",
    "banner.label.brain": "brain",
    "banner.label.dir": "directory",
    "banner.hint.model": "/model to change",
    "banner.hint.mode": "Shift+Tab to toggle",
    "banner.hint.providers": "Lynn providers",
    "banner.hint.dir": "cd / --cwd",
    "banner.model.default": "StepFun 3.7 Flash → MiMo V2.5 Pro via Brain (auto)",
    "banner.byok.default": "client Providers",
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
    "spinner.grounding": "Lynn is grounding",
    "spinner.seeing": "Lynn is seeing",
    "vision.error.imageRequired": "{command} requires an image path.",
    "providers.title": "Lynn Providers / BYOK",
    "providers.currentRoute": "Current route",
    "providers.defaultRoute": "Default route",
    "providers.brainUrl": "Brain URL",
    "providers.brainRoute": "Brain route",
    "providers.localServer": "Local server",
    "providers.byokEntry": "BYOK entry",
    "providers.cliByok": "CLI BYOK",
    "providers.configured": "Configured",
    "providers.none": "none detected yet",
    "providers.byok.default": "Open Lynn client GUI > Settings > Providers",
    "providers.byok.gui": "Open Lynn client GUI > Settings > Providers",
    "providers.byok.missing": "The default route is served by local Brain (run Lynn brain start or open Lynn client GUI), or run Lynn providers set for CLI-only BYOK",
    "providers.byok.unconfigured": "The default route is served by local Brain (run Lynn brain start or open Lynn client GUI), or run Lynn providers set for CLI-only BYOK",
    "providers.byok.configured": "CLI BYOK fallback configured; client GUI Settings > Providers controls the default Brain route",
    "providers.keyPolicy": "Provider keys stay in Lynn client settings or the local CLI profile; terminal output shows only redacted values.",
    "providers.route.default": "StepFun 3.7 Flash → MiMo V2.5 Pro → Spark Qwen 3.6 35B A3B via local Brain router (auto)",
    "providers.defaultNote": "Default model: CLI uses StepFun 3.7 Flash first (256K context; high reasoning with a 32K reasoning/generation budget) through the local Brain/router, MiMo V2.5 Pro second as the multimodal/native-search fallback, and Spark Qwen 3.6 35B A3B third as the local fallback. Local Brain must be online; run Lynn brain start or open the Lynn client GUI.",
    "providers.clientNote": "Without the client GUI, default model settings cannot be changed from CLI-only mode.",
    "providers.cliNote": "CLI-only: set a BYOK OpenAI-compatible endpoint with:",
    "providers.routeHint": "Use Lynn model or /model in chat to review this route. Use --brain-url to point at another local endpoint.",
    "models.title": "Lynn Models / Brain Route",
    "models.defaultOrder": "Default Brain V2 order:",
    "models.currentRoute": "Current CLI route",
    "models.brainRoute": "Live Brain route",
    "models.note.fixed": "Default Brain V2 order is fixed as StepFun 3.7 Flash -> MiMo V2.5 Pro -> Spark Qwen 3.6 35B A3B.",
    "models.note.byok": "CLI-only BYOK can use these three full-name presets; without BYOK, local Brain routes automatically:",
    "providers.saved": "Saved CLI BYOK provider.",
    "providers.savedHint": "When Lynn client GUI/Brain is offline, Lynn CLI will use this provider as a direct fallback.",
    "providers.unset.deleted": "Cleared CLI-only BYOK provider.",
    "providers.unset.missing": "No CLI-only BYOK provider was configured.",
    "providers.unset.path": "profile",
    "providers.unset.hint": "The CLI will now return to the default Lynn client StepFun 3.7 Flash→MiMo V2.5 Pro route. Run Lynn providers set to configure BYOK again.",
    "providers.presets.title": "Lynn CLI BYOK Presets",
    "providers.presets.model": "model",
    "providers.presets.url": "URL",
    "providers.presets.about": "about",
    "providers.presets.use": "use",
    "providers.presets.note": "Presets fill only API URL and model name; users still provide their own API key.",
    "providers.test.ok": "Provider test OK",
    "providers.test.fail": "Provider test failed",
    "providers.test.latency": "latency",
    "providers.test.preview": "preview",
    "providers.test.error": "error",
    "providers.test.noProfile": "No CLI BYOK provider is configured yet.",
    "providers.test.hint": "Run: Lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id",
    "providers.wizard.title": "Lynn CLI BYOK setup (OpenAI-compatible)",
    "providers.wizard.step1": "Step 1/3: API URL",
    "providers.wizard.step1.help": "Paste the OpenAI-compatible base URL from your provider docs. It usually ends with /v1.",
    "providers.wizard.step1.examples": "Examples: https://api.openai.com/v1, https://api.deepseek.com/v1, https://dashscope.aliyuncs.com/compatible-mode/v1",
    "providers.wizard.baseUrl": "API URL",
    "providers.wizard.step2": "Step 2/3: API Key",
    "providers.wizard.step2.help": "Create or copy an API key from your provider console. Lynn stores it locally and redacts it in terminal output.",
    "providers.wizard.apiKey": "API Key",
    "providers.wizard.apiKey.keep": "API Key [keep {key}] ",
    "providers.wizard.step3": "Step 3/3: Model name",
    "providers.wizard.step3.help": "Copy the exact model id from your provider's model list, for example gpt-4o, deepseek-chat, qwen-plus, or your custom model id.",
    "providers.wizard.model": "Model name",
    "agents.title": "Lynn worker agents",
    "agents.headless.title": "Headless calls for other agents / CLI Fleet:",
    "agents.node.prereq": "Prerequisite: Node.js 20 LTS or 22 LTS with npm. macOS: brew install node@20; Linux/macOS: nvm install 20; Windows: winget install OpenJS.NodeJS.LTS",
    "agents.install.title": "Install:",
    "agents.launch.title": "Launch:",
    "agents.headless.commands": "Headless calls:",
    "agents.tip": "Tip: built-in profiles run through Lynn worker run; external agents must be installed on PATH.",
    "permissions.saved": "Saved CLI permission profile.",
    "permissions.title": "Lynn CLI Permissions",
    "permissions.approval": "approval",
    "permissions.sandbox": "sandbox",
    "permissions.source": "source",
    "permissions.dataDir": "data dir",
    "permissions.profile": "profile",
    "permissions.profile.missing": "{path} (not found)",
    "permissions.precedence": "Precedence: CLI flags > env > Lynn client permission profile > default.",
    "permissions.interop": "Client interop: Lynn client Settings > Permissions writes the same profile.",
    "permissions.warning": "WARNING: YOLO/full-access mode can edit files and run shell commands without another prompt.",
    "update.available": "Lynn CLI {version}{build} is available. Update now? [y/N]",
    "update.installing": "Updating Lynn CLI... this session continues on the current version.",
    "update.installed": "Lynn CLI updated. Open a new terminal or run Lynn again to use it.",
    "update.failed": "Lynn CLI update failed: {message}. The current version is unchanged; try again later.",
    "update.skipped": "Skipped update; continuing with the current version.",
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
