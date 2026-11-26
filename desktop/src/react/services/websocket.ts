/**
 * websocket.ts — WebSocket 连接管理（从 app-ws-shim.ts 迁移）
 *
 * 模块级 singleton，管理 WS 连接生命周期、重连逻辑。
 * 不依赖 ctx 注入，不依赖 React 组件生命周期。
 */


import { handleServerMessage, applyStreamingStatus } from './ws-message-handler';
import { requestStreamResume, injectHandlers } from './stream-resume';
import { useStore } from '../stores';
import { isChineseLocale } from '../utils/locale';

/** Inline zh/en picker for startup diagnostics copy. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);
import { setStatus } from '../utils/ui-helpers';
import { AppError } from '../../../../shared/errors.js';
import { errorBus } from '../../../../shared/error-bus.js';
import {
  clearWebSocket,
  getWebSocket,
  setWebSocket,
} from './websocket-transport';

export { getWebSocket } from './websocket-transport';

// ── WS 重连状态 ──
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;
const WS_MAX_RETRIES = 20;
let _wsRetryCount = 0;
let _streamResumeWatchdog: ReturnType<typeof setInterval> | null = null;
const STREAM_RESUME_WATCHDOG_MS = 20000;

// 注入循环依赖的 handlers
injectHandlers(handleServerMessage, applyStreamingStatus);

function ensureStreamResumeWatchdog(): void {
  if (_streamResumeWatchdog) return;
  _streamResumeWatchdog = setInterval(() => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const state = useStore.getState();
    if (!state.isStreaming || !state.currentSessionPath) return;
    requestStreamResume(state.currentSessionPath);
  }, STREAM_RESUME_WATCHDOG_MS);
}

function markWebSocketStartup(
  status: 'running' | 'success' | 'warning' | 'error',
  detail?: string | null,
): void {
  try {
    useStore.getState().markStartupStep('websocket', D('连接 WebSocket', 'Connecting WebSocket'), status, detail ?? null);
  } catch {
    // ignore diagnostics timing issues during bootstrap
  }
}

/** 发起 WebSocket 连接 */
export function connectWebSocket(port?: string, token?: string): void {
  // 如果没有传参，从 Zustand store 获取
  const storeState = useStore.getState();
  const serverPort = port || storeState.serverPort;
  const serverToken = token || storeState.serverToken;

  if (!serverPort) return;

  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  const existingSocket = getWebSocket();
  if (existingSocket) {
    try { existingSocket.onclose = null; existingSocket.close(); } catch { /* silent */ }
  }

  const url = `ws://127.0.0.1:${serverPort}/ws`;
  const protocols = serverToken ? ['hana-v1', `token.${serverToken}`] : ['hana-v1'];
  const ws = new WebSocket(url, protocols);
  setWebSocket(ws);
  ensureStreamResumeWatchdog();

  ws.onopen = () => {
    _wsRetryDelay = 1000;
    _wsRetryCount = 0;
    setStatus('status.connected', true);
    useStore.setState({ wsState: 'connected', wsReconnectAttempt: 0, compactingSessions: [] });
    markWebSocketStartup('success', `ws://127.0.0.1:${serverPort}/ws`);

    const s = useStore.getState();
    if (s.currentSessionPath && s.isStreaming) {
      const myVersion = ++_wsResumeVersion;
      const targetPath = s.currentSessionPath;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        if (useStore.getState().currentSessionPath !== targetPath) return;
        requestStreamResume(targetPath);
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  ws.onclose = () => {
    clearWebSocket(ws);
    setStatus('status.disconnected', false);
    _wsRetryCount++;

    if (_wsRetryCount <= WS_MAX_RETRIES) {
      useStore.setState({ wsState: 'reconnecting', wsReconnectAttempt: _wsRetryCount });
      markWebSocketStartup(
        'warning',
        D(
          `连接中断，正在重连（第 ${_wsRetryCount} 次）`,
          `Connection dropped; reconnecting (attempt ${_wsRetryCount})`,
        ),
      );
      _wsRetryTimer = setTimeout(() => connectWebSocket(serverPort, serverToken ?? undefined), _wsRetryDelay);
      _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
    } else {
      useStore.setState({ wsState: 'disconnected' });
      markWebSocketStartup('error', D('WebSocket 多次重连失败', 'WebSocket failed to reconnect repeatedly'));
    }
  };

  ws.onerror = () => {
    markWebSocketStartup('error', D('WebSocket 连接出错', 'WebSocket connection error'));
    errorBus.report(new AppError('WS_DISCONNECTED'));
  };
}

/** 手动重连（由 StatusBar 重连按钮调用），重置重试计数 */
export function manualReconnect(): void {
  _wsRetryCount = 0;
  connectWebSocket();
}
