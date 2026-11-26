import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { isChineseLocale } from '../../../utils/locale';
import { OAuthCredentials } from './OAuthCredentials';
import { ApiKeyCredentials } from './ApiKeyCredentials';
import { ProviderModelList } from './ProviderModelList';
import { useLlamacppState } from '../../../hooks/use-llamacpp-state';
import { LocalModelSetupChoice, getLocalModelTier, localModelCatalog, localModelInstallBytes, requestLocalModelHelp } from '../../../components/input/LocalModelSetupChoice';
import { BRAIN_PROVIDER_ID, BRAIN_PROVIDER_LABEL } from '../../../../../../shared/brain-provider.js';
import styles from '../../Settings.module.css';
import { notifyModelsChanged } from './model-change-events';
import {
  localQwenProviderLabel,
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

function formatDownloadEta(seconds?: number | null, zh = isChineseLocale()) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return zh ? `${Math.ceil(seconds)} 秒` : `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return zh ? `${Math.ceil(seconds / 60)} 分钟` : `${Math.ceil(seconds / 60)} min`;
  return zh
    ? `${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分钟`
    : `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)} min`;
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
      ? localQwenProviderLabel()
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
  // D() picks between the inline Chinese/English pair for the active UI locale.
  // The local-model panel ships long-form copy that is intentionally kept next
  // to the code, so it goes through this helper instead of the JSON packs.
  const D = useCallback((zh: string, en: string) => (isChineseLocale() ? zh : en), []);
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
        error: msg.includes('aborted') ? D('状态刷新超时，保留上一帧状态并继续后台检查。', 'Status refresh timed out. Keeping the last known state and retrying in the background.') : msg,
      }));
      if (!quiet) setActionStatus({ kind: 'error', text: `${D('状态刷新失败：', 'Status refresh failed: ')}${msg}` });
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
      ? [D(
        `检测到 18099 当前运行的是 ${servedModelIds.join(', ') || '非默认模型端点'}，它不会作为默认 27B 使用；停止后可启动 Coder390 Q3/Q2。`,
        `Port 18099 is currently serving ${servedModelIds.join(', ') || 'a non-default model endpoint'}, which is not used as the default 27B. Stop it first to start Coder390 Q3/Q2.`,
      )]
      : []),
    ...(needsMtpUpgrade
      ? [D(
        `检测到已安装的旧版 GGUF：${legacyModelFileName || '旧文件'}。默认档已换成 Coder390 Q3/Q2；点击升级会下载新版文件，旧文件不会被删除。`,
        `Found an older installed GGUF: ${legacyModelFileName || 'old file'}. The default tier is now Coder390 Q3/Q2; upgrading downloads the new files and keeps the old ones.`,
      )]
      : []),
    ...(hardware.warnings || []),
    ...(hardware.blockers || []),
    ...(hardware.accelerator_memory_gib != null && hardware.accelerator_memory_gib < selectedTier.minimumMemoryGib
      ? [D(
        `所选 ${selectedTier.quantization} 不满足容量要求：Q2 至少 14GiB，Q3 需要 24GB 档位；不能安装或启动。`,
        `Selected ${selectedTier.quantization} does not meet the memory requirement: Q2 needs at least 14GiB, Q3 needs a 24GB tier. It cannot be installed or started.`,
      )] : []),
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
        llamaState.reason || D('llama.cpp 启动失败', 'llama.cpp failed to start'),
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
    if (endpointRunning && jobRawStatus === 'failed') return D('端点已运行', 'Endpoint is running');
    if (jobRawStatus === 'succeeded') return D('已完成', 'Finished');
    if (jobRawStatus === 'running') return D('正在准备', 'Preparing');
    if (jobRawStatus === 'failed') return D('需要处理', 'Needs attention');
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
    return busy > 0 ? D(`生成中 ${busy}/${slots.total}`, `Generating ${busy}/${slots.total}`) : D(`可用 ${idle}/${slots.total}`, `Available ${idle}/${slots.total}`);
  })();
  const hardwareBlocked = !loading && !!status && !endpointRunning && (hardware.can_enable !== true
    || !Number.isFinite(hardware.accelerator_memory_gib)
    || Number(hardware.accelerator_memory_gib) < selectedTier.minimumMemoryGib);
  const hardwareLabel = runtime.label || (loading || !status ? D('正在检查硬件', 'Checking hardware') : D('默认使用云端模型', 'Using the cloud model by default'));
  const stateLabel = useMemo(() => {
    if (endpointForeign) return D('非默认本地端点运行中', 'A non-default local endpoint is running');
    if (managerFailed) return D('启动失败', 'Start failed');
    if (jobRunning || managerStarting) return D('正在准备', 'Preparing');
    if (endpointLoading) return D('正在加载', 'Loading');
    if (endpointRunning) return D('已运行', 'Running');
    if (needsMtpUpgrade) return D('可升级', 'Upgrade available');
    if (hasModel && hasRuntime) return D('可启动', 'Ready to start');
    return D('待安装', 'Not installed');
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
      setActionStatus({ kind: 'error', text: D('显存/统一内存不足或尚未确认，不能安装。Q2 至少 14GiB、推荐 16GB；Q3 需要 24GB 档位。', 'VRAM / unified memory is insufficient or unconfirmed, so installation is blocked. Q2 needs at least 14GiB (16GB recommended); Q3 needs a 24GB tier.') });
      return;
    }
    const profile = D(
      `\n\n本次方案：${selectedTier.label}，上下文 ${selectedTier.contextSize}，并发 1`,
      `\n\nThis setup: ${selectedTier.label}, context ${selectedTier.contextSize}, concurrency 1`,
    );
    const warning = hardwareWarnings.length ? D(`\n\n注意：${hardwareWarnings.join(' ')}`, `\n\nNote: ${hardwareWarnings.join(' ')}`) : '';
    const setupText = D(
      `将安装 ${selectedTier.label} 与兼容的 llama.cpp。主模型 ${(localModelInstallBytes(selectedTier) / 1e9).toFixed(2)} GB，内置 Q4 MTP，不另下草稿，不含视觉组件。Lynn 会校验文件并尝试启动；实际显存占用还包括缓存与运行缓冲。旧模型不会被删除。`,
      `This will install ${selectedTier.label} and a compatible llama.cpp. The main model is ${(localModelInstallBytes(selectedTier) / 1e9).toFixed(2)} GB, with built-in Q4 MTP, no separate draft model, and no vision component. Lynn verifies the files and tries to start it; real VRAM usage also includes cache and runtime buffers. Older models are kept.`,
    );
    const ok = window.confirm(`${setupText}${profile}${warning}${D('\n\n继续吗？', '\n\nContinue?')}`);
    if (!ok) return;
    if (platform?.llamacppStartDownload) {
      setSettingUp(true);
        setActionStatus({
          kind: 'info',
          text: hasModel
            ? D('正在启动本地 Qwen3.8-27B；如果模型文件已完整，Lynn 会直接校验并拉起本地端点。', 'Starting local Qwen3.8-27B; if the model files are complete, Lynn verifies them and brings the local endpoint up directly.')
            : needsMtpUpgrade
              ? D('正在升级到本地 Qwen3.8-27B Coder390；旧版文件会保留，新版校验完成后按本次授权启动。', 'Upgrading to local Qwen3.8-27B Coder390; the older files are kept and the new version starts once verification passes.')
              : D('正在下载本地 Qwen3.8-27B，进度会留在当前页面；下载完成后按本次授权启动本地端点。', 'Downloading local Qwen3.8-27B; progress stays on this page and the local endpoint starts once the download finishes.'),
        });
      try {
        const res = await platform.llamacppStartDownload({
          modelId: selectedModelId,
          startAfterDownload: true,
        });
        if (!res?.ok) throw new Error(localModelActionErrorText(res?.reason, res?.detail));
        showToast(
          res.alreadyRunning
            ? D('本地 27B 已在下载/启动队列中。', 'Local 27B is already queued for download/start.')
            : hasModel
              ? D('本地 Qwen3.8-27B 正在启动。', 'Local Qwen3.8-27B is starting.')
              : needsMtpUpgrade
                ? D('本地 Qwen3.8-27B Coder390 升级已开始。', 'Local Qwen3.8-27B Coder390 upgrade started.')
                : D('本地 Qwen3.8-27B 已开始下载。', 'Local Qwen3.8-27B download started.'),
          'info',
        );
        setActionStatus({
          kind: 'info',
          text: res.alreadyRunning
            ? D('本地 27B 已在下载/启动队列中，进度会自动刷新。', 'Local 27B is queued for download/start; progress refreshes automatically.')
            : hasModel
              ? D('启动任务已提交。加载完成后会自动切换为本地模型。', 'Start task submitted. It switches to the local model once loading completes.')
            : needsMtpUpgrade
              ? D('Coder390 Q3/Q2 下载已启动，校验完成后会自动启动本地端点。', 'Coder390 Q3/Q2 download started; the local endpoint starts automatically after verification.')
                : D('本地 27B 下载已启动，校验完成后会自动启动本地端点。', 'Local 27B download started; the local endpoint starts automatically after verification.'),
        });
        await onRefresh();
        window.setTimeout(loadStatus, 1500);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(D('本地 27B 启动失败：', 'Local 27B failed to start: ') + msg, 'error');
        setActionStatus({ kind: 'error', text: `${D('任务未启动：', 'Task did not start: ')}${msg}` });
      } finally {
        setSettingUp(false);
      }
      return;
    }
    setActionStatus({ kind: 'error', text: D('此安装方案需要 Lynn 桌面端的下载器。请打开桌面版，或点击“让 Lynn 帮我部署”。', 'This installation needs the Lynn desktop downloader. Open the desktop app, or use "let Lynn set it up".') });
  };

  const snoozeLocalModel = () => {
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    try {
      window.localStorage.setItem('lynn-local-model-snooze-until', String(tomorrow));
    } catch {
      // localStorage may be unavailable in hardened contexts.
    }
    showToast(D('已暂不启用。本地模型推荐会降频，明天再轻提醒。', 'Not now. Local model recommendations are dialled down and will nudge again tomorrow.'), 'info');
  };

  const registerOnly = async () => {
    setRegistering(true);
    setActionStatus({ kind: 'info', text: D('正在重新注册本地 OpenAI 端点，并刷新模型列表…', 'Re-registering the local OpenAI endpoint and refreshing the model list…') });
    try {
      await hanaFetch('/api/local-qwen35-9b/register', { method: 'POST', timeout: 10_000 });
      showToast(D('本地 Qwen3.8-27B 已注册到模型列表。', 'Local Qwen3.8-27B registered in the model list.'), 'success');
      setActionStatus({ kind: 'success', text: D('已重新注册本地端点，并切换到本地 Qwen3.8-27B。', 'Local endpoint re-registered and switched to local Qwen3.8-27B.') });
      notifyModelsChanged();
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('注册失败：', 'Registration failed: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('重新注册失败：', 'Re-registration failed: ')}${msg}` });
    } finally {
      setRegistering(false);
    }
  };

  const stopLocalModel = async () => {
    const ok = window.confirm(D('停止本地模型会释放内存，并中断正在使用本地模型的请求。之后可以随时重新启动。继续停止吗？', 'Stopping the local model frees memory and interrupts requests currently using it. You can restart it any time. Stop it now?'));
    if (!ok) return;
    setStopping(true);
    setActionStatus({ kind: 'info', text: D('正在停止本地模型服务…', 'Stopping the local model service…') });
    try {
      const managerStop = await platform?.llamacppStop?.();
      if (managerStop && managerStop.ok === false) {
        throw new Error(managerStop.reason || D('llamacpp_manager_stop_failed', 'llamacpp_manager_stop_failed'));
      }
      const res = await hanaFetch('/api/local-qwen35-9b/stop', { method: 'POST', timeout: 10_000 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'stop_failed');
      showToast(D('本地模型已停止。', 'Local model stopped.'), 'success');
      setActionStatus({ kind: 'success', text: D('本地模型已停止。需要时可再次启动。', 'Local model stopped. You can start it again whenever you need it.') });
      await loadStatus(false);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('停止失败：', 'Stop failed: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('停止失败：', 'Stop failed: ')}${msg}` });
    } finally {
      setStopping(false);
    }
  };

  const openLocalDashboard = () => {
    const root = localEndpointRoot(plan.base_url);
    const target = endpointRunning ? root : `${root}/v1/models`;
    platform?.openExternal?.(target);
    setActionStatus({ kind: 'info', text: `${D('已打开 llama.cpp 端点：', 'Opened the llama.cpp endpoint: ')}${target}` });
    showToast(`${D('已打开本地端点：', 'Opened the local endpoint: ')}${target}`, 'info');
  };

  const startRecommendedDownload = async (option: LocalUpgradeOption) => {
    const modelId = option.id || 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix';
    if (!platform?.llamacppStartDownload) {
      setActionStatus({ kind: 'error', text: D('当前运行环境不支持本地模型下载。请使用桌面客户端。', 'This environment cannot download local models. Please use the desktop client.') });
      return;
    }
    setUpgradeStartingId(modelId);
    setActionStatus({ kind: 'info', text: D(
        `正在准备下载 ${option.label || '推荐模型'}，进度会留在当前页面。`,
        `Preparing to download ${option.label || 'recommended model'}; progress stays on this page.`,
      ) });
    try {
      const res = await platform.llamacppStartDownload({ modelId });
      if (!res?.ok) {
        throw new Error(localModelActionErrorText(res?.reason, res?.detail));
      }
      setActionStatus({
        kind: 'info',
        text: res.alreadyRunning
          ? D(
            `${option.label || '推荐模型'} 已在下载队列中。`,
            `${option.label || 'recommended model'} is already in the download queue.`,
          )
          : D(
            `${option.label || '推荐模型'} 已开始下载。Lynn 会校验文件，完成后可一键启动。`,
            `${option.label || 'recommended model'} download started. Lynn verifies the files and you can start it with one click afterwards.`,
          ),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('推荐模型下载失败：', 'Recommended model download failed: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('下载未启动：', 'Download did not start: ')}${msg}` });
    } finally {
      setUpgradeStartingId(null);
    }
  };

  const cancelRecommendedDownload = async (option: LocalUpgradeOption) => {
    try {
      const res = await llamaState.cancelDownload();
      if (!res?.ok) throw new Error('cancel-download-failed');
      setActionStatus({ kind: 'info', text: D(
        `已取消 ${option.label || '推荐模型'} 下载。`,
        `Cancelled the ${option.label || 'recommended model'} download.`,
      ) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('取消下载失败：', 'Cancel download failed: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('取消下载失败：', 'Cancel download failed: ')}${msg}` });
    }
  };

  const toggleRecommendedDownload = async (option: LocalUpgradeOption, paused: boolean) => {
    const modelId = option.id || 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix';
    try {
      const res = paused
        ? await llamaState.startDownload({ modelId })
        : await llamaState.pauseDownload();
      if (!res?.ok) throw new Error(res?.reason || (paused ? 'resume-download-failed' : 'pause-download-failed'));
      setActionStatus({ kind: 'info', text: paused ? D('下载已继续，将从已有分片恢复。', 'Download resumed and continues from existing chunks.') : D('下载已暂停，已完成的分片会保留。', 'Download paused; completed chunks are kept.') });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`${paused ? D('继续', 'Resume') : D('暂停', 'Pause')}${D('下载失败：', ' download failed: ')}${msg}`, 'error');
    }
  };

  const removeDownloadedModel = async (modelId: string, label: string) => {
    if (!window.confirm(D(
      `删除本机的 ${label}？模型文件会被移除，之后可以重新下载。`,
      `Delete ${label} from this machine? The model files are removed and can be downloaded again later.`,
    ))) return;
    const res = await llamaState.removeModel({ modelId });
    if (!res?.ok) {
      showToast(`${D('删除失败：', 'Delete failed: ')}${res?.reason || D('无法移除模型文件', 'Could not remove the model files')}`, 'error');
      return;
    }
    setActionStatus({ kind: 'success', text: D(
        `已删除 ${label}${res.bytesFreed ? `，释放 ${formatBytes(res.bytesFreed)}` : ''}。`,
        `Deleted ${label}${res.bytesFreed ? `, freed ${formatBytes(res.bytesFreed)}` : ''}.`,
      ) });
    await loadStatus(true);
  };

  const openModelFolder = async () => {
    const res = await platform?.llamacppOpenModelDir?.(modelPath || null);
    setActionStatus({
      kind: res?.ok ? 'success' : 'info',
      text: res?.ok && modelPath
          ? D(
          `已在 Finder 中定位当前本地模型：${modelFileName}。完整路径：${res.revealedPath || modelPath}`,
          `Revealed the current local model in Finder: ${modelFileName}. Full path: ${res.revealedPath || modelPath}`,
        )
        : res?.ok
          ? D(
            `已打开本地模型存放目录：${res.path || '~/.lynn/models'}。把 GGUF 放到这里后，可点击“选择本机 GGUF 启动”。`,
            `Opened the local model folder: ${res.path || '~/.lynn/models'}. Put a GGUF here, then use "Choose a local GGUF to start".`,
          )
          : D('当前还没有已绑定的模型文件。请把 GGUF 放入本地模型目录，或点击“选择本机 GGUF 启动”选择文件。', 'No model file is bound yet. Put a GGUF in the local model folder, or use "Choose a local GGUF to start".'),
    });
  };

  const startGgufPath = async (modelPath: string) => {
    if (!platform?.llamacppStartCustomModel) {
      setActionStatus({ kind: 'error', text: D('当前运行环境不支持原生 GGUF 选择器。请使用桌面客户端。', 'This environment cannot open the native GGUF picker. Please use the desktop client.') });
      return;
    }
    const fileName = modelPath.split(/[\\/]/).pop() || D('GGUF 模型', 'GGUF model');
    setCustomStarting(true);
    try {
      setActionStatus({ kind: 'info', text: D(
        `已选择 ${fileName}，正在用 llama.cpp 启动本地模型…`,
        `Selected ${fileName}, starting the local model with llama.cpp…`,
      ) });
      const res = await platform.llamacppStartCustomModel(modelPath);
      if (!res?.ok) {
        throw new Error(localModelActionErrorText(res?.reason, res?.detail));
      }
      showToast(D(
        `正在启动 ${fileName}，状态会在此处和聊天栏同步。`,
        `Starting ${fileName}; status syncs here and in the chat bar.`,
      ), 'success');
      setActionStatus({ kind: 'success', text: D(
        `已提交启动：${fileName}。加载完成后会同步到聊天栏，可直接使用本地端点。`,
        `Start submitted: ${fileName}. Once loaded it syncs to the chat bar and the local endpoint is ready to use.`,
      ) });
      window.setTimeout(loadStatus, 1600);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('自选模型启动失败：', 'Custom model failed to start: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('自选模型启动失败：', 'Custom model failed to start: ')}${msg}` });
    } finally {
      setCustomStarting(false);
    }
  };

  const chooseGgufModel = async () => {
    if (!platform?.selectGgufModel) {
      setActionStatus({ kind: 'error', text: D('当前运行环境不支持原生 GGUF 选择器。请使用桌面客户端。', 'This environment cannot open the native GGUF picker. Please use the desktop client.') });
      return;
    }
    try {
      const modelPath = await platform.selectGgufModel();
      if (!modelPath) {
        setActionStatus({ kind: 'info', text: D('未选择模型。默认 Qwen3.8-27B 仍保持可用。', 'No model selected. The default Qwen3.8-27B stays available.') });
        return;
      }
      await startGgufPath(modelPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(D('选择模型失败：', 'Model selection failed: ') + msg, 'error');
      setActionStatus({ kind: 'error', text: `${D('选择模型失败：', 'Model selection failed: ')}${msg}` });
    }
  };

  return (
    <section className={styles['pv-local-qwen-panel']}>
      <LocalModelSetupChoice value={selectedModelId} recommendedId={hardware.recommended_model_id}
        onChange={setManualTierId} disabled={settingUp || defaultDownloadActive || defaultDownloadPaused || managerStarting}
        onHelp={() => { void requestLocalModelHelp(selectedModelId, hardware, actionStatus?.text || defaultDownload.lastError || managerFailureReason).catch(err => showToast(String(err.message), 'error')); }} />
      <div className={styles['pv-local-qwen-main']}>
        <div>
          <div className={styles['pv-local-qwen-kicker']}>
            {D('24GB 及以上默认 Q3 · 24GB 以下（16GB 档） Q2', '24GB and above defaults to Q3 · below 24GB (16GB tier) uses Q2')}
          </div>
          <div className={styles['pv-local-qwen-title']}>{selectedTier.label}</div>
          <div className={styles['pv-local-qwen-desc']}>
            {D(
              'Qwen3.8-27B Coder390 EfficientThink · 内置 Q4 MTP 加速；实际速度取决于硬件及任务。Lynn 会在用户授权后自动准备 llama.cpp、模型文件和本地 OpenAI 端点；完成后可离线使用，不需要 API Key，不上传对话。此次安装不含视觉组件，也不另下 DFlash2 草稿。',
              'Qwen3.8-27B Coder390 EfficientThink · built-in Q4 MTP acceleration; actual speed depends on hardware and workload. With your approval Lynn prepares llama.cpp, the model files and a local OpenAI endpoint; once done it works offline, needs no API key and never uploads your chats. This install has no vision component and no separate DFlash2 draft model.',
            )}
          </div>
        </div>
        <div className={styles['pv-local-qwen-state-stack']}>
          <span className={`${styles['pv-local-qwen-state']} ${endpointActive ? styles['ready'] : ''}`}>
            {loading && !endpointActive ? D('检查中', 'Checking') : stateLabel}
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
              {stopping ? D('停止中', 'Stopping') : D('停止本地模型', 'Stop local model')}
            </button>
          )}
        </div>
      </div>

      <div className={styles['pv-local-qwen-benefits']}>
        <span>{(localModelInstallBytes(selectedTier) / 1e9).toFixed(2)} GB</span>
        <span>{`${selectedTier.contextSize / 1024}K `}{D('初始上下文', 'initial context')}</span>
        <span>{D('内置 Q4 MTP', 'Built-in Q4 MTP')}</span>
        <span>{D('Lynn imatrix 校准', 'Lynn imatrix calibrated')}</span>
        <span>{D('评测详见模型卡', 'See the model card for benchmarks')}</span>
        <span>{selectedTier.audience || (selectedTier.memoryGib >= 24 ? D('24GB 及以上', '24GB and above') : D('24GB 以下（16GB 档）', 'Below 24GB (16GB tier)'))}</span>
        <span>{D('GUI 交互优先', 'GUI interaction first')}</span>
        <span>{D('本地单并发', 'Local single-concurrency')}</span>
        <span>{D('忙时 CLI 转 StepFun', 'CLI falls back to StepFun when busy')}</span>
        <span>{D('DS-V4 Flash 逃生舱', 'DS-V4 Flash escape hatch')}</span>
        <span>{D('无 API Key', 'No API key')}</span>
        <span>{D('隐私留在本机', 'Privacy stays on this device')}</span>
      </div>

      <div className={styles['pv-local-qwen-facts']}>
        <span>{D('模型 ', 'Model ')}{hasModel ? D('已就绪', 'ready') : needsMtpUpgrade ? D('可安装新版本', 'new version available') : D('待下载', 'download pending')}</span>
        {modelFileName && <span title={modelPath}>{D('模型文件 ', 'Model file ')}{modelFileName}</span>}
        {needsMtpUpgrade && legacyModelFileName && <span title={legacyModelPath}>{D('旧版模型 ', 'Older model ')}{legacyModelFileName}</span>}
        {needsMtpUpgrade && <span>{D('Coder390 Q3/Q2 待下载', 'Coder390 Q3/Q2 download pending')}</span>}
        <span>llama.cpp {hasRuntime ? D('已找到', 'found') : D('待安装', 'not installed')}</span>
        {endpointForeign && <span>{D('当前端点 ', 'Current endpoint ')}{servedModelIds.join(', ') || D('非默认 27B', 'non-default 27B')}</span>}
        {(endpointActive || endpointForeign) && runtimeStats?.pid && <span>PID {runtimeStats.pid}</span>}
        {endpointForeign && <span>{D('停止后可启用默认 27B', 'Stop it to enable the default 27B')}</span>}
        {(endpointLoading || managerStarting) && <span>{D('模型权重加载中', 'Loading model weights')}</span>}
        {managerFailed && <span>{D('llama.cpp 启动失败', 'llama.cpp failed to start')}</span>}
        {endpointRunning && <span>{runtimeTpsLabel ? `${D('当前 ', 'Current ')}${runtimeTpsLabel}` : D('速度等待采样', 'Waiting for a speed sample')}</span>}
        {endpointRunning && <span>{runtimeMetricsReady ? `${D('服务累计处理 ', 'Served ')}${runtimeTokens.toLocaleString()}${D(' tokens', ' tokens so far')}` : D('运行统计同步中', 'Syncing runtime stats')}</span>}
        {endpointRunning && slotLabel && <span>{slotLabel}</span>}
        <span>{D('QoS 单槽:本地忙时跳过 Spark,保护 GUI 前台', 'QoS single slot: skips Spark when local is busy to protect the GUI foreground')}</span>
        <span>{plan.base_url || 'http://127.0.0.1:18099/v1'}</span>
      </div>

      {(defaultDownloadActive || defaultDownloadPaused || defaultDownloadDone || defaultDownloadError) && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>
              {defaultDownloadState === 'verifying'
                ? D('正在校验默认 27B', 'Verifying the default 27B')
                : defaultDownloadPaused
                  ? D('默认 27B 下载已暂停', 'Default 27B download paused')
                : defaultDownloadDone
                  ? D('默认 27B 已下载完成', 'Default 27B download complete')
                  : defaultDownloadError
                    ? `默认 27B 下载失败：${defaultDownload.lastError || D('请重试', 'please retry')}`
                    : `${defaultDownload.activeSource || D('正在下载默认 27B', 'Downloading the default 27B')}${defaultDownload.parallelSegments && defaultDownload.parallelSegments > 1 ? ` · ${defaultDownload.parallelSegments}${D(' 路', ' connections')}` : ''}`}
            </span>
            {(defaultDownloadActive || defaultDownloadDone) && <strong>{(defaultDownloadDone ? 100 : defaultDownloadPercent).toFixed(0)}%</strong>}
          </div>
          <div className={styles['pv-local-qwen-progress-track']} aria-label={D('默认 27B 下载进度', 'Default 27B download progress')}>
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
            {!!defaultDownload.etaSeconds && <span>{D('剩余 ', 'Remaining ')}{formatDownloadEta(defaultDownload.etaSeconds)}</span>}
            {!!defaultDownload.fileCount && defaultDownload.fileCount > 1 && <span>{D('文件 ', 'File ')}{defaultDownload.fileIndex || 1}/{defaultDownload.fileCount}</span>}
          </div>
          <div className={styles['pv-local-qwen-upgrade-actions']}>
            {(defaultDownloadCanPause || defaultDownloadPaused) && (
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={() => defaultDownloadPaused
                ? void llamaState.startDownload({ modelId: defaultDownload.modelId || selectedModelId })
                : void llamaState.pauseDownload()}>
                {defaultDownloadPaused ? D('继续下载', 'Resume download') : D('暂停下载', 'Pause download')}
              </button>
            )}
            {(defaultDownloadPaused || defaultDownloadDone) && (
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={() => void removeDownloadedModel(defaultDownload.modelId || selectedModelId, D('所选本地模型', 'the selected local model'))}>
                {D('删除模型', 'Delete model')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className={styles['pv-local-qwen-hardware']}>
        <div className={styles['pv-local-qwen-hardware-title']}>{D('硬件判断', 'Hardware detection')}</div>
        <p>
          {D(
            'Apple Silicon 按系统报告的统一内存判断；Windows/Linux 的 NVIDIA 独显通过 nvidia-smi 读取单卡显存，取最大一张，不叠加多卡，也不把系统内存当作显存。',
            'Apple Silicon is judged by the unified memory the system reports; on Windows/Linux the NVIDIA GPU reads per-card VRAM via nvidia-smi and takes the largest card, never summing multiple cards or counting system RAM as VRAM.',
          )}
        </p>
        <p>
          {D(
            '16GB 档默认 Q2（13.28GB 文件、4K 初始上下文）；24GB 档及以上默认 Q3（17.30GB 文件、8K 初始上下文）。24GB 显卡允许系统报告值略低于标称值，按至少 23.5GiB 识别。',
            'The 16GB tier defaults to Q2 (13.28GB file, 4K starting context); 24GB and above defaults to Q3 (17.30GB file, 8K starting context). A 24GB card may report slightly less than nominal and is recognised at 23.5GiB or above.',
          )}
        </p>
        <p>
          {D(
            '低于 14GiB 禁止安装，13GB 容量不足；14～不足 16GiB 仅达 Q2 最低门槛。下载文件大小不等于运行占用，须额外预留上下文 KV 缓存、运行缓冲和系统空间。推荐按总容量判断，不保证当前空闲容量足够。',
            'Under 14GiB installation is blocked because 13GB is too small; 14GiB up to under 16GiB only meets Q2 minimum. Download size is not runtime footprint — leave room for the context KV cache, runtime buffers and system space. Sizing is based on total capacity, so current free memory is not guaranteed to be enough.',
          )}
        </p>
        <div className={styles['pv-local-qwen-facts']}>
          <span>{hardwareLabel}</span>
          {hardware.chip && <span>{hardware.chip}</span>}
          {gpu?.name && <span>{gpu.name}{gpu.memory_gib ? `${D(' · 单卡显存 ', ' · per-card VRAM ')}${gpu.memory_gib.toFixed(1)} GiB` : ''}</span>}
          {hardware.accelerator_memory_gib != null && <span>{D('检测结果：', 'Detected: ')}{hardware.memory_kind === 'unified' ? D('统一内存', 'unified memory') : D('单卡显存', 'per-card VRAM')} {hardware.accelerator_memory_gib.toFixed(1)} GiB</span>}
          {hardware.total_memory_gib && <span>{D('系统内存 ', 'System memory ')}{hardware.total_memory_gib.toFixed(1)} GiB{hardware.memory_kind === 'dedicated' ? D('（不用于显存分档）', ' (not used for VRAM tiers)') : ''}</span>}
          {runtime.ctx_size && <span>{D('上下文 ', 'Context ')}{runtime.ctx_size}</span>}
          {runtime.parallel && <span>{D('并发 ', 'Concurrency ')}{runtime.parallel}</span>}
        </div>
        {hardwareWarnings.length > 0 && (
          <div className={styles['pv-local-qwen-warning']}>{hardwareWarnings.join(' ')}</div>
        )}
      </div>

      {upgradeOptions.length > 0 && (
        <div className={styles['pv-local-qwen-upgrade']}>
          <div className={styles['pv-local-qwen-hardware-title']}>{D('可选本地模型', 'Optional local models')}</div>
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
                  <span>{option.reason || D('24GB+ 设备可试高能力本地模型。', 'A higher-capability local model you can try on 24GB+ machines.')}</span>
                  {(isDownloading || isVerifying || isPaused || isDownloaded || downloadErrored) && (
                    <div className={styles['pv-local-qwen-upgrade-progress']}>
                      <div className={styles['pv-local-qwen-upgrade-progress-row']}>
                        <span>
                          {download.state === 'verifying'
                            ? D('正在校验文件', 'Verifying files')
                            : isPaused
                              ? D('下载已暂停，可从已有分片继续', 'Download paused; can resume from existing chunks')
                            : isDownloaded
                              ? D('下载完成，可启动', 'Download complete, ready to start')
                              : downloadErrored
                                ? `下载失败：${download.lastError || D('请重试', 'please retry')}`
                                : `${download.activeSource || D('正在下载', 'Downloading')}${download.parallelSegments && download.parallelSegments > 1 ? ` · ${download.parallelSegments}${D(' 路', ' connections')}` : ''}`}
                        </span>
                        {(isDownloading || isVerifying || isDownloaded) && <strong>{downloadPercent.toFixed(0)}%</strong>}
                      </div>
                      <div className={styles['pv-local-qwen-progress-track']} aria-label={`${option.label || D('推荐模型', 'recommended model')}${D('下载进度', ' download progress')}`}>
                        <div
                          className={styles['pv-local-qwen-progress-bar']}
                          style={{ width: `${isDownloaded ? 100 : downloadPercent}%` }}
                        />
                      </div>
                      {(downloadedText || totalText) && (
                        <div className={styles['pv-local-qwen-progress-meta']}>
                          <span>{downloadedText || '0 B'}{totalText ? ` / ${totalText}` : ''}</span>
                          {!!download.bytesPerSecond && <span>{formatBytes(download.bytesPerSecond)}/s</span>}
                          {!!download.etaSeconds && <span>{D('剩余 ', 'Remaining ')}{formatDownloadEta(download.etaSeconds)}</span>}
                          {!!download.fileCount && download.fileCount > 1 && <span>{D('文件 ', 'File ')}{download.fileIndex || 1}/{download.fileCount}</span>}
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
                      ? D('下载中', 'Downloading')
                      : isDownloaded
                        ? (customStarting ? D('启动中', 'Starting') : D('启动此模型', 'Start this model'))
                        : upgradeStartingId === optionId
                          ? D('准备中', 'Preparing')
                          : (option.download_label || D('下载到本机', 'Download to this machine'))}
                  </button>
                  <button
                    type="button"
                    className={styles['pv-local-qwen-upgrade-action-btn']}
                    onClick={() => isDownloading || isPaused ? toggleRecommendedDownload(option, isPaused) : chooseGgufModel()}
                    disabled={customStarting || isVerifying}
                  >
                    {isVerifying ? D('正在校验', 'Verifying') : isDownloading ? D('暂停下载', 'Pause download') : isPaused ? D('继续下载', 'Resume download') : customStarting ? D('启动中', 'Starting') : D('导入本机 GGUF', 'Import a local GGUF')}
                  </button>
                  {(isDownloading || isPaused) && (
                    <button type="button" className={styles['pv-local-qwen-upgrade-action-btn']} onClick={() => cancelRecommendedDownload(option)}>
                      {D('取消', 'Cancel')}
                    </button>
                  )}
                  {(isPaused || isDownloaded) && (
                    <button type="button" className={styles['pv-local-qwen-upgrade-action-btn']} onClick={() => void removeDownloadedModel(optionId, option.label || D('本地模型', 'local model'))}>
                      {D('删除', 'Delete')}
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
          {showAdvancedLauncher ? D('收起管理', 'Collapse management') : D('管理本地模型', 'Manage local models')}
        </button>
        {showAdvancedLauncher && (
          <div className={styles['pv-local-qwen-advanced-panel']}>
            <div>
              <strong>{D('已有 GGUF / 模型目录', 'Existing GGUF / model folder')}</strong>
              <span>
                {D(
                  '默认使用 Qwen3.8-27B Coder390。24GB 及以上是 Q3，24GB 以下（16GB 档）是 Q2。也可以导入已经下载好的 GGUF。',
                  'Qwen3.8-27B Coder390 is the default. 24GB and above uses Q3, below 24GB (16GB tier) uses Q2. You can also import an already-downloaded GGUF.',
                )}
              </span>
              {modelPath && <code className={styles['pv-local-qwen-model-path']}>{modelPath}</code>}
              {needsMtpUpgrade && legacyModelPath && <code className={styles['pv-local-qwen-model-path']}>{D('旧版模型：', 'Older model: ')}{legacyModelPath}</code>}
            </div>
            <div className={styles['pv-local-qwen-advanced-actions']}>
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={openModelFolder}>
                {modelPath ? D('定位当前模型文件', 'Reveal the current model file') : D('打开模型目录', 'Open the model folder')}
              </button>
              <button
                type="button"
                className={styles['pv-verify-connection-btn']}
                onClick={chooseGgufModel}
                disabled={customStarting}
              >
                {customStarting ? D('启动中', 'Starting') : D('选择本机 GGUF 启动', 'Choose a local GGUF to start')}
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
          {D('本地 Qwen3.8-27B 启动失败：', 'Local Qwen3.8-27B failed to start: ')}
          {managerFailureReason || D('请重试，或先切回云端模型。', 'Please retry, or switch back to a cloud model first.')}
        </div>
      )}
      {actionStatus && (
        <div className={`${styles['pv-local-qwen-action-status']} ${styles[`pv-local-qwen-action-status-${actionStatus.kind}`]}`}>
          {actionStatus.text}
        </div>
      )}
      {showJobStatus && (
        <div className={styles['pv-local-qwen-job']}>
          {D('后台任务：', 'Background task: ')}{jobStatusLabel}{status?.job?.log_file ? D(' · 日志已保存', ' · log saved') : ''}
        </div>
      )}
      {jobRunning && progress && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>{progress.phase || D('准备本地模型', 'Preparing the local model')}</span>
            {progressPercent !== null && <strong>{progressPercent.toFixed(0)}%</strong>}
          </div>
          {progressPercent !== null && (
            <div className={styles['pv-local-qwen-progress-track']} aria-label={D('本地模型准备进度', 'Local model preparation progress')}>
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
              {progress.eta && <span>{D('剩余 ', 'Remaining ')}{progress.eta}</span>}
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
            ? D('容量不足或未确认，不能安装', 'Insufficient or unconfirmed memory — cannot install')
            : defaultDownloadActive
              ? `${D('下载中 ', 'Downloading ')}${defaultDownloadPercent.toFixed(0)}%`
            : endpointLoading || managerStarting
              ? D('模型加载中', 'Loading model')
              : endpointRunning
                ? D('已启用，重新检查', 'Enabled — check again')
                : hasModel && hasRuntime
                  ? D('启动本地模型', 'Start local model')
                  : needsMtpUpgrade
                    ? D(`安装 ${selectedTier.quantization}`, `Install ${selectedTier.quantization}`)
                  : !hasModel
                    ? D(`安装 ${selectedTier.quantization} 并启动`, `Install ${selectedTier.quantization} and start`)
                    : D('授权安装并启用', 'Authorise, install and enable')}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={() => loadStatus(false)} disabled={loading}>
          {loading ? D('刷新中', 'Refreshing') : D('刷新状态', 'Refresh status')}
        </button>
        {endpointRunning && <button className={styles['pv-verify-connection-btn']} onClick={openLocalDashboard}>
          {D('查看端点', 'View endpoint')}
        </button>}
        {canStopLocalModel && (
          <button className={styles['pv-verify-connection-btn']} onClick={stopLocalModel} disabled={stopping}>
            {stopping ? D('停止中', 'Stopping') : D('停止本地模型', 'Stop local model')}
          </button>
        )}
        <button className={styles['pv-verify-connection-btn']} onClick={registerOnly} disabled={registering}>
          {registering ? D('注册中', 'Registering') : D('重新注册本地端点', 'Re-register local endpoint')}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={snoozeLocalModel}>
          {D('暂不启用', 'Not now')}
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
