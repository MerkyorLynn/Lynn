/**
 * task-modes.ts — 任务模式配置
 *
 * 在聊天输入左下角的"模式芯片"点开，弹出下拉选择器。
 * 每个模式会在发送时注入对应的 persona prompt，让 AI 按特定角色/风格回复。
 * slash 命令（/xhs /gzh 等）直接展开为完整 prompt。
 */

export type TaskModeCategory = 'auto' | 'writing' | 'work' | 'study';

export interface TaskModeSlashCommand {
  cmd: string;              // '/xhs'
  label: string;            // '小红书文案'
  prompt: string;           // 展开后的完整指令
}

export interface TaskMode {
  id: string;
  category: TaskModeCategory;
  emoji: string;
  name: string;
  subtitle: string;
  persona?: string;         // 激活时注入的系统 prompt（作为消息前缀）
  tools?: string[];         // 激活的工具分组（配合 MCP 按需激活）
  slashCommands?: TaskModeSlashCommand[];
}

// ─────────────────────────────────────────────────────────────
// 默认任务模式集
// ─────────────────────────────────────────────────────────────

export const TASK_MODES: TaskMode[] = [
  // ── 自动（默认）──
  {
    id: 'auto',
    category: 'auto',
    emoji: '⚡',
    name: '自动',
    subtitle: '按文件/内容自动选',
  },

  // ── 写作 ──
  {
    id: 'novel',
    category: 'writing',
    emoji: '📖',
    name: '小说',
    subtitle: '章节 / 大纲 / 人物',
    persona: '[任务模式：小说创作] 接下来的回复请围绕小说创作展开。如果用户说"写小说"、"创作"、"开始"，自动激活 novel-workshop 技能。重点关注：大纲结构、人物弧光、场景细节、风格一致性、章节衔接。用户改章节时用 edit 工具产生精确 diff。',
    tools: ['read', 'write', 'edit', 'present_files', 'create_artifact'],
  },
  {
    id: 'long-form',
    category: 'writing',
    emoji: '🖋️',
    name: '长文',
    subtitle: '博客 / 专栏 / 深度文',
    persona: '[任务模式：长文写作] 请按"深度长文"的标准帮用户写作：开头抓眼球、论点层次分明、证据/案例支撑、金句收尾。目标 1500-4000 字。写作时每一段要有明确的功能（引入/论证/对比/转折/总结）。不要写成小红书式的碎片化堆砌。',
    tools: ['read', 'write', 'edit'],
  },
  {
    id: 'social',
    category: 'writing',
    emoji: '🌶️',
    name: '社媒',
    subtitle: '小红书 / 公众号 / 微博 / 抖音',
    persona: '[任务模式：社媒文案] 按社媒平台特点写作：小红书（emoji多/短句/种草钩子）、公众号（有结构有深度）、微博（140-280字抓点）、抖音（口播节奏感）。识别用户说的平台自动调整语气。避免"干巴巴说教"。',
    tools: ['read', 'write', 'edit'],
    slashCommands: [
      { cmd: '/xhs', label: '小红书笔记', prompt: '请帮我写一篇小红书笔记。格式：1) 5 个备选封面标题（带 emoji，有钩子）2) 正文 600-1000 字，多 emoji，分小节 3) 配图建议 3-5 张 4) 标签 10 个 5) 评论区运营策略。主题：' },
      { cmd: '/gzh', label: '公众号文章', prompt: '请帮我写一篇公众号文章。格式：1) 标题 3 个备选 2) 开头用具体场景/数据钩住 3) 3-4 段主体，每段一个核心论点 4) 金句式结尾。1500-2500 字。主题：' },
      { cmd: '/weibo', label: '微博', prompt: '请帮我写一条微博，140-280 字，有话题性、金句感。避免长篇大论。主题：' },
      { cmd: '/douyin', label: '抖音口播', prompt: '请帮我写一条抖音口播脚本。30-60 秒版本，节奏感强，前 3 秒必须抓人。格式：【钩子】→【痛点】→【解决】→【引导关注】。主题：' },
      { cmd: '/zhihu', label: '知乎回答', prompt: '请帮我写一篇知乎风格回答。先亮结论，再展开论证，带个人经验或数据。避免"谢邀"开头。主题：' },
      { cmd: '/hashtags', label: '生成标签', prompt: '请为以下内容生成 10-15 个社媒标签（小红书、微博通用），覆盖品类/人群/场景三个维度，带 # 符号：' },
      { cmd: '/titles', label: '标题优化', prompt: '请为以下文案生成 5 个备选封面标题，要求带钩子，避免标题党。目标平台：小红书/公众号（二选一请用户确认）。内容：' },
    ],
  },

  // ── 工作 ──
  {
    id: 'code',
    category: 'work',
    emoji: '⌘',
    name: '代码',
    subtitle: '工程 / 评审 / 调试',
    persona: '[任务模式：代码] 按工程师视角回答。代码要求：先读现有代码（read/grep/find）再改；改动有测试覆盖；评审时指出具体文件:行号；调试时列出假设→验证步骤。不要凭想象生成代码。',
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
  },
  {
    id: 'business',
    category: 'work',
    emoji: '💼',
    name: '商务',
    subtitle: '邮件 / PRD / 报告',
    persona: '[任务模式：商务] 写邮件：简洁、礼貌、有 CTA；写 PRD：背景→问题→方案→指标→时间线；写报告：结构化分章节，数据要有来源。避免"套话"和"空话"。',
    tools: ['read', 'write', 'edit', 'create_report', 'create_pdf'],
  },
  {
    id: 'translate',
    category: 'work',
    emoji: '🌐',
    name: '翻译',
    subtitle: '中英互译 / 本地化',
    persona: '[任务模式：翻译] 默认中英互译。翻译原则：信达雅三者兼顾，专有名词标注原文，文化梗做本地化替换。技术文档保留术语英文。文学翻译重文采。用户不指定方向时自动按内容判断。',
  },

  // ── 学习 ──
  {
    id: 'research',
    category: 'study',
    emoji: '🔬',
    name: '研究',
    subtitle: '论文 / 综述 / 假设',
    persona: '[任务模式：研究] 按研究者严谨性回答：陈述事实附引用、区分"共识"与"假说"、拒绝断言没证据的结论。帮写综述时结构：研究背景→文献梳理→方法分类→关键发现→未解问题。',
    tools: ['read', 'write', 'web_search'],
  },
  {
    id: 'notes',
    category: 'study',
    emoji: '📝',
    name: '笔记',
    subtitle: '费曼 / 卡片 / Anki',
    persona: '[任务模式：学习笔记] 按学习法组织：费曼法（用简单的话解释复杂概念）、卡片法（一条卡一个原子概念）、Anki（Q→A 卡片格式，一题一答）。帮用户从材料里抽核心而非简单复述。',
    tools: ['read', 'write', 'edit'],
  },
];

// ─────────────────────────────────────────────────────────────
// 分组 helper
// ─────────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<TaskModeCategory, string> = {
  auto: '',
  writing: '写作',
  work: '工作',
  study: '学习',
};

export function getModesByCategory(category: TaskModeCategory): TaskMode[] {
  return TASK_MODES.filter(m => m.category === category);
}

export function getModeById(id: string): TaskMode | undefined {
  return TASK_MODES.find(m => m.id === id);
}

/** 找到所有 slash 命令（跨所有模式）供 slash-menu 搜索 */
export function getAllSlashCommands(): Array<TaskModeSlashCommand & { modeId: string }> {
  const result: Array<TaskModeSlashCommand & { modeId: string }> = [];
  for (const mode of TASK_MODES) {
    if (!mode.slashCommands) continue;
    for (const sc of mode.slashCommands) {
      result.push({ ...sc, modeId: mode.id });
    }
  }
  return result;
}
