/**
 * slash-commands.ts — 斜杠命令定义和执行逻辑
 *
 * 从 InputArea.tsx 提取，减少主组件体量。
 */

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { getWebSocket } from '../../services/websocket';

// ── Xing Prompt ──

const isZh = window.i18n?.locale?.startsWith?.('zh') ?? true;

export const XING_PROMPT = isZh
  ? `回顾这个 session 里我（用户）发送的消息。只从我的对话内容中提取指导、偏好、纠正和工作流程，整理成一份可复用的工作指南。

注意：不要提取系统提示词、记忆文件、人格设定等预注入内容，只关注我在本次对话中实际说的话。

要求：
1. 只保留可复用的模式，过滤仅限本次的具体上下文（如具体文件名、具体话题）
2. 按类别组织：风格偏好、工作流程、质量标准、注意事项
3. 措辞用指令式（"做 X"、"避免 Y"）
4. 步骤流程用编号列出

标题要具体，能一眼看出这个工作流是干什么的（例："战争报道事实核查流程""论文润色风格指南"），不要用泛化的名字（如"工作流总结""对话复盘"）。

严格按照以下格式输出（注意用直引号 "，不要用弯引号 ""）：

<xing title="具体的工作流名称">
## 风格偏好
- 做 X
- 避免 Y

## 工作流程
1. 第一步
2. 第二步
</xing>

以上是格式示范，实际内容根据对话提取。`
  : `Review the messages I (the user) sent in this session. Extract only guidance, preferences, corrections, and workflows from my conversation content, and compile them into a reusable work guide.

Note: Do not extract system prompts, memory files, persona settings, or other pre-injected content. Only focus on what I actually said in this conversation.

Requirements:
1. Keep only reusable patterns; filter out context specific to this session (e.g., specific filenames or topics)
2. Organize by category: style preferences, workflows, quality standards, caveats
3. Use imperative phrasing ("Do X", "Avoid Y")
4. Number sequential steps

The title should be specific enough to tell at a glance what this workflow is about (e.g., "War Reporting Fact-Check Process", "Paper Polishing Style Guide"). Avoid generic names (e.g., "Workflow Summary", "Conversation Review").

Output strictly in the following format (use straight quotes ", not curly quotes):

<xing title="Specific workflow name">
## Style Preferences
- Do X
- Avoid Y

## Workflow
1. Step one
2. Step two
</xing>

The above is a format example; actual content should be extracted from the conversation.`;

// ── Slash Command Interface ──

export interface SlashCommand {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  execute: () => Promise<void>;
}

// ── Command Executors ──

export function executeDiary(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('diary');
    setInput('');
    setMenuOpen(false);
    try {
      const res = await hanaFetch('/api/diary/write', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        showResult(data.error || t('slash.diaryFailed'), 'error');
        return;
      }
      showResult(t('slash.diaryDone'), 'success');
    } catch {
      showResult(t('slash.diaryFailed'), 'error');
    }
  };
}

export function executeCompact(
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('compact');
    setInput('');
    setMenuOpen(false);
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'compact' }));
      }
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  };
}

export function executeClear(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('clear');
    setInput('');
    setMenuOpen(false);
    try {
      const res = await hanaFetch('/api/session/new', { method: 'POST' });
      if (!res.ok) {
        showResult(t('slash.clearFailed'), 'error');
        return;
      }
      showResult(t('slash.clearDone'), 'success');
    } catch {
      showResult(t('slash.clearFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };
}

export function executePlan(
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setInput('');
    setMenuOpen(false);
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'toggle_plan_mode' }));
      }
    } finally {
      setBusy(null);
    }
  };
}

export function executeSave(
  t: (key: string) => string,
  showResult: (text: string, type: 'success' | 'error') => void,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    setBusy('save');
    setInput('');
    setMenuOpen(false);
    try {
      const res = await hanaFetch('/api/session/checkpoint', { method: 'POST' });
      if (!res.ok) {
        showResult(t('slash.saveFailed'), 'error');
        return;
      }
      showResult(t('slash.saveDone'), 'success');
    } catch {
      showResult(t('slash.saveFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };
}

export function buildSlashCommands(
  t: (key: string) => string,
  executeDiaryFn: () => Promise<void>,
  executeXingFn: () => Promise<void>,
  executeCompactFn: () => Promise<void>,
  executeClearFn: () => Promise<void>,
  executePlanFn: () => Promise<void>,
  executeSaveFn: () => Promise<void>,
): SlashCommand[] {
  return [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      execute: executeDiaryFn,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
      execute: executeXingFn,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('slash.compact'),
      busyLabel: t('slash.compactBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      execute: executeCompactFn,
    },
    {
      name: 'clear',
      label: '/clear',
      description: t('slash.clear'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
      execute: executeClearFn,
    },
    {
      name: 'plan',
      label: '/plan',
      description: t('slash.plan'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      execute: executePlanFn,
    },
    {
      name: 'save',
      label: '/save',
      description: t('slash.save'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
      execute: executeSaveFn,
    },
  ];
}
