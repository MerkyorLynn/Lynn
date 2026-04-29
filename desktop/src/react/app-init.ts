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
import { syncRuntimeSnapshot } from './utils/runtime-snapshot';
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

interface ServerStartupHealth {
  stage?: string | null;
  ready?: boolean;
  error?: string | null;
  elapsedMs?: number;
}

function syncServerStartup(startup: ServerStartupHealth | null | undefined): void {
  const state = startup || {};
  useStore.getState().setServerStartup({
    ready: !!state.ready,
    stage: state.stage || null,
    error: state.error || null,
  });

  const label = '服务初始化';
  if (state.ready) {
    useStore.getState().markStartupStep('server-ready', label, 'success', 'ready', { ...state });
  } else if (state.error) {
    useStore.getState().markStartupStep('server-ready', label, 'error', state.error, { ...state });
  } else {
    useStore.getState().markStartupStep('server-ready', label, 'running', state.stage || 'starting', { ...state });
  }
}

function startServerReadinessPolling(): void {
  const poll = async () => {
    if (useStore.getState().serverReady) return;
    try {
      const res = await hanaFetch('/api/health', { timeout: 4000 });
      const data = await res.json();
      syncServerStartup(data?.startup);
      if (!data?.startup?.ready && !data?.startup?.error) {
        setTimeout(poll, 1000);
      }
    } catch (err) {
      useStore.getState().markStartupStep(
        'server-ready',
        '服务初始化',
        'warning',
        err instanceof Error ? err.message : String(err),
      );
      setTimeout(poll, 1500);
    }
  };
  setTimeout(poll, 1000);
}

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
  let shouldDiagnoseBrain = false;
  const startup = useStore.getState();
  startup.resetStartupDiagnostics();
  startup.markStartupStep('server-port', '读取本地服务端口', 'running');

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });
  useStore.getState().markStartupStep(
    'server-port',
    '读取本地服务端口',
    serverPort ? 'success' : 'error',
    serverPort ? `127.0.0.1:${serverPort}` : '未拿到本地服务端口',
  );

  if (!serverPort) {
    setStatus('status.serverNotReady', false);
    useStore.getState().markStartupStep('bootstrap', '主窗口启动', 'warning', '服务尚未 ready，已提前显示外壳');
    platform.appReady();
    return;
  }

  // 先让主窗口壳子显示出来，避免 onboarding 结束后卡在米色空白页等待网络与配置。
  useStore.setState({ pendingNewSession: true });
  useStore.getState().markStartupStep('bootstrap', '主窗口启动', 'success', '已提前显示主窗口壳层');
  platform.appReady();

  // 2. 并行获取 health + config
  useStore.getState().markStartupStep('health-config', '加载 health / config / app-state', 'running');
  try {
    const [healthRes, configRes, appStateRes] = await Promise.all([
      hanaFetch('/api/health'),
      hanaFetch('/api/config'),
      hanaFetch('/api/app-state'),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();
    const appStateData = await appStateRes.json();
    syncServerStartup(healthData?.startup);
    if (!healthData?.startup?.ready) startServerReadinessPolling();

    // 3. 加载 i18n
    useStore.getState().markStartupStep('locale', '加载语言资源', 'running');
    await i18n.load(configData.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });
    useStore.getState().markStartupStep('locale', '加载语言资源', 'success', i18n.locale);

    // 4. 应用 agent 身份
    useStore.getState().markStartupStep('agent-identity', '同步当前助手身份', 'running');
    await applyAgentIdentity({
      agentName: appStateData?.agent?.name || healthData.agent || 'Lynn',
      agentId: appStateData?.agent?.currentAgentId || undefined,
      userName: healthData.user || t('common.user'),
      yuan: appStateData?.agent?.yuan || undefined,
      ui: { avatars: false, agents: false, welcome: true },
    });
    useStore.getState().markStartupStep(
      'agent-identity',
      '同步当前助手身份',
      'success',
      appStateData?.agent?.name || healthData.agent || 'Lynn',
    );

    // 5. 设置 desk 相关状态
    useStore.setState({
      homeFolder: appStateData?.desk?.homeFolder || configData.desk?.home_folder || null,
      trustedRoots: Array.isArray(appStateData?.desk?.trustedRoots)
        ? appStateData.desk.trustedRoots
        : (Array.isArray(configData.desk?.trusted_roots) ? configData.desk.trusted_roots : []),
      selectedFolder: appStateData?.desk?.homeFolder || configData.desk?.home_folder || null,
      currentModel: appStateData?.model?.current?.id
        ? { id: appStateData.model.current.id, provider: appStateData.model.current.provider || '' }
        : null,
      taskSnapshot: appStateData?.tasks || null,
      capabilitySnapshot: appStateData?.capabilities || null,
    });
    shouldDiagnoseBrain = appStateData?.model?.current?.provider === 'brain';
    if (Array.isArray(configData.cwd_history)) {
      useStore.setState({ cwdHistory: configData.cwd_history });
    }
    if (appStateData?.tasks?.activeCount) {
      void syncRuntimeSnapshot({ announceRecovery: true });
    }

    // 6. 加载头像
    loadAvatars(healthData.avatars);
    useStore.getState().markStartupStep('health-config', '加载 health / config / app-state', 'success');
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
    useStore.getState().markStartupStep(
      'health-config',
      '加载 health / config / app-state',
      'error',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 8. 连接 WebSocket
  useStore.getState().markStartupStep('websocket', '连接 WebSocket', 'running');
  connectWebSocket();
  initErrorBusBridge();

  // 9. 初始化书桌
  useStore.getState().markStartupStep('desk-init', '初始化书桌运行时', 'running');
  initJian();
  useStore.getState().markStartupStep('desk-init', '初始化书桌运行时', 'success');

  // 10. 初始化编辑器事件
  useStore.getState().markStartupStep('editor-events', '初始化编辑器事件', 'running');
  initEditorEvents();
  useStore.getState().markStartupStep('editor-events', '初始化编辑器事件', 'success');

  // 11. 初始 layout 计算
  updateLayout();
  useStore.getState().markStartupStep('layout', '计算初始布局', 'success');

  // 12-17. 主数据与次要状态统一转后台补齐，避免阻塞首屏。
  useStore.getState().markStartupStep('background-loads', '后台补齐主数据', 'running', 'agents / sessions / models / channels / cron / bridge');
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
        if (found.length > 0) {
          useStore.setState({ discoveredAgents: found });
        }
      } catch { /* ignore */ }
    })(),
  ]).then((results) => {
    const hasRejected = results.some((result) => result.status === 'rejected');
    useStore.getState().markStartupStep(
      'background-loads',
      '后台补齐主数据',
      hasRejected ? 'warning' : 'success',
      hasRejected ? '部分后台数据加载失败，已降级继续' : '主数据已加载完成',
    );
  });

  if (shouldDiagnoseBrain) {
    useStore.getState().markStartupStep('brain-diagnose', '诊断默认模型服务', 'running');
    setTimeout(() => {
      void (async () => {
        try {
          const diagRes = await hanaFetch('/api/brain/diagnose');
          const diag = await diagRes.json();
          if (diag.registering || diag.reachable) {
            useStore.getState().markStartupStep('brain-diagnose', '诊断默认模型服务', 'success', diag.registering ? '服务注册中' : '连通正常');
            return;
          }
          const currentModel = useStore.getState().currentModel;
          if (currentModel?.provider !== 'brain') return;
          console.warn('[init] Brain 连通性诊断失败:', diag.error);
          useStore.getState().markStartupStep('brain-diagnose', '诊断默认模型服务', 'warning', diag.error || '默认模型服务暂时不可达');
          useStore.getState().addToast(
            t('error.brainUnreachable') ||
            `默认模型服务暂时不可达${diag.error ? ` (${diag.error})` : ''}，请检查网络连接或在设置中切换到自己的 API Key。`,
            'warning',
            8000,
            { dedupeKey: 'brain-unreachable' },
          );
        } catch (err) {
          useStore.getState().markStartupStep(
            'brain-diagnose',
            '诊断默认模型服务',
            'warning',
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    }, 0);
  } else {
    useStore.getState().markStartupStep('brain-diagnose', '诊断默认模型服务', 'success', '当前未使用默认模型服务');
  }

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
    useStore.getState().markStartupStep('server-restart', '检测到本地服务重启', 'warning', `127.0.0.1:${data.port}`);
    connectWebSocket(String(data.port), data.token);
    void syncRuntimeSnapshot({ announceRecovery: true });
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

  // 19b. 全局快捷键唤醒 → 自动聚焦输入框
  platform.onGlobalSummon?.(() => {
    useStore.setState({ welcomeVisible: false });
    useStore.getState().requestInputFocus();
  });

  // 20. 设置变更监听
  platform.onSettingsChanged((type: string, data: any) => {
    switch (type) {
      case 'agent-switched':
        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        void syncRuntimeSnapshot({ announceRecovery: false });
        loadSessions();
        loadChannels();
        window.__loadDeskSkills?.();
        break;
      case 'skills-changed':
        window.__loadDeskSkills?.();
        window.dispatchEvent(new CustomEvent('skills-changed'));
        break;
      case 'desk-config-changed':
        void syncRuntimeSnapshot({ announceRecovery: false });
        break;
      case 'locale-changed':
        i18n.load(data.locale).then(() => {
          i18n.defaultName = useStore.getState().agentName;
          useStore.setState({ locale: i18n.locale });
        });
        break;
      case 'models-changed':
        void syncRuntimeSnapshot({ announceRecovery: false });
        loadModels();
        window.dispatchEvent(new CustomEvent('models-changed'));
        break;
      case 'agent-created':
      case 'agent-deleted':
        loadAgents();
        loadChannels();
        break;
      case 'agent-updated':
        if (!data?.agentId || data.agentId === useStore.getState().currentAgentId) {
          applyAgentIdentity({
            agentName: data.agentName,
            agentId: data.agentId,
            ui: { settings: false },
          });
        }
        break;
      case 'review-config-changed':
        void syncRuntimeSnapshot({ announceRecovery: false });
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
  useStore.getState().setStartupPhase('ready');
}
