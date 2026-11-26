/**
 * app-init.ts — 应用初始化逻辑（纯函数，非 React 组件）
 *
 * 从 App.tsx 提取。包含：
 * - __hanaLog 日志上报
 * - 全局错误 / unhandled rejection 监听
 * - initApp() 主初始化流程
 */

import { useStore } from './stores';
import { isChineseLocale } from './utils/locale';

/** Inline zh/en picker for startup copy; follows the active UI locale. */
function L(zhText: string, enText: string): string {
  return isChineseLocale() ? zhText : enText;
}
import { setLeavesOverlayEnabled } from './hooks/use-leaves-overlay';
import { hanaFetch } from './hooks/use-hana-fetch';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { loadSessions } from './stores/session-actions';
import { connectWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { initJian } from './stores/desk-actions';
import { initEditorEvents } from './stores/artifact-actions';
import { updateLayout } from './services/layout-controller';
import { initErrorBusBridge } from './errors/error-bus-bridge';
import { syncRuntimeSnapshot } from './utils/runtime-snapshot';
import { JARVIS_RUNTIME_TOGGLE_EVENT } from './services/jarvis-runtime-events';
import { errorBus as _errorBus } from '../../../shared/error-bus.js';
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

  const label = L('服务初始化', 'Starting the service');
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
        L('服务初始化', 'Starting the service'),
        'warning',
        err instanceof Error ? err.message : String(err),
      );
      setTimeout(poll, 1500);
    }
  };
  setTimeout(poll, 1000);
}

function handleServerRestarted(data: { port: number; token: string }): void {
  useStore.setState({ serverPort: String(data.port), serverToken: data.token });
  useStore.getState().markStartupStep('server-restart', L('检测到本地服务重启', 'Local service restarted'), 'warning', `127.0.0.1:${data.port}`);
  connectWebSocket(String(data.port), data.token);
  void syncRuntimeSnapshot({ announceRecovery: true });
  hanaFetch('/api/health')
    .then((res) => res.json())
    .then((healthData) => loadAvatars(healthData?.avatars))
    .catch(() => loadAvatars());
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
  // Clipboard writes (navigator.clipboard.writeText) reject in Electron on focus/permission
  // edge cases even when the OS clipboard WAS actually written — non-critical, and surfacing
  // them as an error toast (e.g. "Failed to execute 'writeText' on 'Clipboard': Write
  // permission denied") is a false alarm. Swallow that specific class; everything else reports.
  const reason = e.reason as { name?: unknown; message?: unknown } | undefined;
  const detail = String((reason && (reason.message ?? reason)) || '');
  if (/writeText|clipboard/i.test(detail)) {
    e.preventDefault?.();
    return;
  }
  _errorBus.report(_AppError.wrap(e.reason));
});

// ── 主初始化流程 ──

export async function initApp(): Promise<void> {
  const platform = window.platform;
  let shouldDiagnoseBrain = false;
  platform.onServerRestarted?.(handleServerRestarted);
  const startup = useStore.getState();
  startup.resetStartupDiagnostics();
  startup.markStartupStep('server-port', L('读取本地服务端口', 'Reading the local service port'), 'running');

  // Language resources must not depend on the local service being healthy.
  try {
    await i18n.load(i18n.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });
  } catch (error) {
    console.warn('[init] initial locale load failed:', error);
  }

  // The shell stays responsive while a late-starting service becomes ready.
  let serverPort = await Promise.resolve(platform.getServerPort()).catch(() => null);
  if (!serverPort) {
    setStatus('status.serverNotReady', false);
    platform.appReady();
  }
  while (!serverPort) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    serverPort = await Promise.resolve(platform.getServerPort()).catch(() => null);
  }
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });
  useStore.getState().markStartupStep(
    'server-port',
    L('读取本地服务端口', 'Reading the local service port'),
    serverPort ? 'success' : 'error',
    serverPort ? `127.0.0.1:${serverPort}` : L('未拿到本地服务端口', 'Could not read the local service port'),
  );

  // 先让主窗口壳子显示出来，避免 onboarding 结束后卡在米色空白页等待网络与配置。
  useStore.setState({ pendingNewSession: true });
  useStore.getState().markStartupStep('bootstrap', L('主窗口启动', 'Main window boot'), 'success', L('已提前显示主窗口壳层', 'Main window shell shown early'));
  platform.appReady();

  // 2. 并行获取 health + config
  useStore.getState().markStartupStep('health-config', L('加载 health / config / app-state', 'Loading health / config / app-state'), 'running');
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
    useStore.getState().markStartupStep('locale', L('加载语言资源', 'Loading language resources'), 'running');
    if (i18n.locale !== (configData.locale || 'zh-CN')) await i18n.load(configData.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });
    useStore.getState().markStartupStep('locale', L('加载语言资源', 'Loading language resources'), 'success', i18n.locale);
    if (await platform.consumeRendererRecovery?.()) {
      useStore.getState().addToast(
        t('status.rendererRecovered'),
        'warning',
        0,
        { dedupeKey: 'renderer-recovered', persistent: true },
      );
    }

    // 4. 应用 agent 身份
    useStore.getState().markStartupStep('agent-identity', L('同步当前助手身份', 'Syncing the assistant identity'), 'running');
    await applyAgentIdentity({
      agentName: appStateData?.agent?.name || healthData.agent || 'Lynn',
      agentId: appStateData?.agent?.currentAgentId || undefined,
      userName: healthData.user || t('common.user'),
      yuan: appStateData?.agent?.yuan || undefined,
      ui: { avatars: false, agents: false, welcome: true },
    });
    useStore.getState().markStartupStep(
      'agent-identity',
      L('同步当前助手身份', 'Syncing the assistant identity'),
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
    useStore.getState().markStartupStep('health-config', L('加载 health / config / app-state', 'Loading health / config / app-state'), 'success');
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
    useStore.getState().markStartupStep(
      'health-config',
      L('加载 health / config / app-state', 'Loading health / config / app-state'),
      'error',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 8. 连接 WebSocket
  useStore.getState().markStartupStep('websocket', L('连接 WebSocket', 'Connecting WebSocket'), 'running');
  connectWebSocket();
  initErrorBusBridge();

  // 9. 初始化书桌
  useStore.getState().markStartupStep('desk-init', L('初始化书桌运行时', 'Initialising the desk runtime'), 'running');
  initJian();
  useStore.getState().markStartupStep('desk-init', L('初始化书桌运行时', 'Initialising the desk runtime'), 'success');

  // 10. 初始化编辑器事件
  useStore.getState().markStartupStep('editor-events', L('初始化编辑器事件', 'Initialising editor events'), 'running');
  initEditorEvents();
  useStore.getState().markStartupStep('editor-events', L('初始化编辑器事件', 'Initialising editor events'), 'success');

  // 11. 初始 layout 计算
  updateLayout();
  useStore.getState().markStartupStep('layout', L('计算初始布局', 'Calculating the initial layout'), 'success');

  // 12-17. 主数据与次要状态统一转后台补齐，避免阻塞首屏。
  useStore.getState().markStartupStep('background-loads', L('后台补齐主数据', 'Loading remaining main data'), 'running', 'agents / sessions / models / cron / bridge');
  void Promise.allSettled([
    loadAgents(),
    loadSessions(),
    loadModels(),
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
      L('后台补齐主数据', 'Loading remaining main data'),
      hasRejected ? 'warning' : 'success',
      hasRejected
        ? L('部分后台数据加载失败，已降级继续', 'Some background data failed to load; continuing in a degraded state')
        : L('主数据已加载完成', 'Main data loaded'),
    );
  });

  if (shouldDiagnoseBrain) {
    useStore.getState().markStartupStep('brain-diagnose', L('诊断默认模型服务', 'Diagnosing the default model service'), 'running');
    setTimeout(() => {
      void (async () => {
        try {
          const diagRes = await hanaFetch('/api/brain/diagnose');
          const diag = await diagRes.json();
          if (diag.registering || diag.reachable) {
            useStore.getState().markStartupStep('brain-diagnose', L('诊断默认模型服务', 'Diagnosing the default model service'), 'success', diag.registering ? L('服务注册中', 'Registering the service') : L('连通正常', 'Reachable'));
            return;
          }
          const currentModel = useStore.getState().currentModel;
          if (currentModel?.provider !== 'brain') return;
          console.warn('[init] Brain 连通性诊断失败:', diag.error);
          useStore.getState().markStartupStep('brain-diagnose', L('诊断默认模型服务', 'Diagnosing the default model service'), 'warning', diag.error || L('默认模型服务暂时不可达', 'The default model service is temporarily unreachable'));
          useStore.getState().addToast(
            t('error.brainUnreachable') ||
            L(
              `默认模型服务暂时不可达${diag.error ? ` (${diag.error})` : ''}，请检查网络连接或在设置中切换到自己的 API Key。`,
              `The default model service is temporarily unreachable${diag.error ? ` (${diag.error})` : ''}. Check your network connection, or switch to your own API key in Settings.`,
            ),
            'warning',
            8000,
            { dedupeKey: 'brain-unreachable' },
          );
        } catch (err) {
          useStore.getState().markStartupStep(
            'brain-diagnose',
            L('诊断默认模型服务', 'Diagnosing the default model service'),
            'warning',
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    }, 0);
  } else {
    useStore.getState().markStartupStep('brain-diagnose', L('诊断默认模型服务', 'Diagnosing the default model service'), 'success', L('当前未使用默认模型服务', 'Not using the default model service'));
  }

  // 18. 设置快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      platform.openSettings();
    }
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

  // 19b. 全局快捷键唤醒 → Jarvis Runtime overlay
  platform.onGlobalSummon?.(() => {
    useStore.setState({ welcomeVisible: false });
    window.dispatchEvent(new CustomEvent(JARVIS_RUNTIME_TOGGLE_EVENT));
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
      case 'leaves-overlay-changed':
        if (typeof data?.enabled === 'boolean') setLeavesOverlayEnabled(data.enabled);
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
