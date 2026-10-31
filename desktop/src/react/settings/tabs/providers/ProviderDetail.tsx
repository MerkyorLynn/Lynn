import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { OAuthCredentials } from './OAuthCredentials';
import { ApiKeyCredentials } from './ApiKeyCredentials';
import { ProviderModelList } from './ProviderModelList';
import { useLlamacppState } from '../../../hooks/use-llamacpp-state';
import { LocalModelSetupChoice, getLocalModelTier, localModelCatalog, localModelInstallBytes, requestLocalModelHelp } from '../../../components/input/LocalModelSetupChoice';
import { BRAIN_PROVIDER_ID, BRAIN_PROVIDER_LABEL } from '../../../../../../shared/brain-provider.js';
import styles from '../../Settings.module.css';
import { notifyModelsChanged } from './model-change-events';
import {
  LOCAL_QWEN_PROVIDER_LABEL,
  LOCAL_QWEN_DEFAULT_MODEL_FILE,
  isLocalQwenProviderId,
  formatLocalTps,
  largestLocalGpu,
  normalizeLocalUpgradeOptions,
  localEndpointRoot,
  formatBytes,
  localModelActionErrorText,
  type LocalActionStatus,
  type LocalUpgradeOption,
} from "./ProviderDetail.helpers";

const platform = typeof window !== 'undefined' ? window.platform : undefined;

function formatDownloadEta(seconds?: number | null) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分钟`;
}

export function ProviderDetail({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean; noKey?: boolean; defaultModelId?: string };
  onRefresh: () => Promise<void>;
}) {
  const isLocalQwenProvider = isLocalQwenProviderId(providerId);
  const title = providerId === BRAIN_PROVIDER_ID
    ? BRAIN_PROVIDER_LABEL
    : isLocalQwenProvider
      ? LOCAL_QWEN_PROVIDER_LABEL
    : (summary.display_name || providerId);
  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{title}</h2>
      </div>
      {isLocalQwenProvider && (
        <LocalQwen35Panel onRefresh={onRefresh} />
      )}
      {isLocalQwenProvider ? null : (
        <>
      {summary.supports_oauth ? (
        <OAuthCredentials providerId={providerId} summary={summary} onRefresh={onRefresh} />
      ) : (
        <ApiKeyCredentials
          providerId={providerId}
          summary={summary}
          providerConfig={providerConfig}
          isPresetSetup={isPresetSetup}
          presetInfo={presetInfo}
          onRefresh={onRefresh}
        />
      )}
      <ProviderModelList providerId={providerId} summary={summary} onRefresh={onRefresh} />
      {summary.can_delete && !isPresetSetup && providerId !== BRAIN_PROVIDER_ID && (
        <div className={styles['pv-detail-footer']}>
          <ProviderDeleteButton providerId={providerId} onRefresh={onRefresh} />
        </div>
      )}
        </>
      )}
    </div>
  );
}

type LocalQwen35Status = {
  ok?: boolean;
  registered_provider?: boolean;
  runtime?: {
    gui_url?: string;
    pid?: number | null;
    endpoint_running?: boolean;
    endpoint_running_any?: boolean;
    endpoint_loading?: boolean;
    endpoint_occupied?: boolean;
    serves_default_model?: boolean;
    process_alive?: boolean;
    health_status?: number;
    model_ids?: string[];
    foreign_model_ids?: string[];
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
      requests_total?: number | null;
      predicted_tps?: number | null;
      tps_window_seconds?: number | null;
    } | null;
    metrics_available?: boolean;
    slots?: {
      total?: number;
      busy?: number;
    } | null;
  };
  job?: {
    status?: string;
    log_file?: string;
    result?: unknown;
    stderr_tail?: string;
    progress?: {
      phase?: string;
      source?: string | null;
      percent?: number | null;
      downloaded?: string;
      total?: string;
      elapsed?: string;
      eta?: string;
      speed?: string;
      message?: string;
      tail?: string[];
    } | null;
  } | null;
  plan?: {
    decision?: string;
    base_url?: string;
    hardware?: {
      can_enable?: boolean;
      memory_kind?: 'unified' | 'dedicated';
      accelerator_memory_gib?: number | null;
      recommended_model_id?: string | null;
      recommendation?: string;
      chip?: string | null;
      total_memory_gib?: number | null;
      gpus?: Array<{ name?: string; memory_gib?: number | null; compute_capability?: number | null }>;
      recommended_runtime?: {
        label?: string;
        ctx_size?: number;
        parallel?: number;
        gpu_layers?: number;
      };
      upgrade_options?: LocalUpgradeOption[];
      warnings?: string[];
      blockers?: string[];
    };
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      endpoint_occupied?: boolean;
      served_model_ids?: string[];
      gguf?: string | null;
      legacy_gguf?: string | null;
      needs_model_upgrade?: boolean;
      expected_file_name?: string;
      llama_server?: string | null;
      homebrew_available?: boolean;
    };
    actions?: Array<{ id?: string; label?: string }>;
  };
  error?: string;
};

function LocalQwen35Panel({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const llamaState = useLlamacppState();
  const lastEndpointRefreshKeyRef = useRef<string | null>(null);
  const [status, setStatus] = useState<LocalQwen35Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualTierId, setManualTierId] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [customStarting, setCustomStarting] = useState(false);
  const [showAdvancedLauncher, setShowAdvancedLauncher] = useState(false);
  const [actionStatus, setActionStatus] = useState<LocalActionStatus | null>(null);
  const [upgradeStartingId, setUpgradeStartingId] = useState<string | null>(null);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 60_000 });
      const data = await res.json();
      setStatus(data);
      if (data?.registered_provider && data?.plan?.observed?.endpoint_running) {
        const modelKey = [
          data?.runtime?.pid,
          ...(data?.runtime?.model_ids || data?.plan?.observed?.served_model_ids || []),
        ].filter(Boolean).join(':') || 'default-running';
        if (lastEndpointRefreshKeyRef.current !== modelKey) {
          lastEndpointRefreshKeyRef.current = modelKey;
          notifyModelsChanged();
          void onRefresh();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((prev) => ({
        ...(prev || { ok: false }),
        error: msg.includes('aborted') ? '状态刷新超时，保留上一帧状态并继续后台检查。' : msg,
      }));
      if (!quiet) setActionStatus({ kind: 'error', text: `状态刷新失败：${msg}` });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    loadStatus(true);
  }, [loadStatus]);

  const plan = status?.plan || {};
  const observed = plan.observed || {};
  const hardware = plan.hardware || {};
  const servedModelIds = status?.runtime?.model_ids || observed.served_model_ids || [];
  const runningTierId = localModelCatalog.tiers.find(tier => servedModelIds.includes(tier.modelId))?.modelId;
  const selectedTier = getLocalModelTier(manualTierId || runningTierId || hardware.recommended_model_id);
  const selectedModelId = selectedTier.modelId;
  const runtime = hardware.recommended_runtime || {};
  const gpu = largestLocalGpu(hardware.gpus);
  const endpointDefaultRunning = servedModelIds.includes(selectedModelId);
  const endpointForeign = status?.runtime?.endpoint_occupied === true
    || observed.endpoint_occupied === true
    || ((status?.runtime?.endpoint_running_any === true || status?.runtime?.endpoint_running === true)
      && servedModelIds.length > 0
      && !endpointDefaultRunning);
  const endpointRunning = endpointDefaultRunning && (observed.endpoint_running === true || status?.runtime?.endpoint_running === true);
  const endpointLoading = !endpointForeign && !endpointRunning && (
    observed.endpoint_loading === true
      || status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
  );
  const endpointActive = endpointRunning || endpointLoading;
  const canStopLocalModel = endpointActive || endpointForeign;
  const modelPath = typeof observed.gguf === 'string' ? observed.gguf : '';
  const modelFileName = modelPath ? (modelPath.split(/[\\/]/).pop() || modelPath) : '';
  const legacyModelPath = typeof observed.legacy_gguf === 'string' ? observed.legacy_gguf : '';
  const legacyModelFileName = legacyModelPath ? (legacyModelPath.split(/[\\/]/).pop() || legacyModelPath) : '';
  // 默认卡只认当前 Coder390 Q3/Q2。旧 GGUF 会显示为可升级，不能挡住新版下载。
  const hasModel = !!observed.gguf && modelFileName === selectedTier.fileName.split('/').pop();
  const needsMtpUpgrade = !hasModel && (observed.needs_model_upgrade === true || !!legacyModelPath);
  const hardwareWarnings = [...new Set([
    ...(endpointForeign
      ? [`检测到 18099 当前运行的是 ${servedModelIds.join(', ') || '非默认模型端点'}，它不会作为默认 27B 使用；停止后可启动 Coder390 Q3/Q2。`]
      : []),
    ...(needsMtpUpgrade
      ? [`检测到已安装的旧版 GGUF：${legacyModelFileName || '旧文件'}。默认档已换成 Coder390 Q3/Q2；点击升级会下载新版文件，旧文件不会被删除。`]
      : []),
    ...(hardware.warnings || []),
    ...(hardware.blockers || []),
    ...(hardware.accelerator_memory_gib != null && hardware.accelerator_memory_gib < selectedTier.minimumMemoryGib
      ? [`所选 ${selectedTier.quantization} 不满足容量要求：Q2 至少 14GiB，Q3 需要 24GB 档位；不能安装或启动。`] : []),
  ])];
  const hasRuntime = !endpointForeign && !!(observed.llama_server || llamaState.binaryPath);
  const defaultDownload = llamaState.download;
  useEffect(() => {
    if (!manualTierId && localModelCatalog.tiers.some(tier => tier.modelId === defaultDownload.modelId)
      && ['downloading', 'verifying', 'paused'].includes(defaultDownload.state)) {
      setManualTierId(defaultDownload.modelId!);
    }
  }, [manualTierId, defaultDownload.modelId, defaultDownload.state]);
  const managerStatus = llamaState.status;
  const managerStarting = managerStatus === 'starting' || managerStatus === 'unhealthy';
  const managerFailed = managerStatus === 'failed' || managerStatus === 'crashed';
  const managerFailureReason = managerFailed
    ? [
        llamaState.reason || 'llama.cpp 启动失败',
        llamaState.error || null,
      ].filter(Boolean).join('：')
    : '';
  const defaultDownloadState = String(defaultDownload.state || '');
  const defaultDownloadForDefault = localModelCatalog.tiers.some(tier => tier.modelId === defaultDownload.modelId);
  const defaultDownloadActive = defaultDownloadForDefault
    && (defaultDownloadState === 'downloading' || defaultDownloadState === 'verifying');
  const defaultDownloadCanPause = defaultDownloadForDefault && defaultDownloadState === 'downloading';
  const defaultDownloadPaused = defaultDownloadForDefault && defaultDownloadState === 'paused';
  const defaultDownloadDone = defaultDownloadForDefault && defaultDownloadState === 'done';
  const defaultDownloadError = defaultDownloadForDefault && defaultDownloadState === 'error';
  const defaultDownloadPercent = Math.max(0, Math.min(100, Number(defaultDownload.overallPercent ?? defaultDownload.percent ?? 0)));
  const defaultDownloadTotalBytes = Number(defaultDownload.totalBytes || 0)
    || (defaultDownloadDone ? localModelInstallBytes(selectedTier) : 0);
  const defaultDownloadBytesTransferred = Number(defaultDownload.bytesTransferred || 0)
    || (defaultDownloadDone ? defaultDownloadTotalBytes : 0);
  const defaultDownloadSizeText = [
    formatBytes(defaultDownloadBytesTransferred),
    formatBytes(defaultDownloadTotalBytes),
  ].filter(Boolean);
  const jobRawStatus = status?.job?.status;
  const jobRunning = jobRawStatus === 'running';
  const jobStatusLabel = useMemo(() => {
    if (!jobRawStatus) return null;
    if (endpointRunning && jobRawStatus === 'failed') return '端点已运行';
    if (jobRawStatus === 'succeeded') return '已完成';
    if (jobRawStatus === 'running') return '正在准备';
    if (jobRawStatus === 'failed') return '需要处理';
    return jobRawStatus;
  }, [endpointRunning, jobRawStatus]);
  const showJobStatus = !!jobStatusLabel
    && jobRawStatus !== 'succeeded'
    && !(endpointRunning && jobRawStatus === 'failed');
  const progress = status?.job?.progress || null;
  const upgradeOptions = useMemo(
    () => normalizeLocalUpgradeOptions(hardware.upgrade_options || [], hardware.accelerator_memory_gib),
    [hardware.upgrade_options, hardware.accelerator_memory_gib],
  );
  const progressPercent = typeof progress?.percent === 'number'
    ? Math.max(0, Math.min(100, progress.percent))
    : null;
  const runtimeStats = status?.runtime;
  const runtimeTokens = Math.round(
    Number(runtimeStats?.metrics?.prompt_tokens_total || 0)
      + Number(runtimeStats?.metrics?.predicted_tokens_total || 0),
  );
  const runtimeMetricsReady = runtimeStats?.metrics_available === true;
  const runtimeTpsLabel = formatLocalTps(runtimeStats?.metrics?.predicted_tps);
  const slotLabel = (() => {
    const slots = runtimeStats?.slots;
    if (!slots?.total) return null;
    const busy = slots.busy || 0;
    const idle = Math.max(0, slots.total - busy);
    return busy > 0 ? `生成中 ${busy}/${slots.total}` : `可用 ${idle}/${slots.total}`;
  })();
  const hardwareBlocked = !loading && !!status && !endpointRunning && (hardware.can_enable !== true
    || !Number.isFinite(hardware.accelerator_memory_gib)
    || Number(hardware.accelerator_memory_gib) < selectedTier.minimumMemoryGib);
  const hardwareLabel = runtime.label || (loading || !status ? '正在检查硬件' : '默认使用云端模型');
  const stateLabel = useMemo(() => {
    if (endpointForeign) return '非默认本地端点运行中';
    if (managerFailed) return '启动失败';
    if (jobRunning || managerStarting) return '正在准备';
    if (endpointLoading) return '正在加载';
    if (endpointRunning) return '已运行';
    if (needsMtpUpgrade) return '可升级';
    if (hasModel && hasRuntime) return '可启动';
    return '待安装';
  }, [endpointForeign, endpointLoading, endpointRunning, hasModel, hasRuntime, jobRunning, managerFailed, managerStarting, needsMtpUpgrade]);

  useEffect(() => {
    if (!jobRunning && !managerStarting) return undefined;
    const id = window.setInterval(() => {
      loadStatus(true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [jobRunning, loadStatus, managerStarting]);

  useEffect(() => {
    if (!endpointRunning && !endpointForeign) return undefined;
    const id = window.setInterval(() => {
      loadStatus(true);
    }, 3000);
    return () => window.clearInterval(id);
  }, [endpointForeign, endpointRunning, loadStatus]);

  const authorizeAndSetup = async () => {
    if (hardwareBlocked) {
      setActionStatus({ kind: 'error', text: '显存/统一内存不足或尚未确认，不能安装。Q2 至少 14GiB、推荐 16GB；Q3 需要 24GB 档位。' });
      return;
    }
    const profile = `\n\n本次方案：${selectedTier.label}，上下文 ${selectedTier.contextSize}，并发 1`;
    const warning = hardwareWarnings.length ? `\n\n注意：${hardwareWarnings.join(' ')}` : '';
    const setupText = `将安装 ${selectedTier.label} 与兼容的 llama.cpp。主模型 ${(localModelInstallBytes(selectedTier) / 1e9).toFixed(2)} GB，内置 Q4 MTP，不另下草稿，不含视觉组件。Lynn 会校验文件并尝试启动；实际显存占用还包括缓存与运行缓冲。旧模型不会被删除。`;
    const ok = window.confirm(`${setupText}${profile}${warning}\n\n继续吗？`);
    if (!ok) return;
    if (platform?.llamacppStartDownload) {
      setSettingUp(true);
        setActionStatus({
          kind: 'info',
          text: hasModel
            ? '正在启动本地 Qwen3.8-27B；如果模型文件已完整，Lynn 会直接校验并拉起本地端点。'
            : needsMtpUpgrade
              ? '正在升级到本地 Qwen3.8-27B Coder390；旧版文件会保留，新版校验完成后按本次授权启动。'
              : '正在下载本地 Qwen3.8-27B，进度会留在当前页面；下载完成后按本次授权启动本地端点。',
        });
      try {
        const res = await platform.llamacppStartDownload({
          modelId: selectedModelId,
          startAfterDownload: true,
        });
        if (!res?.ok) throw new Error(localModelActionErrorText(res?.reason, res?.detail));
        showToast(
          res.alreadyRunning
            ? '本地 27B 已在下载/启动队列中。'
            : hasModel
              ? '本地 Qwen3.8-27B 正在启动。'
              : needsMtpUpgrade
                ? '本地 Qwen3.8-27B Coder390 升级已开始。'
                : '本地 Qwen3.8-27B 已开始下载。',
          'info',
        );
        setActionStatus({
          kind: 'info',
          text: res.alreadyRunning
            ? '本地 27B 已在下载/启动队列中，进度会自动刷新。'
            : hasModel
              ? '启动任务已提交。加载完成后会自动切换为本地模型。'
            : needsMtpUpgrade
              ? 'Coder390 Q3/Q2 下载已启动，校验完成后会自动启动本地端点。'
                : '本地 27B 下载已启动，校验完成后会自动启动本地端点。',
        });
        await onRefresh();
        window.setTimeout(loadStatus, 1500);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast('本地 27B 启动失败：' + msg, 'error');
        setActionStatus({ kind: 'error', text: `任务未启动：${msg}` });
      } finally {
        setSettingUp(false);
      }
      return;
    }
    setActionStatus({ kind: 'error', text: '此安装方案需要 Lynn 桌面端的下载器。请打开桌面版，或点击“让 Lynn 帮我部署”。' });
  };

  const snoozeLocalModel = () => {
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    try {
      window.localStorage.setItem('lynn-local-model-snooze-until', String(tomorrow));
    } catch {
      // localStorage may be unavailable in hardened contexts.
    }
    showToast('已暂不启用。本地模型推荐会降频，明天再轻提醒。', 'info');
  };

  const registerOnly = async () => {
    setRegistering(true);
    setActionStatus({ kind: 'info', text: '正在重新注册本地 OpenAI 端点，并刷新模型列表…' });
    try {
      await hanaFetch('/api/local-qwen35-9b/register', { method: 'POST', timeout: 10_000 });
      showToast('本地 Qwen3.8-27B 已注册到模型列表。', 'success');
      setActionStatus({ kind: 'success', text: '已重新注册本地端点，并切换到本地 Qwen3.8-27B。' });
      notifyModelsChanged();
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('注册失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `重新注册失败：${msg}` });
    } finally {
      setRegistering(false);
    }
  };

  const stopLocalModel = async () => {
    const ok = window.confirm('停止本地模型会释放内存，并中断正在使用本地模型的请求。之后可以随时重新启动。继续停止吗？');
    if (!ok) return;
    setStopping(true);
    setActionStatus({ kind: 'info', text: '正在停止本地模型服务…' });
    try {
      const managerStop = await platform?.llamacppStop?.();
      if (managerStop && managerStop.ok === false) {
        throw new Error(managerStop.reason || 'llamacpp_manager_stop_failed');
      }
      const res = await hanaFetch('/api/local-qwen35-9b/stop', { method: 'POST', timeout: 10_000 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'stop_failed');
      showToast('本地模型已停止。', 'success');
      setActionStatus({ kind: 'success', text: '本地模型已停止。需要时可再次启动。' });
      await loadStatus(false);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('停止失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `停止失败：${msg}` });
    } finally {
      setStopping(false);
    }
  };

  const openLocalDashboard = () => {
    const root = localEndpointRoot(plan.base_url);
    const target = endpointRunning ? root : `${root}/v1/models`;
    platform?.openExternal?.(target);
    setActionStatus({ kind: 'info', text: `已打开 llama.cpp 端点：${target}` });
    showToast(`已打开本地端点：${target}`, 'info');
  };

  const startRecommendedDownload = async (option: LocalUpgradeOption) => {
    const modelId = option.id || 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix';
    if (!platform?.llamacppStartDownload) {
      setActionStatus({ kind: 'error', text: '当前运行环境不支持本地模型下载。请使用桌面客户端。' });
      return;
    }
    setUpgradeStartingId(modelId);
    setActionStatus({ kind: 'info', text: `正在准备下载 ${option.label || '推荐模型'}，进度会留在当前页面。` });
    try {
      const res = await platform.llamacppStartDownload({ modelId });
      if (!res?.ok) {
        throw new Error(localModelActionErrorText(res?.reason, res?.detail));
      }
      setActionStatus({
        kind: 'info',
        text: res.alreadyRunning
          ? `${option.label || '推荐模型'} 已在下载队列中。`
          : `${option.label || '推荐模型'} 已开始下载。Lynn 会校验文件，完成后可一键启动。`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('推荐模型下载失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `下载未启动：${msg}` });
    } finally {
      setUpgradeStartingId(null);
    }
  };

  const cancelRecommendedDownload = async (option: LocalUpgradeOption) => {
    try {
      const res = await llamaState.cancelDownload();
      if (!res?.ok) throw new Error('cancel-download-failed');
      setActionStatus({ kind: 'info', text: `已取消 ${option.label || '推荐模型'} 下载。` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('取消下载失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `取消下载失败：${msg}` });
    }
  };

  const toggleRecommendedDownload = async (option: LocalUpgradeOption, paused: boolean) => {
    const modelId = option.id || 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix';
    try {
      const res = paused
        ? await llamaState.startDownload({ modelId })
        : await llamaState.pauseDownload();
      if (!res?.ok) throw new Error(res?.reason || (paused ? 'resume-download-failed' : 'pause-download-failed'));
      setActionStatus({ kind: 'info', text: paused ? '下载已继续，将从已有分片恢复。' : '下载已暂停，已完成的分片会保留。' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`${paused ? '继续' : '暂停'}下载失败：${msg}`, 'error');
    }
  };

  const removeDownloadedModel = async (modelId: string, label: string) => {
    if (!window.confirm(`删除本机的 ${label}？模型文件会被移除，之后可以重新下载。`)) return;
    const res = await llamaState.removeModel({ modelId });
    if (!res?.ok) {
      showToast(`删除失败：${res?.reason || '无法移除模型文件'}`, 'error');
      return;
    }
    setActionStatus({ kind: 'success', text: `已删除 ${label}${res.bytesFreed ? `，释放 ${formatBytes(res.bytesFreed)}` : ''}。` });
    await loadStatus(true);
  };

  const openModelFolder = async () => {
    const res = await platform?.llamacppOpenModelDir?.(modelPath || null);
    setActionStatus({
      kind: res?.ok ? 'success' : 'info',
      text: res?.ok && modelPath
          ? `已在 Finder 中定位当前本地模型：${modelFileName}。完整路径：${res.revealedPath || modelPath}`
        : res?.ok
          ? `已打开本地模型存放目录：${res.path || '~/.lynn/models'}。把 GGUF 放到这里后，可点击“选择本机 GGUF 启动”。`
          : '当前还没有已绑定的模型文件。请把 GGUF 放入本地模型目录，或点击“选择本机 GGUF 启动”选择文件。',
    });
  };

  const startGgufPath = async (modelPath: string) => {
    if (!platform?.llamacppStartCustomModel) {
      setActionStatus({ kind: 'error', text: '当前运行环境不支持原生 GGUF 选择器。请使用桌面客户端。' });
      return;
    }
    const fileName = modelPath.split(/[\\/]/).pop() || 'GGUF 模型';
    setCustomStarting(true);
    try {
      setActionStatus({ kind: 'info', text: `已选择 ${fileName}，正在用 llama.cpp 启动本地模型…` });
      const res = await platform.llamacppStartCustomModel(modelPath);
      if (!res?.ok) {
        throw new Error(localModelActionErrorText(res?.reason, res?.detail));
      }
      showToast(`正在启动 ${fileName}，状态会在此处和聊天栏同步。`, 'success');
      setActionStatus({ kind: 'success', text: `已提交启动：${fileName}。加载完成后会同步到聊天栏，可直接使用本地端点。` });
      window.setTimeout(loadStatus, 1600);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('自选模型启动失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `自选模型启动失败：${msg}` });
    } finally {
      setCustomStarting(false);
    }
  };

  const chooseGgufModel = async () => {
    if (!platform?.selectGgufModel) {
      setActionStatus({ kind: 'error', text: '当前运行环境不支持原生 GGUF 选择器。请使用桌面客户端。' });
      return;
    }
    try {
      const modelPath = await platform.selectGgufModel();
      if (!modelPath) {
        setActionStatus({ kind: 'info', text: '未选择模型。默认 Qwen3.8-27B 仍保持可用。' });
        return;
      }
      await startGgufPath(modelPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('选择模型失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `选择模型失败：${msg}` });
    }
  };

  return (
    <section className={styles['pv-local-qwen-panel']}>
      <LocalModelSetupChoice value={selectedModelId} recommendedId={hardware.recommended_model_id}
        onChange={setManualTierId} disabled={settingUp || defaultDownloadActive || defaultDownloadPaused || managerStarting}
        onHelp={() => { void requestLocalModelHelp(selectedModelId, hardware, actionStatus?.text || defaultDownload.lastError || managerFailureReason).catch(err => showToast(String(err.message), 'error')); }} />
      <div className={styles['pv-local-qwen-main']}>
        <div>
          <div className={styles['pv-local-qwen-kicker']}>24GB 及以上默认 Q3 · 24GB 以下（16GB 档） Q2</div>
          <div className={styles['pv-local-qwen-title']}>{selectedTier.label}</div>
          <div className={styles['pv-local-qwen-desc']}>
            Qwen3.8-27B Coder390 EfficientThink · 内置 Q4 MTP 加速；实际速度取决于硬件及任务。
            Lynn 会在用户授权后自动准备 llama.cpp、模型文件和本地 OpenAI 端点；完成后可离线使用，
            不需要 API Key，不上传对话。此次安装不含视觉组件，也不另下 DFlash2 草稿。
          </div>
        </div>
        <div className={styles['pv-local-qwen-state-stack']}>
          <span className={`${styles['pv-local-qwen-state']} ${endpointActive ? styles['ready'] : ''}`}>
            {loading && !endpointActive ? '检查中' : stateLabel}
          </span>
          {/* 2026-05-24 U1 fix: 移除 header 重复的"下载并启动本地模型"按钮 —
              底栏 action-rail (line 863) 那个有完整 state-aware 文案,header 这里只保留 inline 停止快捷键。*/}
          {canStopLocalModel && (
            <button
              type="button"
              className={`${styles['pv-verify-connection-btn']} ${styles['pv-local-qwen-stop-inline']}`}
              onClick={stopLocalModel}
              disabled={stopping}
            >
              {stopping ? '停止中' : '停止本地模型'}
            </button>
          )}
        </div>
      </div>

      <div className={styles['pv-local-qwen-benefits']}>
        <span>{(localModelInstallBytes(selectedTier) / 1e9).toFixed(2)} GB</span>
        <span>{selectedTier.contextSize / 1024}K 初始上下文</span>
        <span>内置 Q4 MTP</span>
        <span>Lynn imatrix 校准</span>
        <span>评测详见模型卡</span>
        <span>{selectedTier.audience || (selectedTier.memoryGib >= 24 ? '24GB 及以上' : '24GB 以下（16GB 档）')}</span>
        <span>GUI 交互优先</span>
        <span>本地单并发</span>
        <span>忙时 CLI 转 StepFun</span>
        <span>DS-V4 Flash 逃生舱</span>
        <span>无 API Key</span>
        <span>隐私留在本机</span>
      </div>

      <div className={styles['pv-local-qwen-facts']}>
        <span>模型 {hasModel ? '已就绪' : needsMtpUpgrade ? '可安装新版本' : '待下载'}</span>
        {modelFileName && <span title={modelPath}>模型文件 {modelFileName}</span>}
        {needsMtpUpgrade && legacyModelFileName && <span title={legacyModelPath}>旧版模型 {legacyModelFileName}</span>}
        {needsMtpUpgrade && <span>Coder390 Q3/Q2 待下载</span>}
        <span>llama.cpp {hasRuntime ? '已找到' : '待安装'}</span>
        {endpointForeign && <span>当前端点 {servedModelIds.join(', ') || '非默认 27B'}</span>}
        {(endpointActive || endpointForeign) && runtimeStats?.pid && <span>PID {runtimeStats.pid}</span>}
        {endpointForeign && <span>停止后可启用默认 27B</span>}
        {(endpointLoading || managerStarting) && <span>模型权重加载中</span>}
        {managerFailed && <span>llama.cpp 启动失败</span>}
        {endpointRunning && <span>{runtimeTpsLabel ? `当前 ${runtimeTpsLabel}` : '速度等待采样'}</span>}
        {endpointRunning && <span>{runtimeMetricsReady ? `服务累计处理 ${runtimeTokens.toLocaleString()} tokens` : '运行统计同步中'}</span>}
        {endpointRunning && slotLabel && <span>{slotLabel}</span>}
        <span>QoS 单槽:本地忙时跳过 Spark,保护 GUI 前台</span>
        <span>{plan.base_url || 'http://127.0.0.1:18099/v1'}</span>
      </div>

      {(defaultDownloadActive || defaultDownloadPaused || defaultDownloadDone || defaultDownloadError) && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>
              {defaultDownloadState === 'verifying'
                ? '正在校验默认 27B'
                : defaultDownloadPaused
                  ? '默认 27B 下载已暂停'
                : defaultDownloadDone
                  ? '默认 27B 已下载完成'
                  : defaultDownloadError
                    ? `默认 27B 下载失败：${defaultDownload.lastError || '请重试'}`
                    : `${defaultDownload.activeSource || '正在下载默认 27B'}${defaultDownload.parallelSegments && defaultDownload.parallelSegments > 1 ? ` · ${defaultDownload.parallelSegments} 路` : ''}`}
            </span>
            {(defaultDownloadActive || defaultDownloadDone) && <strong>{(defaultDownloadDone ? 100 : defaultDownloadPercent).toFixed(0)}%</strong>}
          </div>
          <div className={styles['pv-local-qwen-progress-track']} aria-label="默认 27B 下载进度">
            <div
              className={styles['pv-local-qwen-progress-bar']}
              style={{ width: `${defaultDownloadDone ? 100 : defaultDownloadPercent}%` }}
            />
          </div>
          <div className={styles['pv-local-qwen-progress-meta']}>
            {defaultDownloadSizeText.length > 0 && (
              <span>{defaultDownloadSizeText.length > 1 ? defaultDownloadSizeText.join(' / ') : defaultDownloadSizeText[0]}</span>
            )}
            {defaultDownload.target && <span title={defaultDownload.target}>{defaultDownload.fileName || LOCAL_QWEN_DEFAULT_MODEL_FILE}</span>}
            {!!defaultDownload.bytesPerSecond && <span>{formatBytes(defaultDownload.bytesPerSecond)}/s</span>}
            {!!defaultDownload.etaSeconds && <span>剩余 {formatDownloadEta(defaultDownload.etaSeconds)}</span>}
            {!!defaultDownload.fileCount && defaultDownload.fileCount > 1 && <span>文件 {defaultDownload.fileIndex || 1}/{defaultDownload.fileCount}</span>}
          </div>
          <div className={styles['pv-local-qwen-upgrade-actions']}>
            {(defaultDownloadCanPause || defaultDownloadPaused) && (
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={() => defaultDownloadPaused
                ? void llamaState.startDownload({ modelId: defaultDownload.modelId || selectedModelId })
                : void llamaState.pauseDownload()}>
                {defaultDownloadPaused ? '继续下载' : '暂停下载'}
              </button>
            )}
            {(defaultDownloadPaused || defaultDownloadDone) && (
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={() => void removeDownloadedModel(defaultDownload.modelId || selectedModelId, '所选本地模型')}>
                删除模型
              </button>
            )}
          </div>
        </div>
      )}

      <div className={styles['pv-local-qwen-hardware']}>
        <div className={styles['pv-local-qwen-hardware-title']}>硬件判断</div>
        <p>Apple Silicon 按系统报告的统一内存判断；Windows/Linux 的 NVIDIA 独显通过 nvidia-smi 读取单卡显存，取最大一张，不叠加多卡，也不把系统内存当作显存。</p>
        <p>16GB 档默认 Q2（13.28GB 文件、4K 初始上下文）；24GB 档及以上默认 Q3（17.30GB 文件、8K 初始上下文）。24GB 显卡允许系统报告值略低于标称值，按至少 23.5GiB 识别。</p>
        <p>低于 14GiB 禁止安装，13GB 容量不足；14～不足 16GiB 仅达 Q2 最低门槛。下载文件大小不等于运行占用，须额外预留上下文 KV 缓存、运行缓冲和系统空间。推荐按总容量判断，不保证当前空闲容量足够。</p>
        <div className={styles['pv-local-qwen-facts']}>
          <span>{hardwareLabel}</span>
          {hardware.chip && <span>{hardware.chip}</span>}
          {gpu?.name && <span>{gpu.name}{gpu.memory_gib ? ` · 单卡显存 ${gpu.memory_gib.toFixed(1)} GiB` : ''}</span>}
          {hardware.accelerator_memory_gib != null && <span>检测结果：{hardware.memory_kind === 'unified' ? '统一内存' : '单卡显存'} {hardware.accelerator_memory_gib.toFixed(1)} GiB</span>}
          {hardware.total_memory_gib && <span>系统内存 {hardware.total_memory_gib.toFixed(1)} GiB{hardware.memory_kind === 'dedicated' ? '（不用于显存分档）' : ''}</span>}
          {runtime.ctx_size && <span>上下文 {runtime.ctx_size}</span>}
          {runtime.parallel && <span>并发 {runtime.parallel}</span>}
        </div>
        {hardwareWarnings.length > 0 && (
          <div className={styles['pv-local-qwen-warning']}>{hardwareWarnings.join(' ')}</div>
        )}
      </div>

      {upgradeOptions.length > 0 && (
        <div className={styles['pv-local-qwen-upgrade']}>
          <div className={styles['pv-local-qwen-hardware-title']}>可选本地模型</div>
          {upgradeOptions.map((option) => {
            const optionId = option.id || 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix';
            const download = llamaState.download;
            const isThisDownload = download.modelId === optionId
              || (!!option.file_name && download.fileName === option.file_name);
            const isDownloading = isThisDownload && download.state === 'downloading';
            const isVerifying = isThisDownload && download.state === 'verifying';
            const isPaused = isThisDownload && download.state === 'paused';
            const isDownloaded = isThisDownload && download.state === 'done' && !!download.target;
            const downloadErrored = isThisDownload && download.state === 'error';
            const downloadPercent = Math.max(0, Math.min(100, Number(download.overallPercent ?? download.percent ?? 0)));
            const downloadedText = formatBytes(download.bytesTransferred);
            const totalText = formatBytes(download.totalBytes);
            return (
              <div key={option.id || option.label} className={styles['pv-local-qwen-upgrade-card']}>
                <div className={styles['pv-local-qwen-upgrade-copy']}>
                  <strong>{option.label || 'Qwen3.6-35B-A3B DSV4Pro Thinking Distill Q5_K_M imatrix'}</strong>
                  {option.profile && <em>{option.profile}</em>}
                  {Array.isArray(option.metrics) && option.metrics.length > 0 && (
                    <div className={styles['pv-local-qwen-upgrade-metrics']}>
                      {option.metrics.map((metric) => (
                        <span key={metric}>{metric}</span>
                      ))}
                    </div>
                  )}
                  <span>{option.reason || '24GB+ 设备可试高能力本地模型。'}</span>
                  {(isDownloading || isVerifying || isPaused || isDownloaded || downloadErrored) && (
                    <div className={styles['pv-local-qwen-upgrade-progress']}>
                      <div className={styles['pv-local-qwen-upgrade-progress-row']}>
                        <span>
                          {download.state === 'verifying'
                            ? '正在校验文件'
                            : isPaused
                              ? '下载已暂停，可从已有分片继续'
                            : isDownloaded
                              ? '下载完成，可启动'
                              : downloadErrored
                                ? `下载失败：${download.lastError || '请重试'}`
                                : `${download.activeSource || '正在下载'}${download.parallelSegments && download.parallelSegments > 1 ? ` · ${download.parallelSegments} 路` : ''}`}
                        </span>
                        {(isDownloading || isVerifying || isDownloaded) && <strong>{downloadPercent.toFixed(0)}%</strong>}
                      </div>
                      <div className={styles['pv-local-qwen-progress-track']} aria-label={`${option.label || '推荐模型'}下载进度`}>
                        <div
                          className={styles['pv-local-qwen-progress-bar']}
                          style={{ width: `${isDownloaded ? 100 : downloadPercent}%` }}
                        />
                      </div>
                      {(downloadedText || totalText) && (
                        <div className={styles['pv-local-qwen-progress-meta']}>
                          <span>{downloadedText || '0 B'}{totalText ? ` / ${totalText}` : ''}</span>
                          {!!download.bytesPerSecond && <span>{formatBytes(download.bytesPerSecond)}/s</span>}
                          {!!download.etaSeconds && <span>剩余 {formatDownloadEta(download.etaSeconds)}</span>}
                          {!!download.fileCount && download.fileCount > 1 && <span>文件 {download.fileIndex || 1}/{download.fileCount}</span>}
                          {download.target && <span title={download.target}>{download.fileName || option.file_name || 'GGUF'}</span>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className={styles['pv-local-qwen-upgrade-actions']}>
                  <button
                    type="button"
                    className={styles['pv-local-qwen-upgrade-download-btn']}
                    onClick={() => isDownloaded && download.target ? startGgufPath(download.target) : startRecommendedDownload(option)}
                    disabled={isDownloading || isVerifying || isPaused || customStarting || upgradeStartingId === optionId}
                  >
                    {isDownloading || isVerifying
                      ? '下载中'
                      : isDownloaded
                        ? (customStarting ? '启动中' : '启动此模型')
                        : upgradeStartingId === optionId
                          ? '准备中'
                          : (option.download_label || '下载到本机')}
                  </button>
                  <button
                    type="button"
                    className={styles['pv-local-qwen-upgrade-action-btn']}
                    onClick={() => isDownloading || isPaused ? toggleRecommendedDownload(option, isPaused) : chooseGgufModel()}
                    disabled={customStarting || isVerifying}
                  >
                    {isVerifying ? '正在校验' : isDownloading ? '暂停下载' : isPaused ? '继续下载' : customStarting ? '启动中' : '导入本机 GGUF'}
                  </button>
                  {(isDownloading || isPaused) && (
                    <button type="button" className={styles['pv-local-qwen-upgrade-action-btn']} onClick={() => cancelRecommendedDownload(option)}>
                      取消
                    </button>
                  )}
                  {(isPaused || isDownloaded) && (
                    <button type="button" className={styles['pv-local-qwen-upgrade-action-btn']} onClick={() => void removeDownloadedModel(optionId, option.label || '本地模型')}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles['pv-local-qwen-advanced']}>
        <button
          type="button"
          className={styles['pv-local-qwen-advanced-toggle']}
          onClick={() => setShowAdvancedLauncher((value) => !value)}
          aria-expanded={showAdvancedLauncher}
        >
          {showAdvancedLauncher ? '收起管理' : '管理本地模型'}
        </button>
        {showAdvancedLauncher && (
          <div className={styles['pv-local-qwen-advanced-panel']}>
            <div>
              <strong>已有 GGUF / 模型目录</strong>
              <span>默认使用 Qwen3.8-27B Coder390。24GB 及以上是 Q3，24GB 以下（16GB 档）是 Q2。也可以导入已经下载好的 GGUF。</span>
              {modelPath && <code className={styles['pv-local-qwen-model-path']}>{modelPath}</code>}
              {needsMtpUpgrade && legacyModelPath && <code className={styles['pv-local-qwen-model-path']}>旧版模型：{legacyModelPath}</code>}
            </div>
            <div className={styles['pv-local-qwen-advanced-actions']}>
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={openModelFolder}>
                {modelPath ? '定位当前模型文件' : '打开模型目录'}
              </button>
              <button
                type="button"
                className={styles['pv-verify-connection-btn']}
                onClick={chooseGgufModel}
                disabled={customStarting}
              >
                {customStarting ? '启动中' : '选择本机 GGUF 启动'}
              </button>
            </div>
          </div>
        )}
      </div>

      {status?.error && (
        <div className={styles['pv-local-qwen-error']}>{status.error}</div>
      )}
      {managerFailed && (
        <div className={styles['pv-local-qwen-error']}>
          本地 Qwen3.8-27B 启动失败：{managerFailureReason || '请重试，或先切回云端模型。'}
        </div>
      )}
      {actionStatus && (
        <div className={`${styles['pv-local-qwen-action-status']} ${styles[`pv-local-qwen-action-status-${actionStatus.kind}`]}`}>
          {actionStatus.text}
        </div>
      )}
      {showJobStatus && (
        <div className={styles['pv-local-qwen-job']}>
          后台任务：{jobStatusLabel}{status?.job?.log_file ? ' · 日志已保存' : ''}
        </div>
      )}
      {jobRunning && progress && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>{progress.phase || '准备本地模型'}</span>
            {progressPercent !== null && <strong>{progressPercent.toFixed(0)}%</strong>}
          </div>
          {progressPercent !== null && (
            <div className={styles['pv-local-qwen-progress-track']} aria-label="本地模型准备进度">
              <div
                className={styles['pv-local-qwen-progress-bar']}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          {(progress.downloaded || progress.total || progress.speed || progress.eta) && (
            <div className={styles['pv-local-qwen-progress-meta']}>
              {progress.downloaded && progress.total && <span>{progress.downloaded} / {progress.total}</span>}
              {progress.speed && <span>{progress.speed}</span>}
              {progress.eta && <span>剩余 {progress.eta}</span>}
            </div>
          )}
          {progress.tail && progress.tail.length > 0 && (
            <div className={styles['pv-local-qwen-progress-tail']}>
              {progress.tail.slice(-3).map((line, idx) => (
                <div key={`${idx}-${line}`}>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles['pv-local-qwen-actions']}>
        <button
          className={`${styles['pv-setup-activate-btn']} ${styles['pv-local-qwen-primary']}`}
          onClick={endpointActive ? () => loadStatus(false) : authorizeAndSetup}
          disabled={settingUp || loading || !status || jobRunning || hardwareBlocked || endpointLoading || managerStarting || defaultDownloadActive}
        >
          {hardwareBlocked
            ? '容量不足或未确认，不能安装'
            : defaultDownloadActive
              ? `下载中 ${defaultDownloadPercent.toFixed(0)}%`
            : endpointLoading || managerStarting
              ? '模型加载中'
              : endpointRunning
                ? '已启用，重新检查'
                : hasModel && hasRuntime
                  ? '启动本地模型'
                  : needsMtpUpgrade
                    ? `安装 ${selectedTier.quantization}`
                  : !hasModel
                    ? `安装 ${selectedTier.quantization} 并启动`
                    : '授权安装并启用'}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={() => loadStatus(false)} disabled={loading}>
          {loading ? '刷新中' : '刷新状态'}
        </button>
        {endpointRunning && <button className={styles['pv-verify-connection-btn']} onClick={openLocalDashboard}>
          查看端点
        </button>}
        {canStopLocalModel && (
          <button className={styles['pv-verify-connection-btn']} onClick={stopLocalModel} disabled={stopping}>
            {stopping ? '停止中' : '停止本地模型'}
          </button>
        )}
        <button className={styles['pv-verify-connection-btn']} onClick={registerOnly} disabled={registering}>
          {registering ? '注册中' : '重新注册本地端点'}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={snoozeLocalModel}>
          暂不启用
        </button>
      </div>
    </section>
  );
}

function ProviderDeleteButton({ providerId, onRefresh }: { providerId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = async () => {
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: null } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.deleted', { name: providerId }), 'success');
      useSettingsStore.setState({ selectedProviderId: null });
      setConfirming(false);
      await onRefresh();
      notifyModelsChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <>
      <button className={styles['pv-delete-btn']} onClick={() => setConfirming(true)}>
        {t('settings.providers.delete')}
      </button>
      {confirming && (
        <>
          <div className={styles['pv-model-edit-overlay']} onClick={() => setConfirming(false)} />
          <div className={styles['pv-confirm-dialog']}>
            <p className={styles['pv-confirm-text']}>
              {t('settings.providers.deleteConfirm', { name: providerId })}
            </p>
            <div className={styles['pv-confirm-actions']}>
              <button className={styles['pv-add-form-btn']} onClick={() => setConfirming(false)}>{t('settings.api.cancel')}</button>
              <button className={`${styles['pv-add-form-btn']} ${styles['danger']}`} onClick={handleDelete}>{t('settings.providers.delete')}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
