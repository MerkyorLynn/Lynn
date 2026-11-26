import { useCallback, useEffect, useMemo, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { isChineseLocale } from '../../utils/locale';
import { showSidebarToast } from '../../stores/session-actions';
import { loadModels } from '../../utils/ui-helpers';
import type { Model } from '../../types';
import {
  deriveLocalQwenRuntimeState,
  LOCAL_QWEN35_ENDPOINT,
  LOCAL_QWEN35_MODEL_ID,
  isRecommendedLocalModelId,
  LOCAL_QWEN35_PROVIDER_ID,
  localQwenDisplayName,
  LOCAL_QWEN_SHORT_NAME,
  type LocalQwen35RuntimeStatus,
} from './local-qwen-status';

interface UseLocalQwenStatusControllerArgs {
  models: Model[];
  currentModelInfo: Model | null | undefined;
  statusClassNames: {
    base: string;
    muted: string;
    busy: string;
  };
  requestInputFocus: () => void;
  setInlineError: (value: string | null) => void;
  setInlineNotice: (value: string | null) => void;
}

type LlamacppManagerEvent = {
  status?: string;
  reason?: string | null;
  error?: string | null;
  detail?: string | null;
};

/** Inline zh/en picker for copy that ships next to this hook. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

function formatLlamacppFailure(state: LlamacppManagerEvent) {
  const reason = String(state.reason || '').trim();
  const detail = String(state.error || state.detail || '').trim();
  const summary = [reason, detail].filter(Boolean).join(D('：', ': '));
  return summary || D('llama.cpp 启动后退出', 'llama.cpp exited after starting');
}

export function useLocalQwenStatusController({
  models,
  currentModelInfo,
  statusClassNames,
  requestInputFocus,
  setInlineError,
  setInlineNotice,
}: UseLocalQwenStatusControllerArgs) {
  const LOCAL_QWEN_DISPLAY_NAME = localQwenDisplayName();
  const [status, setStatus] = useState<LocalQwen35RuntimeStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [optimisticStarting, setOptimisticStarting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const model = useMemo(
    () => models.find(m => isRecommendedLocalModelId(m.id) && m.provider === LOCAL_QWEN35_PROVIDER_ID),
    [models],
  );
  const runtime = deriveLocalQwenRuntimeState(status, optimisticStarting, currentModelInfo);
  const servedModelIds = runtime.servedModelIds;
  const activeOrRecommendedId = servedModelIds.find(isRecommendedLocalModelId)
    || status?.plan?.hardware?.recommended_model_id || LOCAL_QWEN35_MODEL_ID;
  const endpointOccupied = runtime.endpointOccupied;
  const running = runtime.running;
  const loading = runtime.loading;
  const active = runtime.active;
  const current = runtime.current;
  const visible = active && !dismissed;
  const endpoint = runtime.endpoint;
  const runtimeLabel = runtime.runtimeLabel;
  const hasModel = runtime.hasModel;
  const hasRuntime = runtime.hasRuntime;
  const tpsSummary = runtime.tpsSummary;
  const slotSummary = runtime.slotSummary;
  const metricSummary = runtime.metricSummary;
  const coldStartLikely = runtime.coldStartLikely;
  const warmupStage = runtime.warmupStage;
  const warmupTitle = endpointOccupied
    ? D('检测到其他本地降级端点正在运行', 'Another local fallback endpoint is already running')
    : running
    ? (current
      ? `${LOCAL_QWEN_DISPLAY_NAME}${D(' 正在运行', ' is running')}`
      : `${LOCAL_QWEN_DISPLAY_NAME}${D(' 已就绪', ' is ready')}`)
    : warmupStage === 'launching'
      ? `${LOCAL_QWEN_DISPLAY_NAME}${D(' 正在启动', ' is starting')}`
      : warmupStage === 'loading'
        ? `${LOCAL_QWEN_DISPLAY_NAME}${D(' 正在加载', ' is loading')}`
        : `${LOCAL_QWEN_DISPLAY_NAME}${D(' 正在连接', ' is connecting')}`;
  const warmupCopy = endpointOccupied
    ? D(
      '旧版模型继续保留为兼容选项；停止该端点后可安装或启动 Qwen3.8-27B Coder390 Q3/Q2。',
      'Older models stay available as a compatibility option. Stop that endpoint to install or start Qwen3.8-27B Coder390 Q3/Q2.',
    )
    : running
    ? current
      ? (coldStartLikely
        ? D('本地端点已就绪，正在生成首个回答', 'The local endpoint is ready and generating the first answer')
        : `${runtimeLabel}${D(' · 本地离线运行，不消耗云端额度', ' · running locally offline, no cloud quota used')}`)
      : model
        ? D('已注册到模型列表，可一键切换为本地优先', 'Registered in the model list; switch to local-first with one click')
        : D('端点已就绪，正在同步到模型列表', 'The endpoint is ready and syncing to the model list')
    : warmupStage === 'launching'
      ? D('正在拉起 llama.cpp，本地端点马上接管', 'Starting llama.cpp; the local endpoint takes over shortly')
    : warmupStage === 'loading'
        ? D(
          `llama.cpp 已启动，正在加载 ${LOCAL_QWEN_SHORT_NAME} 权重`,
          `llama.cpp started and is loading the ${LOCAL_QWEN_SHORT_NAME} weights`,
        )
        : D('正在确认本地端点状态，稍后会自动刷新。', 'Checking the local endpoint status; it refreshes automatically.');
  const statusBarClass = [
    statusClassNames.base,
    (!running || endpointOccupied) ? statusClassNames.muted : '',
    active && !running ? statusClassNames.busy : '',
  ].filter(Boolean).join(' ');

  const refresh = useCallback(async (showFeedback = false) => {
    if (showFeedback) {
      showSidebarToast(D('正在刷新本地模型状态…', 'Refreshing local model status…'), 1600, 'info', 'local-qwen-refreshing');
    }
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 10_000 });
      const data = await res.json();
      setStatus(data);
      if (data?.runtime?.endpoint_running === true
        || data?.plan?.observed?.endpoint_running === true
        || data?.plan?.plan?.observed?.endpoint_running === true) {
        setOptimisticStarting(false);
      }
      if (data?.registered_provider && data?.plan?.observed?.endpoint_running) {
        void loadModels();
      }
      if (showFeedback) {
        showSidebarToast(D('本地模型状态已刷新。', 'Local model status refreshed.'), 2400, 'success', 'local-qwen-refreshed');
      }
    } catch (err) {
      if (showFeedback) {
        const msg = err instanceof Error ? err.message : String(err);
        showSidebarToast(D('刷新本地模型状态失败：', 'Could not refresh local model status: ') + msg, 5000, 'error', 'local-qwen-refresh-failed');
      }
    }
  }, []);

  const markLoading = useCallback(() => {
    setOptimisticStarting(true);
    setStatus(prev => ({
      ...(prev || { ok: true }),
      ok: prev?.ok ?? true,
      runtime: {
        ...(prev?.runtime || {}),
        base_url: prev?.runtime?.base_url || LOCAL_QWEN35_ENDPOINT,
        endpoint_running: prev?.runtime?.endpoint_running ?? false,
        endpoint_loading: true,
        process_alive: true,
      },
      plan: {
        ...(prev?.plan || {}),
        base_url: prev?.plan?.base_url || LOCAL_QWEN35_ENDPOINT,
        observed: {
          ...(prev?.plan?.observed || {}),
          endpoint_loading: true,
          llama_server: prev?.plan?.observed?.llama_server || 'llama-server',
        },
      },
    }));
  }, []);

  const markStopped = useCallback(() => {
    setOptimisticStarting(false);
    setStatus(prev => ({
      ...(prev || { ok: true }),
      ok: prev?.ok ?? true,
      runtime: {
        ...(prev?.runtime || {}),
        base_url: prev?.runtime?.base_url || LOCAL_QWEN35_ENDPOINT,
        endpoint_running: false,
        endpoint_loading: false,
        process_alive: false,
      },
      plan: {
        ...(prev?.plan || {}),
        base_url: prev?.plan?.base_url || LOCAL_QWEN35_ENDPOINT,
        observed: {
          ...(prev?.plan?.observed || {}),
          endpoint_running: false,
          endpoint_loading: false,
        },
        plan: prev?.plan?.plan
          ? {
              ...prev.plan.plan,
              observed: {
                ...(prev.plan.plan.observed || {}),
                endpoint_running: false,
                endpoint_loading: false,
              },
            }
          : prev?.plan?.plan,
      },
    }));
  }, []);

  const scheduleRefreshBurst = useCallback(() => {
    [0, 250, 750, 1500, 3000, 6000, 12000].forEach(delay => {
      window.setTimeout(() => void refresh(), delay);
    });
  }, [refresh]);

  const ensureCurrentReady = useCallback(async () => {
    if (!current) return true;

    let endpointRunning = running;
    if (!endpointRunning) {
      try {
        const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 3500 });
        const data = await res.json();
        setStatus(data);
        endpointRunning = data?.runtime?.endpoint_running === true
          || data?.plan?.observed?.endpoint_running === true
          || data?.plan?.plan?.observed?.endpoint_running === true;
        if (data?.registered_provider && endpointRunning) {
          void loadModels();
        }
      } catch {
        endpointRunning = false;
      }
    }

    if (endpointRunning) return true;

    setDismissed(false);
    setInlineNotice(null);
    setInlineError(D(
      `${LOCAL_QWEN_DISPLAY_NAME} 未运行。请先点击上方"启动"，或从模型选择器切换到云端模型。`,
      `${LOCAL_QWEN_DISPLAY_NAME} is not running. Press "Start" above, or switch to a cloud model in the model selector.`,
    ));
    showSidebarToast(
      D(
        `本地模型还没启动。请先启动${LOCAL_QWEN_DISPLAY_NAME}，或切换到云端模型。`,
        `The local model is not running yet. Start ${LOCAL_QWEN_DISPLAY_NAME}, or switch to a cloud model.`,
      ),
      5000,
      'warning',
      'local-qwen-not-running',
    );
    requestInputFocus();
    return false;
  }, [current, requestInputFocus, running, setInlineError, setInlineNotice]);

  useEffect(() => {
    void refresh();
    const intervalMs = active ? 3_000 : 15_000;
    const id = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  useEffect(() => {
    const off = window.platform?.onLlamacppState?.((state) => {
      const managerStatus = String(state?.status || '');
      if (managerStatus !== 'failed' && managerStatus !== 'crashed') return;
      if (!optimisticStarting && !current && !active) return;

      const reason = formatLlamacppFailure(state || {});
      setOptimisticStarting(false);
      setStatus(prev => ({
        ...(prev || { ok: true }),
        ok: prev?.ok ?? true,
        runtime: {
          ...(prev?.runtime || {}),
          base_url: prev?.runtime?.base_url || LOCAL_QWEN35_ENDPOINT,
          endpoint_running: false,
          endpoint_loading: false,
          process_alive: false,
        },
        plan: {
          ...(prev?.plan || {}),
          base_url: prev?.plan?.base_url || LOCAL_QWEN35_ENDPOINT,
          observed: {
            ...(prev?.plan?.observed || {}),
            endpoint_running: false,
            endpoint_loading: false,
          },
          plan: prev?.plan?.plan
            ? {
                ...prev.plan.plan,
                observed: {
                  ...(prev.plan.plan.observed || {}),
                  endpoint_running: false,
                  endpoint_loading: false,
                },
              }
            : prev?.plan?.plan,
        },
      }));
      setDismissed(false);
      setInlineNotice(null);
      setInlineError(`${LOCAL_QWEN_DISPLAY_NAME}${D(' 启动失败：', ' failed to start: ')}${reason}`);
      showSidebarToast(
        D(
          `启动${LOCAL_QWEN_DISPLAY_NAME}失败：${reason}`,
          `Could not start ${LOCAL_QWEN_DISPLAY_NAME}: ${reason}`,
        ),
        7000,
        'error',
        'local-qwen-start-failed',
      );
    });
    return () => {
      try { off?.(); } catch {
        // ignore unsubscribe failures
      }
    };
  }, [active, current, optimisticStarting, setInlineError, setInlineNotice]);

  const switchToLocal = useCallback(async () => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: activeOrRecommendedId, provider: LOCAL_QWEN35_PROVIDER_ID }),
      });
      await loadModels();
      showSidebarToast(
        D(`已切换到${LOCAL_QWEN_DISPLAY_NAME}。`, `Switched to ${LOCAL_QWEN_DISPLAY_NAME}.`),
        4000,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast(
        D(`切换${LOCAL_QWEN_DISPLAY_NAME}失败：`, `Could not switch to ${LOCAL_QWEN_DISPLAY_NAME}: `) + msg,
        5000,
        'error',
      );
    }
  }, [activeOrRecommendedId]);

  const stop = useCallback(async () => {
    try {
      const managerStop = await window.platform?.llamacppStop?.();
      if (managerStop && managerStop.ok === false) {
        throw new Error(managerStop.reason || 'llamacpp_manager_stop_failed');
      }
      const res = await hanaFetch('/api/local-qwen35-9b/stop', { method: 'POST', timeout: 10_000 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'stop_failed');
      }
      markStopped();
      setDismissed(false);
      await refresh();
      showSidebarToast(D('本地模型已停止，已释放 llama.cpp。', 'Local model stopped and llama.cpp released.'), 4000, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast(D('停止本地模型失败：', 'Could not stop the local model: ') + msg, 5000, 'error');
    }
  }, [markStopped, refresh]);

  const openSettings = useCallback(() => {
    window.platform?.openSettings?.({
      tab: 'providers',
      providerId: LOCAL_QWEN35_PROVIDER_ID,
    });
  }, []);

  const dismiss = useCallback(() => {
    const message = active
      ? D(
        '只是收起本地模型状态条，不会停止模型。之后可点聊天框里的“本地模型状态”恢复，或去“设置 > 模型”停止本地模型。',
        'This only hides the local model status bar; the model keeps running. Restore it from "Local model status" in the composer, or stop it in "Settings > Models".',
      )
      : D(
        '收起这条本地模型提示？之后仍可在“设置 > 模型”里启动。',
        'Hide this local model notice? You can still start it from "Settings > Models".',
      );
    if (!window.confirm(message)) return;
    setDismissed(true);
  }, [active]);

  const start = useCallback(async () => {
    try {
      setDismissed(false);
      markLoading();
      scheduleRefreshBurst();
      const managerStart = await window.platform?.llamacppStartDownload?.({
        modelId: activeOrRecommendedId,
        startAfterDownload: true,
      });
      if (managerStart) {
        if (managerStart.ok === false) {
          throw new Error(managerStart.reason || 'llamacpp_manager_start_failed');
        }
        showSidebarToast(
          D(
            `${LOCAL_QWEN_DISPLAY_NAME} 正在启动，Lynn 会自动切换到本地模型。`,
            `${LOCAL_QWEN_DISPLAY_NAME} is starting; Lynn switches to the local model automatically.`,
          ),
          4500,
          'info',
        );
        await loadModels();
        await refresh();
        scheduleRefreshBurst();
        return;
      }
      throw new Error(D(
        '此方案需要 Lynn 桌面端下载器，请在设置中使用部署助手。',
        'This option needs the Lynn desktop downloader. Use the deployment assistant in Settings.',
      ));
    } catch (err) {
      setOptimisticStarting(false);
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast(
        D(`启动${LOCAL_QWEN_DISPLAY_NAME}失败：`, `Could not start ${LOCAL_QWEN_DISPLAY_NAME}: `) + msg,
        5000,
        'error',
      );
      openSettings();
    }
  }, [markLoading, openSettings, refresh, scheduleRefreshBurst, activeOrRecommendedId]);

  const openDashboard = useCallback(() => {
    setPanelOpen((open) => !open);
    void refresh();
  }, [refresh]);

  const showStatus = useCallback(() => {
    setDismissed(false);
    setPanelOpen(true);
    void refresh();
  }, [refresh]);

  return {
    status,
    visible,
    active,
    dismissed,
    panelOpen,
    statusBarClass,
    warmupTitle,
    warmupCopy,
    endpoint,
    endpointOccupied,
    running,
    loading,
    current,
    coldStartLikely,
    canSwitch: !!(running && model && !current),
    canShowStopped: !!(current && !active && model && hasModel && hasRuntime && !dismissed),
    hasModel,
    hasRuntime,
    tpsSummary,
    metricSummary,
    slotSummary,
    servedModelIds,
    ensureCurrentReady,
    switchToLocal,
    refresh,
    openDashboard,
    stop,
    dismiss,
    showStatus,
    start,
    openSettings,
    setPanelOpen,
  };
}

export type LocalQwenStatusController = ReturnType<typeof useLocalQwenStatusController>;
