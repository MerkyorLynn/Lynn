/**
 * app-init.ts — 应用初始化逻辑（纯函数，非 React 组件）
 *
 * 从 App.tsx 提取。包含：
 * - __hanaLog 日志上报
 * - 全局错误 / unhandled rejection 监听
 * - initApp() 主初始化流程
 */

import { useStore } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { loadChannels } from './stores/channel-actions';
import { loadSessions } from './stores/session-actions';
import { connectWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { initJian } from './stores/desk-actions';
import { initEditorEvents } from './stores/artifact-actions';
import { updateLayout } from './components/SidebarLayout';
import { initErrorBusBridge } from './errors/error-bus-bridge';
// @ts-expect-error — shared JS module
import { errorBus as _errorBus } from '../../../shared/error-bus.js';
// @ts-expect-error — shared JS module
import { AppError as _AppError } from '../../../shared/errors.js';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- 全局 bootstrap：platform/IPC callback 签名含 any */

// ── __hanaLog：前端日志上报 ──
window.__hanaLog = function (level: string, module: string, message: string) {
  const { serverPort } = useStore.getState();
  if (!serverPort) return;
  hanaFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(err => console.warn('[hanaLog] log upload failed:', err));
};

// ── 全局错误捕获 ──
window.addEventListener('error', (e) => {
  _errorBus.report(_AppError.wrap(e.error || e.message), {
    context: { filename: e.filename, line: e.lineno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  _errorBus.report(_AppError.wrap(e.reason));
});

// ── 主初始化流程 ──

export async function initApp(): Promise<void> {
  const platform = window.platform;

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });

  if (!serverPort) {
    setStatus('status.serverNotReady', false);
    platform.appReady();
    return;
  }

  // 2. 并行获取 health + config
  try {
    const [healthRes, configRes] = await Promise.all([
      hanaFetch('/api/health'),
      hanaFetch('/api/config'),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();

    // 3. 加载 i18n
    await i18n.load(configData.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });

    // 4. 应用 agent 身份
    await applyAgentIdentity({
      agentName: healthData.agent || 'Lynn',
      userName: healthData.user || t('common.user'),
      ui: { avatars: false, agents: false, welcome: true },
    });

    // 5. 设置 desk 相关状态
    useStore.setState({
      homeFolder: configData.desk?.home_folder || null,
      trustedRoots: Array.isArray(configData.desk?.trusted_roots) ? configData.desk.trusted_roots : [],
      selectedFolder: configData.desk?.home_folder || null,
    });
    if (Array.isArray(configData.cwd_history)) {
      useStore.setState({ cwdHistory: configData.cwd_history });
    }

    // 6. 加载头像
    loadAvatars(healthData.avatars);
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
  }

  // 8. 连接 WebSocket
  connectWebSocket();
  initErrorBusBridge();

  // 9. 先准备基础可交互状态，尽快解除 splash；主数据改为后台补齐。
  useStore.setState({ pendingNewSession: true });

  // 10. 初始化书桌
  initJian();

  // 11. 初始化编辑器事件
  initEditorEvents();

  // 12. 主窗口基础内容已可用，先解除 splash。
  platform.appReady();

  // 13. 初始 layout 计算
  updateLayout();

  // 14-17. 主数据与次要状态统一转后台补齐，避免阻塞首屏。
  void Promise.allSettled([
    loadAgents(),
    loadSessions(),
    loadModels(),
    (async () => {
      try {
        await loadChannels();
      } catch { /* ignore */ }
    })(),
    (async () => {
      try {
        const res = await hanaFetch('/api/desk/cron');
        const data = await res.json();
        const count = (data.jobs || []).length;
        useStore.setState({ automationCount: count });
      } catch { /* ignore */ }
    })(),
    (async () => {
      try {
        const res = await hanaFetch('/api/bridge/status');
        const data = await res.json();
        const anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.qq?.status === 'connected' || data.whatsapp?.status === 'connected';
        useStore.setState({ bridgeDotConnected: anyConnected });
      } catch { /* ignore */ }
    })(),
    (async () => {
      try {
        const res = await hanaFetch('/api/skills/external-paths');
        const data = await res.json();
        const found = (data.discovered || []).filter((a: any) => a.exists);
        if (found.length > 0 && !localStorage.getItem('agent-discovery-seen')) {
          useStore.setState({ discoveredAgents: found, agentDiscoveryVisible: true });
        }
      } catch { /* ignore */ }
    })(),
  ]);

  // 18. 设置快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      platform.openSettings();
    }
  });

  // 19. 服务端重启后同步新端口/令牌并主动重连 WS
  platform.onServerRestarted?.((data: { port: number; token: string }) => {
    useStore.setState({ serverPort: String(data.port), serverToken: data.token });
    connectWebSocket(String(data.port), data.token);
    hanaFetch('/api/health')
      .then((res) => res.json())
      .then((healthData) => loadAvatars(healthData?.avatars))
      .catch(() => loadAvatars());
  });

  platform.onConfirmActionRequest?.((payload) => {
    useStore.getState().setPendingConfirm({
      title: payload.title,
      message: payload.message,
      detail: payload.detail,
      confirmLabel: payload.confirmLabel,
      cancelLabel: payload.cancelLabel,
      tone: payload.tone,
      onConfirm: () => {
        window.platform?.respondConfirmAction?.(payload.requestId, true);
      },
      onCancel: () => {
        window.platform?.respondConfirmAction?.(payload.requestId, false);
      },
    });
  });

  // 20. 设置变更监听
  platform.onSettingsChanged((type: string, data: any) => {
    switch (type) {
      case 'agent-switched':
        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        loadSessions();
        loadChannels();
        window.__loadDeskSkills?.();
        break;
      case 'skills-changed':
        window.__loadDeskSkills?.();
        break;
      case 'locale-changed':
        i18n.load(data.locale).then(() => {
          i18n.defaultName = useStore.getState().agentName;
          useStore.setState({ locale: i18n.locale });
        });
        break;
      case 'models-changed':
        loadModels();
        break;
      case 'agent-created':
      case 'agent-deleted':
        loadAgents();
        loadChannels();
        break;
      case 'agent-updated':
        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
          ui: { settings: false },
        });
        break;
      case 'review-config-changed':
        window.dispatchEvent(new CustomEvent('review-config-changed', { detail: data || null }));
        break;
      case 'theme-changed':
        setTheme(data.theme);
        break;
      case 'font-changed':
        setSerifFont(data.serif);
        break;
    }
  });

  // 21. Skill Viewer overlay（主进程 / 设置窗口 → 渲染进程）
  window.hana?.onShowSkillViewer?.((data: any) => {
    useStore.setState({ skillViewerData: data });
  });

  // appReady 已提前触发，避免 splash 额外阻塞。
}
