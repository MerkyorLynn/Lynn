import type { SchedulePreset } from './cron-utils';

export type AutomationCategory = 'reports' | 'organize' | 'followup';

export interface TemplateDefinition {
  id: string;
  category: AutomationCategory;
  icon: string;
  zhTitle: string;
  enTitle: string;
  zhDesc: string;
  enDesc: string;
  promptZh: string;
  promptEn: string;
  defaultLabelZh: string;
  defaultLabelEn: string;
  defaultPreset: SchedulePreset;
  defaultHour: string;
  defaultMinute: string;
  defaultWeeklyDay?: number;
  defaultDays?: number[];
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'daily-standup',
    category: 'reports',
    icon: '📰',
    zhTitle: '昨日工作简报',
    enTitle: "Yesterday's work update",
    zhDesc: '总结昨天推进了什么、卡在哪里、今天最该继续跟进什么。',
    enDesc: "Summarize what moved yesterday, what is blocked, and what deserves attention today.",
    promptZh: '只基于当前工作区、笺和最近活动，整理一份昨日工作简报。输出三段：1. 昨天完成了什么 2. 现在卡在哪里 3. 今天最该继续推进什么。尽量锚定到真实文件、活动或任务，不要猜测没有证据的计划。',
    promptEn: 'Using only the current workspace, note, and recent activity, prepare a standup-style update with three parts: what moved yesterday, what is blocked now, and what deserves attention today. Anchor statements to real files, activity, or tasks and avoid speculation.',
    defaultLabelZh: '昨日工作简报',
    defaultLabelEn: "Yesterday's work update",
    defaultPreset: 'daily',
    defaultHour: '09',
    defaultMinute: '00',
  },
  {
    id: 'weekly-highlights',
    category: 'reports',
    icon: '🧾',
    zhTitle: '每周工作周报',
    enTitle: 'Weekly work summary',
    zhDesc: '汇总这周完成了什么、遗留了什么，以及下周最值得推进的重点。',
    enDesc: 'Summarize what got done this week, what remains open, and what to focus on next week.',
    promptZh: '结合当前工作区、笺和最近活动，整理一份每周工作周报。输出三段：1. 本周完成 2. 仍未解决的问题 3. 下周最值得推进的重点。优先引用真实文件、任务或活动记录。',
    promptEn: 'Use the workspace, note, and recent activity to prepare a weekly summary with three parts: work completed this week, unresolved items, and the most valuable next-week priorities. Prefer grounding statements in real files, tasks, or activity.',
    defaultLabelZh: '每周工作周报',
    defaultLabelEn: 'Weekly work summary',
    defaultPreset: 'weekly',
    defaultHour: '18',
    defaultMinute: '00',
    defaultWeeklyDay: 5,
  },
  {
    id: 'daily-hourly-summary',
    category: 'reports',
    icon: '⏱️',
    zhTitle: '定时工作小结',
    enTitle: 'Timed work summary',
    zhDesc: '按固定时间整理当前项目、笺和活动流，生成一段简短进展小结。',
    enDesc: 'Generate a short status update from the project, note, and activity feed on a fixed cadence.',
    promptZh: '按当前工作区、笺和最近活动，生成一段简洁的进展小结。控制在三到五句，说明最新变化、当前焦点，以及一个值得我关注的提醒。',
    promptEn: 'Use the current workspace, note, and recent activity to create a short progress digest in three to five sentences covering the latest changes, the current focus, and one thing worth attention.',
    defaultLabelZh: '定时工作小结',
    defaultLabelEn: 'Timed work summary',
    defaultPreset: 'daily',
    defaultHour: '10',
    defaultMinute: '00',
  },
  {
    id: 'file-summary-digest',
    category: 'organize',
    icon: '🗂️',
    zhTitle: '文件自动归纳',
    enTitle: 'File digest',
    zhDesc: '整理工作区里新增或变化的文件，提炼重点并给出归档建议。',
    enDesc: 'Summarize new or changed files and suggest how to organize them.',
    promptZh: '查看当前工作区里最近新增或变化的文件，整理出三部分：1. 文件变化重点 2. 推荐的归档或归类方式 3. 需要我确认的事项。优先提文件名和目录，不要空泛描述。',
    promptEn: 'Review recent new or changed files in the workspace and return three parts: key file changes, suggested organization, and anything that needs confirmation. Prefer explicit filenames and folders over generic wording.',
    defaultLabelZh: '文件自动归纳',
    defaultLabelEn: 'File digest',
    defaultPreset: 'weekdays',
    defaultHour: '17',
    defaultMinute: '00',
  },
  {
    id: 'document-summary',
    category: 'organize',
    icon: '📝',
    zhTitle: '文档摘要整理',
    enTitle: 'Document digest',
    zhDesc: '定期把文档、笔记和产出整理成可复用的摘要与下一步建议。',
    enDesc: 'Turn notes and documents into reusable summaries and next steps.',
    promptZh: '整理当前工作区中的文档、笔记和产出，生成一份简洁摘要，并补一段下一步建议。输出时优先说明哪些文档值得继续写、哪些信息重复、哪些地方还缺结论。',
    promptEn: 'Summarize the current workspace documents and notes into a concise digest, then add recommended next steps. Call out which documents deserve more work, where information is duplicated, and which areas still lack conclusions.',
    defaultLabelZh: '文档摘要整理',
    defaultLabelEn: 'Document digest',
    defaultPreset: 'weekly',
    defaultHour: '11',
    defaultMinute: '00',
    defaultWeeklyDay: 1,
  },
  {
    id: 'workday-reminder',
    category: 'followup',
    icon: '🔔',
    zhTitle: '工作日巡检提醒',
    enTitle: 'Workday check-in',
    zhDesc: '在工作日固定时间查看笺、活动和文件变化，提醒我今天最该跟进什么。',
    enDesc: 'Check the note, recent activity, and file changes on workdays and remind me what to follow up on.',
    promptZh: '在工作日固定时间查看笺、最近活动和文件变化，提醒我今天最应该先跟进的事项。输出三条以内，按优先级从高到低排列，并说明为什么值得先看。',
    promptEn: 'On workdays, check the note, recent activity, and file changes, then list up to three follow-up items in priority order and explain briefly why each deserves attention first.',
    defaultLabelZh: '工作日巡检提醒',
    defaultLabelEn: 'Workday check-in',
    defaultPreset: 'weekdays',
    defaultHour: '09',
    defaultMinute: '30',
  },
  {
    id: 'weekly-next-steps',
    category: 'followup',
    icon: '📌',
    zhTitle: '下周重点提醒',
    enTitle: 'Next-step roundup',
    zhDesc: '汇总这周未完成事项、风险和下周最值得推进的重点。',
    enDesc: 'Summarize unfinished work, risks, and priorities for the coming week.',
    promptZh: '结合笺、活动和最近产出，整理本周未完成事项、风险和下周最值得推进的重点。输出三段：未完成、风险、下周重点，并尽量指出对应文件或任务。',
    promptEn: 'Use the note, activity, and recent outputs to summarize unfinished work, risks, and next-week priorities. Return three sections and point to relevant files or tasks whenever possible.',
    defaultLabelZh: '下周重点提醒',
    defaultLabelEn: 'Next-step roundup',
    defaultPreset: 'weekly',
    defaultHour: '19',
    defaultMinute: '00',
    defaultWeeklyDay: 5,
  },
];

export const CATEGORY_DEFS: Array<{ key: AutomationCategory; zhLabel: string; enLabel: string }> = [
  { key: 'reports', zhLabel: '日报 / 周报', enLabel: 'Reports' },
  { key: 'organize', zhLabel: '文件整理', enLabel: 'Files' },
  { key: 'followup', zhLabel: '提醒跟进', enLabel: 'Reminders' },
];
