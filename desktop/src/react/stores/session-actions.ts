/**
 * session-actions.ts — Session 生命周期操作（纯逻辑 + API）
 *
 * 从 sidebar-shim.ts 迁移。所有函数直接操作 Zustand store，
 * 不依赖 ctx 注入，不持有闭包状态（除 _switchVersion 防竞争）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- store partial patch + API 响应 JSON */

import { useStore } from './index';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { loadDeskFiles } from './desk-actions';
import { saveTabState, restoreTabState } from './artifact-actions';
import { loadModels } from '../utils/ui-helpers';
import { getComposerSessionKey, PENDING_COMPOSER_KEY } from '../utils/composer-state';

// ── 防竞争计数器 ──

let _switchVersion = 0;
let _ensureSessionPromise: Promise<boolean> | null = null;

function tr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const value = window.t?.(key, vars);
  return !value || value === key ? fallback : String(value);
}

function formatActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
}

function showActionError(key: string, fallback: string, err: unknown, dedupeKey?: string): void {
  const detail = formatActionError(err);
  const text = detail ? `${tr(key, fallback)}: ${detail}` : tr(key, fallback);
  showSidebarToast(text, 5000, 'error', dedupeKey);
}

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  try {
    const res = await hanaFetch(`/api/sessions/messages?path=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    const { buildItemsFromHistory } = await import('../utils/history-builder');
    // per-session todos
    useStore.getState().setSessionTodosForPath(targetPath, data.todos || []);
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false);
    }
  } catch (err) {
    console.error('[loadMessages] error:', err);
    showActionError('session.loadFailed', 'Failed to load session', err, 'session-load-failed');
  }
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

export async function loadSessions(): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions');
    const data = await res.json();
    const sessions = data || [];

    const s = useStore.getState();
    useStore.setState({ sessions });

    if (sessions.length > 0 && !s.currentSessionPath && !s.pendingNewSession) {
      // 首次加载：走完整的 switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    }
  } catch (err) {
    console.error('[session] load failed:', err);
    showActionError('session.loadFailed', 'Failed to load sessions', err, 'session-list-load-failed');
  }
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(path: string): Promise<void> {
  const s = useStore.getState();
  if (path === s.currentSessionPath) return;
  if (s.sessionCreationPending) {
    showSidebarToast(
      tr('session.creating', 'Creating the new session, please wait a moment'),
      3000,
      'info',
      'session-creation-pending',
    );
    return;
  }

  // 关闭浮动面板
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const myVersion = ++_switchVersion;

  try {
    const res = await hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (myVersion !== _switchVersion) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      showActionError('session.switchFailed', 'Failed to switch session', data.error, 'session-switch-failed');
      return;
    }

    const state = useStore.getState();

    // 同步 streamingSessions：切入的 session 可能正在 streaming
    let streamingSessions = state.streamingSessions;
    if (data.isStreaming && path) {
      if (!streamingSessions.includes(path)) {
        streamingSessions = [...streamingSessions, path];
      }
    }

    // 计算 sessionAgent
    let sessionAgent = null;
    if (data.agentId && data.agentId !== state.currentAgentId) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      sessionAgent = {
        name: data.agentName || ag?.name || data.agentId,
        yuan: ag?.yuan || 'hanako',
        avatarUrl: ag?.hasAvatar ? hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`) : null,
      };
    }

    // 保存当前 session 的 tab 状态与输入草稿
    const currentPath = s.currentSessionPath;
    const currentComposerKey = getComposerSessionKey(currentPath, s.pendingNewSession);
    useStore.getState().saveComposerDraft(currentComposerKey);
    if (currentPath) saveTabState(currentPath);

    // 批量更新 store
    useStore.setState({
      currentSessionPath: path,
      pendingNewSession: false,
      activeBridgeSessionKey: null,
      activeBridgeMessages: [],
      selectedFolder: null,
      selectedAgentId: null,
      memoryEnabled: data.memoryEnabled !== false,
      isStreaming: !!data.isStreaming,
      streamingSessions,
      sessionAgent,
      browserRunning: !!data.browserRunning,
      browserUrl: data.browserUrl || null,
      browserThumbnail: data.browserRunning ? state.browserThumbnail : null,
      currentModel: data.currentModelId ? { id: data.currentModelId, provider: data.currentModelProvider || "" } : null,
    });

    // 刷新模型列表（当前 session 的模型可能不同）
    loadModels();

    // 恢复目标 session 的 tab 状态与输入草稿
    restoreTabState(path);
    useStore.getState().restoreComposerDraft(getComposerSessionKey(path, false));

    // Sync session-scoped security state after switching sessions
    const nextSecurityMode = data.securityMode || 'authorized';
    useStore.getState().setSecurityMode(nextSecurityMode);
    window.dispatchEvent(new CustomEvent('hana-security-mode', { detail: { mode: nextSecurityMode } }));
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    // renderBrowserCard — no-op (browser card rendering handled by React)

    // updateFolderButton — no-op (React-driven)

    // 如果 store 中没有该 session 的消息数据，加载之
    const hasData = !!useStore.getState().chatSessions?.[path];
    if (!hasData) {
      await loadMessages(path);
    }

    // 加载 desk files（显式传入切换后 session 的 cwd，覆盖 store 中旧的 deskBasePath）
    loadDeskFiles('', data.cwd || undefined);

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    const { getWebSocket } = await import('../services/websocket');
    const wsConn = getWebSocket();
    if (wsConn?.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'context_usage' }));
    }
  } catch (err) {
    console.error('[session] switch failed:', err);
    showActionError('session.switchFailed', 'Failed to switch session', err, 'session-switch-failed');
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

export async function createNewSession(): Promise<void> {
  if (useStore.getState().sessionCreationPending) {
    showSidebarToast(
      tr('session.creating', 'Creating the new session, please wait a moment'),
      3000,
      'info',
      'session-creation-pending',
    );
    return;
  }
  // 关闭浮动面板
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const s = useStore.getState();

  useStore.setState({
    isStreaming: false,
    welcomeVisible: true,
    currentSessionPath: null,
    activeBridgeSessionKey: null,
    activeBridgeMessages: [],
    selectedFolder: s.homeFolder || null,
    selectedAgentId: null,
    sessionAgent: null,
    pendingNewSession: true,
    browserRunning: false,
    browserUrl: null,
    browserThumbnail: null,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });

  // renderBrowserCard — no-op (browser card rendering handled by React)

  // updateFolderButton — no-op (React-driven)

  const currentState = useStore.getState();
  useStore.getState().restoreComposerDraft(PENDING_COMPOSER_KEY);
  loadDeskFiles('', currentState.selectedFolder || currentState.homeFolder || undefined);

  useStore.getState().requestInputFocus();
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.pendingNewSession) return true;
  if (_ensureSessionPromise) return _ensureSessionPromise;

  const body: Record<string, any> = { memoryEnabled: s.memoryEnabled };
  if (s.selectedFolder) {
    body.cwd = s.selectedFolder;
  }
  if (s.selectedAgentId && s.selectedAgentId !== s.currentAgentId) {
    body.agentId = s.selectedAgentId;
  }

  useStore.getState().setSessionCreationPending(true);
  _ensureSessionPromise = (async () => {
    // 不用 hanaFetch：5xx 时需读取 JSON 里的 error 文案（如「没有可用的模型」），hanaFetch 会在 res.ok 前抛错
    const { serverPort, serverToken } = useStore.getState();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (serverToken) headers.Authorization = `Bearer ${serverToken}`;
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/sessions/new`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let data: Record<string, any> = {};
    try {
      data = await res.json();
    } catch { /* 非 JSON */ }
    if (!res.ok) {
      const errMsg = typeof data.error === 'string' ? data.error : data?.error?.message;
      showSidebarToast(errMsg || (window.t?.('error.fetchServerError') ?? 'Server error'), 5000);
      console.error('[session] create failed:', res.status, data);
      return false;
    }
    if (data.error) {
      const errMsg = typeof data.error === 'string' ? data.error : data.error?.message;
      showSidebarToast(errMsg || (window.t?.('error.unknown') ?? 'Error'), 5000);
      console.error('[session] create failed:', data.error);
      return false;
    }

    const justSelected = s.selectedFolder;

    // 基础状态更新
    const patch: Record<string, any> = {
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
      currentModel: data.currentModelId ? { id: data.currentModelId, provider: data.currentModelProvider || "" } : null,
    };

    if (data.agentId) {
      const switched = data.agentId !== s.currentAgentId;
      patch.currentAgentId = data.agentId;
      if (data.agentName) patch.agentName = data.agentName;
      if (switched) {
        const ag = s.agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) patch.agentYuan = ag.yuan;
        patch.agentAvatarUrl = null;
        window.i18n.defaultName = data.agentName || s.agentName;
        // 异步刷新头像
        hanaFetch('/api/health').then((r: Response) => r.json()).then((d: any) => {
          loadAvatarsAction(d.avatars);
        }).catch(() => {
          loadAvatarsAction();
        });
      }
    }

    if (data.path) {
      patch.currentSessionPath = data.path;
      // 初始化空 session，ChatArea 自动渲染
      useStore.getState().initSession(data.path, [], false);
      const sessions = useStore.getState().sessions;
      if (!sessions.some((sess) => sess.path === data.path)) {
        useStore.setState({
          sessions: [
            {
              path: data.path,
              title: null,
              firstMessage: '',
              modified: new Date().toISOString(),
              messageCount: 0,
              cwd: data.cwd || justSelected || null,
              agentId: data.agentId || s.currentAgentId || null,
              agentName: data.agentName || s.agentName || null,
              modelId: data.currentModelId || null,
              modelProvider: data.currentModelProvider || null,
            },
            ...sessions,
          ],
        });
      }
    }

    useStore.setState(patch);

    // New session inherits the current security mode selection from the server
    const nextSecurityMode = data.securityMode || 'authorized';
    useStore.getState().setSecurityMode(nextSecurityMode);
    window.dispatchEvent(new CustomEvent('hana-security-mode', { detail: { mode: nextSecurityMode } }));
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    await loadSessions();

    // updateFolderButton — no-op (React-driven)

    // 更新 cwdHistory
    if (justSelected) {
      const currentState = useStore.getState();
      let cwdHistory = currentState.cwdHistory.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

    loadDeskFiles('', data.cwd || undefined);

    return true;
  })().catch((err) => {
    console.error('[session] create failed:', err);
    showSidebarToast(window.t?.('error.fetchServerError') ?? 'Server error', 5000);
    return false;
  }).finally(() => {
    useStore.getState().setSessionCreationPending(false);
    _ensureSessionPromise = null;
  });

  return _ensureSessionPromise;
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast(window.t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    if (path === s.currentSessionPath) {
      useStore.setState({ currentSessionPath: null });
      clearChatAction();
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast(window.t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
// 重命名 Session
// ══════════════════════════════════════════════════════

export async function renameSession(path: string, title: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] rename failed:', data.error);
      showActionError('session.renameFailed', 'Failed to rename session', data.error, 'session-rename-failed');
      return false;
    }
    // 乐观更新 store 中的 title
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, title } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] rename failed:', err);
    showActionError('session.renameFailed', 'Failed to rename session', err, 'session-rename-failed');
    return false;
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export function showSidebarToast(
  text: string,
  duration = 3000,
  type: 'success' | 'error' | 'info' | 'warning' = 'info',
  dedupeKey?: string,
): void {
  useStore.getState().addToast(text, type, duration, dedupeKey ? { dedupeKey } : undefined);
}
