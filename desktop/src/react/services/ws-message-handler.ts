/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息分发，msg 结构由服务端动态决定 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { loadSessions as loadSessionsAction, switchSession as switchSessionAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { loadChannels as loadChannelsAction, openChannel as openChannelAction } from '../stores/channel-actions';
import { showError } from '../utils/ui-helpers';
import { renderMarkdown } from '../utils/markdown';
import { requestRuntimeSnapshotRefresh } from '../utils/runtime-snapshot';
import { resolveUiI18nText } from '../utils/ui-i18n';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'xing_start', 'xing_text', 'xing_end',
  'tool_start', 'tool_end', 'turn_end', 'turn_retry',
  'file_diff',
  'file_output', 'skill_activated', 'artifact',
  'browser_screenshot', 'cron_confirmation', 'settings_confirmation',
  'tool_authorization',
  'compaction_start', 'compaction_end',
]);

const INLINE_PROGRESS_EVENTS = new Set([
  'text_delta',
  'tool_start',
  'tool_end',
  'file_output',
  'artifact',
  'browser_screenshot',
  'cron_confirmation',
  'settings_confirmation',
  'tool_authorization',
  'turn_end',
]);

function resolveUiText(raw: unknown, vars?: Record<string, string | number>): string {
  return resolveUiI18nText(raw, vars);
}

function targetsCurrentSession(msg: any, currentSessionPath: string | null): boolean {
  return !msg?.sessionPath || !currentSessionPath || msg.sessionPath === currentSessionPath;
}

function stripReviewThinkTags(raw: unknown): string {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>\n*/gi, '')
    .trim();
}

function patchReviewBlock(sessionPath: string, reviewId: string, patch: Record<string, unknown>): void {
  const nextPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(nextPatch).length === 0) return;

  const state = useStore.getState();
  const chatSession = state.chatSessions[sessionPath];
  if (!chatSession?.items) return;

  const updatedItems = chatSession.items.map((item: any) => {
    if (item.type !== 'message' || item.data.role !== 'assistant') return item;
    const blocks = item.data.blocks;
    if (!blocks?.some((b: any) => b.type === 'review' && b.reviewId === reviewId)) return item;

    return {
      ...item,
      data: {
        ...item.data,
        blocks: blocks.map((b: any) =>
          b.type === 'review' && b.reviewId === reviewId
            ? { ...b, ...nextPatch }
            : b,
        ),
      },
    };
  });

  useStore.setState({
    chatSessions: {
      ...state.chatSessions,
      [sessionPath]: { ...chatSession, items: updatedItems },
    },
  });
}

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
    if (INLINE_PROGRESS_EVENTS.has(msg.type) && targetsCurrentSession(msg, state.currentSessionPath)) {
      if (state.inlineNotice) useStore.getState().setInlineNotice(null);
      if (state.inlineError) useStore.getState().setInlineError(null);
    }
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

  // ── status / error 消息：更新 streaming 状态 / 显示错误 ──
  if (msg.type === 'status') {
    applyStreamingStatus(!!msg.isStreaming);
    if (targetsCurrentSession(msg, state.currentSessionPath)) {
      if (!msg.isStreaming) {
        useStore.getState().setInlineNotice(null);
        return;
      }
      const notice = resolveUiText(msg.noticeKey || msg.notice || msg.message, msg.noticeVars || msg.vars);
      if (notice) {
        useStore.getState().setInlineNotice(notice);
      }
    }
    return;
  }
  if (msg.type === 'error') {
    if (!targetsCurrentSession(msg, state.currentSessionPath)) return;
    const errMsg = resolveUiText(msg.message || msg.error || '', msg.messageVars || msg.errorVars || msg.vars);
    if (errMsg) {
      useStore.getState().setInlineNotice(null);
      useStore.getState().setInlineError(errMsg);
      showError(errMsg);
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

    case 'task_update': {
      requestRuntimeSnapshotRefresh();
      window.dispatchEvent(new CustomEvent('hana-task-updated'));
      const task = msg.task;
      if (!task || task.source !== 'review_follow_up') break;
      const taskReviewId = task.metadata?.reviewId;
      const taskSessionPath = task.sessionPath || state.currentSessionPath;
      const taskId = task.taskId || task.id;
      if (!taskReviewId || !taskSessionPath || !taskId) break;
      patchReviewBlock(taskSessionPath, taskReviewId, {
        followUpTask: {
          taskId,
          title: task.title || null,
          status: task.status,
          resultSummary: task.resultSummary || null,
          error: task.error || null,
          updatedAt: task.updatedAt || null,
        },
      });
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 499)] });
        window.dispatchEvent(new CustomEvent('hana-activity-updated', { detail: msg.activity }));
      }
      break;

    case 'session_relay': {
      const oldSessionPath = msg.oldSessionPath || null;
      const newSessionPath = msg.newSessionPath || null;
      const summary = String(msg.summary || '').trim();
      const isCurrent = !!oldSessionPath && oldSessionPath === state.currentSessionPath;

      loadSessionsAction().catch(err => console.warn('[ws] loadSessions after relay failed:', err));

      if (isCurrent && newSessionPath) {
        void (async () => {
          await switchSessionAction(newSessionPath);
          const nextState = useStore.getState();
          const relayText = summary
            ? `**对话已自动接力。**\n\n${summary}`
            : '**对话已自动接力。**';
          const relayItem = {
            type: 'message' as const,
            data: {
              id: `relay-${Date.now()}`,
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, html: renderMarkdown(relayText) }],
            },
          };
          const existing = nextState.chatSessions[newSessionPath];
          if (!existing || existing.items.length === 0) {
            nextState.initSession(newSessionPath, [relayItem], false);
          } else {
            nextState.appendItem(newSessionPath, relayItem);
          }
          nextState.addToast?.('上下文已自动接力到新会话', 'info', 4000, {
            dedupeKey: `relay-${newSessionPath}`,
          });
        })().catch((err) => {
          console.warn('[ws] session relay switch failed:', err);
        });
      }
      break;
    }

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
        // Auto-refresh if viewing this bridge session
        const activeBridgeKey = useStore.getState().activeBridgeSessionKey;
        if (activeBridgeKey && msg.message.sessionKey === activeBridgeKey) {
          import('../hooks/use-hana-fetch').then(({ hanaFetch }) => {
            hanaFetch(`/api/bridge/sessions/${encodeURIComponent(activeBridgeKey)}/messages`)
              .then(r => r.json())
              .then(data => useStore.getState().setActiveBridgeMessages(data.messages || []))
              .catch(() => {});
          });
        }
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
      if (!store.channelsEnabled) break;
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
      if (!store.channelsEnabled) break;
      const isViewing = store.currentTab === 'channels' && store.currentChannel === msg.channelName;
      loadChannelsAction();
      if (msg.channelName && isViewing) {
        useStore.setState({ currentChannel: null });
      }
      break;
    }

    case 'dm_new_message':
      if (!useStore.getState().channelsEnabled) break;
      if (document.visibilityState !== 'visible') {
        showError('info.dmNewMessage');
      }
      break;

    case 'confirmation_resolved': {
      const targetPath = msg.sessionPath || state.currentSessionPath;
      if (!targetPath) break;
      const chatSession = state.chatSessions[targetPath];
      if (!chatSession?.items) break;

      const nextStatus = msg.action === 'rejected' ? 'rejected' : 'confirmed';
      const updatedItems = chatSession.items.map((item: any) => {
        if (item.type !== 'message' || item.data.role !== 'assistant') return item;
        const blocks = item.data.blocks || [];
        if (!blocks.some((b: any) => (b.type === 'settings_confirm' || b.type === 'cron_confirm' || b.type === 'tool_authorization') && b.confirmId === msg.confirmId)) return item;
        return {
          ...item,
          data: {
            ...item.data,
            blocks: blocks.map((b: any) => {
              if ((b.type === 'settings_confirm' || b.type === 'cron_confirm' || b.type === 'tool_authorization') && b.confirmId === msg.confirmId) {
                return { ...b, status: nextStatus };
              }
              return b;
            }),
          },
        };
      });

      useStore.setState({
        chatSessions: {
          ...state.chatSessions,
          [targetPath]: { ...chatSession, items: updatedItems },
        },
      });
      break;
    }

    case 'apply_frontend_setting': {
      window.dispatchEvent(new CustomEvent('hana-apply-frontend-setting', { detail: { key: msg.key, value: msg.value } }));
      break;
    }

    case 'review_start': {
      // 在目标 session 的最后一条助手消息末尾插入 loading review block
      const sessionPath = msg.sessionPath || state.currentSessionPath;
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
          reviewerAgent: msg.reviewerAgent,
          reviewerAgentName: msg.reviewerAgentName,
          reviewerYuan: msg.reviewerYuan,
          reviewerHasAvatar: !!msg.reviewerHasAvatar,
          reviewerModelLabel: msg.reviewerModelLabel || null,
          reviewerModelId: msg.reviewerModelId || null,
          reviewerModelProvider: msg.reviewerModelProvider || null,
          content: '',
          status: 'loading' as const,
          stage: 'packing_context' as const,
          findingsCount: 0,
          workflowGate: 'clear' as const,
          structured: null,
          contextPack: null,
          followUpPrompt: null,
          followUpTask: null,
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

    case 'review_progress': {
      const sessionPath = msg.sessionPath || state.currentSessionPath;
      if (!sessionPath || !msg.reviewId) break;
      patchReviewBlock(sessionPath, msg.reviewId, {
        stage: msg.stage || 'reviewing',
        findingsCount: typeof msg.findingsCount === 'number' ? msg.findingsCount : undefined,
        verdict: msg.verdict,
        workflowGate: msg.workflowGate,
        reviewerName: msg.reviewerName,
        reviewerAgent: msg.reviewerAgent,
        reviewerAgentName: msg.reviewerAgentName,
        reviewerYuan: msg.reviewerYuan,
        reviewerHasAvatar: msg.reviewerHasAvatar,
        reviewerModelLabel: msg.reviewerModelLabel || null,
        reviewerModelId: msg.reviewerModelId || null,
        reviewerModelProvider: msg.reviewerModelProvider || null,
      });
      break;
    }

    case 'review_result': {
      // 找到 loading 状态的 review block，更新为 done
      const sessionPath2 = msg.sessionPath || state.currentSessionPath;
      if (!sessionPath2 || !msg.reviewId) break;
      patchReviewBlock(sessionPath2, msg.reviewId, {
        reviewerName: msg.reviewerName,
        reviewerAgent: msg.reviewerAgent,
        reviewerAgentName: msg.reviewerAgentName,
        reviewerYuan: msg.reviewerYuan,
        reviewerHasAvatar: msg.reviewerHasAvatar,
        reviewerModelLabel: msg.reviewerModelLabel || null,
        reviewerModelId: msg.reviewerModelId || null,
        reviewerModelProvider: msg.reviewerModelProvider || null,
        content: stripReviewThinkTags(msg.content),
        error: msg.error,
        errorCode: msg.errorCode || null,
        status: 'done',
        stage: 'done',
        findingsCount: msg.structured?.findings?.length ?? 0,
        verdict: msg.structured?.verdict,
        workflowGate: msg.structured?.workflowGate ?? msg.workflowGate,
        structured: msg.structured || null,
        contextPack: msg.contextPack || null,
        followUpPrompt: msg.followUpPrompt || null,
        fallbackNote: msg.fallbackNote || null,
      });
      break;
    }
  }
}
