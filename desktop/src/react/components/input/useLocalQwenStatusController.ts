import { useCallback, useEffect, useMemo, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { showSidebarToast } from '../../stores/session-actions';
import { loadModels } from '../../utils/ui-helpers';
import type { Model } from '../../types';
import {
  deriveLocalQwenRuntimeState,
  LOCAL_QWEN35_ENDPOINT,
  LOCAL_QWEN35_MODEL_ID,
  LOCAL_QWEN35_PROVIDER_ID,
  LOCAL_QWEN_PROMPT_DELAY_MS,
  LOCAL_QWEN_PROMPT_DISMISS_KEY,
  LOCAL_QWEN_PROMPT_SHOWN_KEY,
  todayKey,
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

export function useLocalQwenStatusController({
  models,
  currentModelInfo,
  statusClassNames,
  requestInputFocus,
  setInlineError,
  setInlineNotice,
}: UseLocalQwenStatusControllerArgs) {
  const [status, setStatus] = useState<LocalQwen35RuntimeStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [optimisticStarting, setOptimisticStarting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const [snoozed, setSnoozed] = useState(() => {
    try {
      const today = todayKey();
      return localStorage.getItem(LOCAL_QWEN_PROMPT_DISMISS_KEY) === today
        || localStorage.getItem(LOCAL_QWEN_PROMPT_SHOWN_KEY) === today;
    } catch {
      return false;
    }
  });

  const model = useMemo(
    () => models.find(m => m.id === LOCAL_QWEN35_MODEL_ID && m.provider === LOCAL_QWEN35_PROVIDER_ID),
    [models],
  );
  const runtime = deriveLocalQwenRuntimeState(status, optimisticStarting, currentModelInfo);
  const servedModelIds = runtime.servedModelIds;
  const endpointOccupied = runtime.endpointOccupied;
  const running = runtime.running;
  const loading = runtime.loading;
  const active = runtime.active;
  const current = runtime.current;
  const visible = active && !dismissed;
  const endpoint = runtime.endpoint;
  const runtimeLabel = runtime.runtimeLabel;
  const canEnable = runtime.canEnable;
  const hasModel = runtime.hasModel;
  const hasRuntime = runtime.hasRuntime;
  const recommended = promptReady && !!status?.ok && canEnable && !active && !dismissed && !snoozed;
  const tpsSummary = runtime.tpsSummary;
  const slotSummary = runtime.slotSummary;
  const metricSummary = runtime.metricSummary;
  const coldStartLikely = runtime.coldStartLikely;
  const warmupStage = runtime.warmupStage;
  const warmupTitle = endpointOccupied
    ? '检测到 Qwen3.5-4B 降级端点正在运行'
    : running
    ? (current ? '本地 Qwen3.5-9B 正在运行' : '本地 Qwen3.5-9B 已就绪')
    : warmupStage === 'launching'
      ? '本地 Qwen3.5-9B 正在启动'
      : warmupStage === 'loading'
        ? '本地 Qwen3.5-9B 正在加载'
        : '本地 Qwen3.5-9B 正在连接';
  const warmupCopy = endpointOccupied
    ? '4B 只作为低配降级/兼容模型，不再作为默认引导；停止该端点后可启动默认 9B MTP。'
    : running
    ? current
      ? (coldStartLikely
        ? '本地端点已就绪，正在生成首个回答'
        : `${runtimeLabel} · 本地离线运行，不消耗云端额度`)
      : model
        ? '已注册到模型列表，可一键切换为本地优先'
        : '端点已就绪，正在同步到模型列表'
    : warmupStage === 'launching'
      ? '正在拉起 llama.cpp，本地端点马上接管'
      : warmupStage === 'loading'
        ? 'llama.cpp 已启动，正在加载 Qwen3.5-9B 权重'
        : '正在确认本地端点状态，稍后会自动刷新。';
  const statusBarClass = [
    statusClassNames.base,
    (!running || endpointOccupied) ? statusClassNames.muted : '',
    active && !running ? statusClassNames.busy : '',
  ].filter(Boolean).join(' ');

  const refresh = useCallback(async (showFeedback = false) => {
    if (showFeedback) {
      showSidebarToast('正在刷新本地模型状态…', 1600, 'info', 'local-qwen-refreshing');
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
        showSidebarToast('本地模型状态已刷新。', 2400, 'success', 'local-qwen-refreshed');
      }
    } catch (err) {
      if (showFeedback) {
        const msg = err instanceof Error ? err.message : String(err);
        showSidebarToast('刷新本地模型状态失败：' + msg, 5000, 'error', 'local-qwen-refresh-failed');
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
    setInlineError('本地 Qwen3.5-9B 未运行。请先点击上方"启动"，或从模型选择器切换到云端模型。');
    showSidebarToast('本地模型还没启动。请先启动本地 Qwen3.5-9B，或切换到云端模型。', 5000, 'warning', 'local-qwen-not-running');
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
    const id = window.setTimeout(() => setPromptReady(true), LOCAL_QWEN_PROMPT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!recommended) return;
    try {
      localStorage.setItem(LOCAL_QWEN_PROMPT_SHOWN_KEY, todayKey());
    } catch {
      // ignore unavailable storage
    }
  }, [recommended]);

  const switchToLocal = useCallback(async () => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: LOCAL_QWEN35_MODEL_ID, provider: LOCAL_QWEN35_PROVIDER_ID }),
      });
      await loadModels();
      showSidebarToast('已切换到本地 Qwen3.5-9B。', 4000, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('切换本地 Qwen3.5-9B 失败：' + msg, 5000, 'error');
    }
  }, []);

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
      showSidebarToast('本地模型已停止，已释放 llama.cpp。', 4000, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('停止本地模型失败：' + msg, 5000, 'error');
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
      ? '只是收起本地模型状态条，不会停止模型。之后可点聊天框里的“本地模型状态”恢复，或去“设置 > 模型”停止本地模型。'
      : '收起这条本地模型提示？之后仍可在“设置 > 模型”里启动。';
    if (!window.confirm(message)) return;
    setDismissed(true);
  }, [active]);

  const start = useCallback(async () => {
    try {
      setDismissed(false);
      markLoading();
      scheduleRefreshBurst();
      const managerStart = await window.platform?.llamacppStartDownload?.({
        modelId: 'qwen35-9b-q4km-imatrix',
        startAfterDownload: true,
      });
      if (managerStart) {
        if (managerStart.ok === false) {
          throw new Error(managerStart.reason || 'llamacpp_manager_start_failed');
        }
        await hanaFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: LOCAL_QWEN35_MODEL_ID, provider: LOCAL_QWEN35_PROVIDER_ID }),
        }).catch(() => null);
        showSidebarToast('本地 Qwen3.5-9B 正在启动，Lynn 会自动切换到本地模型。', 4500, 'info');
        await loadModels();
        await refresh();
        scheduleRefreshBurst();
        return;
      }
      const res = await hanaFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        timeout: 30_000,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'start_failed');
      }
      showSidebarToast('本地 Qwen3.5-9B 正在启动，Lynn 会自动切换到本地模型。', 4500, 'info');
      await refresh();
      scheduleRefreshBurst();
    } catch (err) {
      setOptimisticStarting(false);
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('启动本地 Qwen3.5-9B 失败：' + msg, 5000, 'error');
      openSettings();
    }
  }, [markLoading, openSettings, refresh, scheduleRefreshBurst]);

  const openDashboard = useCallback(() => {
    setPanelOpen((open) => !open);
    void refresh();
  }, [refresh]);

  const showStatus = useCallback(() => {
    setDismissed(false);
    setPanelOpen(true);
    void refresh();
  }, [refresh]);

  const snoozePrompt = useCallback(() => {
    try {
      localStorage.setItem(LOCAL_QWEN_PROMPT_DISMISS_KEY, todayKey());
    } catch {
      // ignore unavailable storage
    }
    setSnoozed(true);
    setDismissed(true);
    showSidebarToast('今天不再提醒本地模型安装。你仍可在“设置 > 模型”里随时启动。', 3600, 'info', 'local-qwen-snoozed');
  }, []);

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
    canShowStopped: !!(!active && model && hasModel && hasRuntime && !dismissed),
    canShowInstallPrompt: !!(recommended && (!model || !hasModel || !hasRuntime)),
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
    snoozePrompt,
    setPanelOpen,
  };
}

export type LocalQwenStatusController = ReturnType<typeof useLocalQwenStatusController>;
