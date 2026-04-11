/**
 * websocket.ts — WebSocket 连接管理（从 app-ws-shim.ts 迁移）
 *
 * 模块级 singleton，管理 WS 连接生命周期、重连逻辑。
 * 不依赖 ctx 注入，不依赖 React 组件生命周期。
 */


import { handleServerMessage, applyStreamingStatus } from './ws-message-handler';
import { requestStreamResume, injectHandlers } from './stream-resume';
import { useStore } from '../stores';
import { setStatus } from '../utils/ui-helpers';
// @ts-expect-error -- shared JS module, no type declarations
import { AppError } from '../../../../shared/errors.js';
// @ts-expect-error -- shared JS module, no type declarations
import { errorBus } from '../../../../shared/error-bus.js';

// ── 模块级 WS 实例 ──
let _ws: WebSocket | null = null;

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
    const ws = _ws;
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
    useStore.getState().markStartupStep('websocket', '连接 WebSocket', status, detail ?? null);
  } catch {
    // ignore diagnostics timing issues during bootstrap
  }
}

/** 获取当前 WebSocket 实例 */
export function getWebSocket(): WebSocket | null {
  return _ws;
}

/** 发起 WebSocket 连接 */
export function connectWebSocket(port?: string, token?: string): void {
  // 如果没有传参，从 Zustand store 获取
  const storeState = useStore.getState();
  const serverPort = port || storeState.serverPort;
  const serverToken = token || storeState.serverToken;

  if (!serverPort) return;

  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  if (_ws) {
    try { _ws.onclose = null; _ws.close(); } catch { /* silent */ }
  }

  const url = `ws://127.0.0.1:${serverPort}/ws`;
  const protocols = serverToken ? ['hana-v1', `token.${serverToken}`] : ['hana-v1'];
  _ws = new WebSocket(url, protocols);
  ensureStreamResumeWatchdog();

  _ws.onopen = () => {
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

  _ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  _ws.onclose = () => {
    setStatus('status.disconnected', false);
    _wsRetryCount++;

    if (_wsRetryCount <= WS_MAX_RETRIES) {
      useStore.setState({ wsState: 'reconnecting', wsReconnectAttempt: _wsRetryCount });
      markWebSocketStartup('warning', `连接中断，正在重连（第 ${_wsRetryCount} 次）`);
      _wsRetryTimer = setTimeout(() => connectWebSocket(serverPort, serverToken ?? undefined), _wsRetryDelay);
      _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
    } else {
      useStore.setState({ wsState: 'disconnected' });
      markWebSocketStartup('error', 'WebSocket 多次重连失败');
    }
  };

  _ws.onerror = () => {
    markWebSocketStartup('error', 'WebSocket 连接出错');
    errorBus.report(new AppError('WS_DISCONNECTED'));
  };
}

/** 手动重连（由 StatusBar 重连按钮调用），重置重试计数 */
export function manualReconnect(): void {
  _wsRetryCount = 0;
  connectWebSocket();
}
