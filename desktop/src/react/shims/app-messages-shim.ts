/**
 * app-messages-shim.ts — 消息加载
 *
 * 解析工具函数已移至 utils/message-parser.ts。
 * Cron 确认卡片已迁移为 React CronConfirmCard 组件。
 * 只保留 loadMessages（初始加载 + Zustand 写入）。
 */

import { buildItemsFromHistory } from '../utils/history-builder';
import { useStore } from '../stores';
import { parseMoodFromContent, parseXingFromContent, parseUserAttachments, cleanMoodText, moodLabel } from '../utils/message-parser';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface AppMessagesCtx {
  state: Record<string, any>;
  hanaFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  renderTodoDisplay: () => void;
}

let ctx: AppMessagesCtx;

async function loadMessages(): Promise<void> {
  const { state, hanaFetch, renderTodoDisplay } = ctx;

  try {
    const res = await hanaFetch('/api/sessions/messages');
    const data = await res.json();
    if (data.todos && data.todos.length > 0) {
      state.sessionTodos = data.todos;
      renderTodoDisplay();
    }
    const items = buildItemsFromHistory(data);
    const sessionPath = state.currentSessionPath;
    if (sessionPath && items.length > 0) {
      useStore.getState().initSession(sessionPath, items, data.hasMore ?? false);
      state.welcomeVisible = false;
    } else if (sessionPath) {
      useStore.getState().initSession(sessionPath, [], false);
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

export function setupAppMessagesShim(modules: Record<string, unknown>): void {
  modules.appMessages = {
    // 向后兼容：re-export message-parser 函数供旧代码通过 HanaModules 访问
    cleanMoodText,
    moodLabel,
    parseMoodFromContent,
    parseXingFromContent,
    parseUserAttachments,
    loadMessages,
    initAppMessages: (injected: AppMessagesCtx) => { ctx = injected; },
  };
}
