/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息分发，msg 结构由服务端动态决定 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { loadChannels as loadChannelsAction, openChannel as openChannelAction } from '../stores/channel-actions';
import { showError } from '../utils/ui-helpers';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'xing_start', 'xing_text', 'xing_end',
  'tool_start', 'tool_end', 'turn_end',
  'file_diff',
  'file_output', 'skill_activated', 'artifact',
  'browser_screenshot', 'cron_confirmation', 'settings_confirmation',
  'tool_authorization',
  'compaction_start', 'compaction_end',
]);

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  useStore.setState({
    sessions: [{
      path: sessionPath,
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentId: state.currentAgentId || null,
      agentName: state.agentName || null,
      cwd: null,
      _optimistic: true,
    }, ...state.sessions],
  });
}

function hasOptimisticCurrentSession(): boolean {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

export function applyStreamingStatus(isStreaming: boolean): void {
  useStore.setState({ isStreaming: !!isStreaming });
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    // React 模式：消息完成由 StreamBuffer turn_end 处理
    if (hasOptimisticCurrentSession()) {
      loadSessionsAction().catch(err => console.warn('[ws] loadSessions failed:', err));
    }
  }
}

// ── 消息分发（大 switch） ──

export function handleServerMessage(msg: any): void {
  const state = useStore.getState();

  const rebuildingFor = isStreamResumeRebuilding();

  if (rebuildingFor && msg.type === 'status' && state.currentSessionPath === rebuildingFor) {
    return;
  }

  if (
    rebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === rebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    updateSessionStreamMeta(msg);
  }

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      loadSessionsAction();
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'context_usage' }));
      }
    }
    // tool_end 后更新 todo
    if (msg.type === 'tool_end' && msg.name === 'todo' && msg.details?.todos) {
      const sp = useStore.getState().currentSessionPath;
      if (sp) useStore.getState().setSessionTodosForPath(sp, msg.details.todos);
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().removeCompactingSession(sp);
      // 只有当前 session 的 compaction 才更新 context token 显示
      if (sp === useStore.getState().currentSessionPath) {
        if (msg.tokens != null && msg.contextWindow != null) {
          useStore.setState({
            contextTokens: msg.tokens,
            contextWindow: msg.contextWindow,
            contextPercent: msg.percent,
          });
        } else {
          // SDK returns null right after compaction (no post-compaction response yet)
          // Reset to null so the ring shows empty/estimating instead of stale pre-compaction values
          useStore.setState({ contextTokens: null, contextPercent: null });
        }
      }
    }
    if (msg.type === 'compaction_start') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().addCompactingSession(sp);
    }
    // artifact 需要通知 artifacts shim 更新预览
    if (msg.type === 'artifact' && state.currentTab === 'chat') {
      handleArtifact(msg);
    }
    return;
  }

  // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        useStore.setState({
          sessions: state.sessions.map((s: any) =>
            s.path === msg.path ? { ...s, title: msg.title } : s,
          ),
        });
      }
      break;

    case 'desk_changed':
      loadDeskFiles();
      break;

    case 'browser_status':
      useStore.setState({
        browserRunning: !!msg.running,
        browserUrl: msg.url || null,
        browserThumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
      });
      // renderBrowserCard — no-op (browser card rendering handled by React)
      if (window.platform?.updateBrowserViewer) {
        window.platform.updateBrowserViewer({
          running: !!msg.running,
          url: msg.url || null,
          thumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
        });
      }
      break;

    case 'browser_bg_status': {
      useStore.setState({ browserRunning: !!msg.running });
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 499)] });
      }
      break;

    case 'notification':
      if (window.hana?.showNotification) {
        window.hana.showNotification(msg.title, msg.body);
      }
      break;

    case 'bridge_status':
      useStore.getState().triggerBridgeReload();
      break;

    case 'bridge_message':
      if (msg.message) {
        useStore.getState().addBridgeMessage(msg.message);
      }
      break;

    case 'plan_mode':
      window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: !!msg.enabled } }));
      break;

    case 'security_mode':
      useStore.getState().setSecurityMode(msg.mode || 'authorized');
      window.dispatchEvent(new CustomEvent('hana-security-mode', { detail: { mode: msg.mode } }));
      break;

    case 'channel_new_message': {
      const store = useStore.getState();
      const isViewing = store.currentTab === 'channels' && store.currentChannel === msg.channelName && document.visibilityState === 'visible';
      if (msg.channelName && isViewing) {
        openChannelAction(msg.channelName);
      } else if (msg.channelName) {
        loadChannelsAction();
      }
      break;
    }

    case 'channel_archived': {
      const store = useStore.getState();
      const isViewing = store.currentTab === 'channels' && store.currentChannel === msg.channelName;
      loadChannelsAction();
      if (msg.channelName && isViewing) {
        openChannelAction(msg.channelName);
      }
      break;
    }

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      const store2 = useStore.getState();
      const isViewingDM = store2.currentTab === 'channels' && store2.currentChannel === dmId && document.visibilityState === 'visible';
      if (isViewingDM) {
        openChannelAction(dmId, true);
      } else {
        loadChannelsAction();
      }
      break;
    }

    case 'context_usage':
      if (msg.tokens != null && msg.contextWindow != null) {
        useStore.setState({
          contextTokens: msg.tokens,
          contextWindow: msg.contextWindow,
          contextPercent: msg.percent,
        });
      }
      break;

    case 'error': {
      useStore.getState().setInlineError(msg.message);
      break;
    }

    case 'confirmation_resolved': {
      // 更新所有 session 中匹配 confirmId 的确认卡片状态
      const sessions = state.chatSessions || {};
      for (const sp of Object.keys(sessions)) {
        useStore.getState().updateLastMessage(sp, (m: any) => {
          if (!m.blocks) return m;
          const updated = m.blocks.map((b: any) => {
            if ((b.type === 'settings_confirm' || b.type === 'cron_confirm' || b.type === 'tool_authorization') && b.confirmId === msg.confirmId) {
              const status = b.type === 'cron_confirm'
                ? (msg.action === 'confirmed' ? 'approved' : 'rejected')
                : (msg.action === 'confirmed' ? 'confirmed' : 'rejected');
              return { ...b, status };
            }
            return b;
          });
          return { ...m, blocks: updated };
        });
      }
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        window.applyTheme?.(msg.value);
        // 通知其他窗口（设置窗口等）同步主题
        window.platform?.settingsChanged?.('theme');
      }
      break;
    }

    case 'status': {
      // 元数据层：维护所有 session 的 streaming 状态
      const sp = msg.sessionPath;
      if (sp) {
        const list: string[] = state.streamingSessions || [];
        if (msg.isStreaming) {
          if (!list.includes(sp)) useStore.setState({ streamingSessions: [...list, sp] });
          // 新一轮 streaming 开始时清除上次的 inline error
          if (sp === state.currentSessionPath) useStore.setState({ inlineError: null });
        } else {
          useStore.setState({ streamingSessions: list.filter((p: string) => p !== sp) });
        }
      }
      // 渲染层：只有焦点 session 才影响 UI
      if (!sp || sp === state.currentSessionPath) {
        applyStreamingStatus(msg.isStreaming);
      }
      break;
    }

    case 'review_start': {
      // 在当前 session 的最后一条助手消息末尾插入 loading review block
      const sessionPath = state.currentSessionPath;
      if (!sessionPath) break;
      const chatSession = state.chatSessions[sessionPath];
      if (!chatSession?.items) break;

      const updatedItems = [...chatSession.items];
      for (let i = updatedItems.length - 1; i >= 0; i--) {
        const item = updatedItems[i];
        if (item.type !== 'message' || item.data.role !== 'assistant') continue;
        const newBlocks = [...(item.data.blocks || []), {
          type: 'review' as const,
          reviewId: msg.reviewId,
          reviewerName: msg.reviewerName,
          content: '',
          status: 'loading' as const,
        }];
        updatedItems[i] = { ...item, data: { ...item.data, blocks: newBlocks } };
        break;
      }

      useStore.setState({
        chatSessions: {
          ...state.chatSessions,
          [sessionPath]: { ...chatSession, items: updatedItems },
        },
      });
      break;
    }

    case 'review_result': {
      // 找到 loading 状态的 review block，更新为 done
      const sessionPath2 = state.currentSessionPath;
      if (!sessionPath2) break;
      const chatSession2 = state.chatSessions[sessionPath2];
      if (!chatSession2?.items) break;

      const updatedItems2 = chatSession2.items.map((item: any) => {
        if (item.type !== 'message' || item.data.role !== 'assistant') return item;
        const blocks = item.data.blocks;
        if (!blocks?.some((b: any) => b.type === 'review' && b.reviewId === msg.reviewId)) return item;

        return {
          ...item,
          data: {
            ...item.data,
            blocks: blocks.map((b: any) =>
              b.type === 'review' && b.reviewId === msg.reviewId
                ? { ...b, content: msg.content || '', error: msg.error, status: 'done' }
                : b,
            ),
          },
        };
      });

      useStore.setState({
        chatSessions: {
          ...state.chatSessions,
          [sessionPath2]: { ...chatSession2, items: updatedItems2 },
        },
      });
      break;
    }
  }
}
