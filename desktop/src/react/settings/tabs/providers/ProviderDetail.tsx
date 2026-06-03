import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { OAuthCredentials } from './OAuthCredentials';
import { ApiKeyCredentials } from './ApiKeyCredentials';
import { ProviderModelList } from './ProviderModelList';
import { useLlamacppState } from '../../../hooks/use-llamacpp-state';
import { BRAIN_PROVIDER_ID, BRAIN_PROVIDER_LABEL } from '../../../../../../shared/brain-provider.js';
import styles from '../../Settings.module.css';

const platform = window.platform;
import {
  LOCAL_QWEN_PROVIDER_LABEL,
  LOCAL_QWEN35_9B_EXPECTED_SIZE,
  isLocalQwenProviderId,
  isDefaultQwen35MtpFileName,
  formatLocalTps,
  normalizeLocalUpgradeOptions,
  localEndpointRoot,
  formatBytes,
  localModelActionErrorText,
  type LocalActionStatus,
  type LocalUpgradeOption,
} from "./ProviderDetail.helpers";

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
          platform?.settingsChanged?.('models-changed');
          window.dispatchEvent(new CustomEvent('models-changed'));
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
  const runtime = hardware.recommended_runtime || {};
  const gpu = hardware.gpus?.[0];
  const servedModelIds = status?.runtime?.model_ids || observed.served_model_ids || [];
  const endpointDefaultRunning = status?.runtime?.serves_default_model === true
    || servedModelIds.includes('qwen35-9b-q4km-imatrix');
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
  // 默认卡只认当前 9B MTP artifact。旧 9B GGUF 会显示为可升级,不能挡住新版 MTP 下载。
  const hasModel = !!observed.gguf && isDefaultQwen35MtpFileName(modelFileName);
  const needsMtpUpgrade = !hasModel && (observed.needs_model_upgrade === true || !!legacyModelPath);
  const hardwareWarnings = [...new Set([
    ...(endpointForeign
      ? [`检测到 18099 当前运行的是 ${servedModelIds.join(', ') || '非默认模型端点'}，它不会作为默认 9B 使用；停止后可启动默认 Qwen3.5-9B MTP。`]
      : []),
    ...(needsMtpUpgrade
      ? [`检测到旧版 Qwen3.5-9B GGUF：${legacyModelFileName || '旧文件'}。默认档已升级为 MTP；点击升级会下载新版 MTP 文件，旧文件不会被删除。`]
      : []),
    ...(hardware.warnings || []),
    ...(hardware.blockers || []),
  ])];
  const hasRuntime = !endpointForeign && !!observed.llama_server;
  const defaultDownload = llamaState.download;
  const defaultDownloadState = String(defaultDownload.state || '');
  const defaultDownloadFor9B = defaultDownload.modelId === 'qwen35-9b-q4km-imatrix'
    || defaultDownload.modelId === 'local-qwen35-9b-q4km-imatrix'
    || defaultDownload.fileName === 'Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf';
  const defaultDownloadActive = defaultDownloadFor9B
    && (defaultDownloadState === 'downloading' || defaultDownloadState === 'verifying');
  const defaultDownloadDone = defaultDownloadFor9B && defaultDownloadState === 'done';
  const defaultDownloadError = defaultDownloadFor9B && defaultDownloadState === 'error';
  const defaultDownloadPercent = Math.max(0, Math.min(100, Number(defaultDownload.percent || 0)));
  const defaultDownloadTotalBytes = Number(defaultDownload.totalBytes || 0)
    || (defaultDownloadDone ? LOCAL_QWEN35_9B_EXPECTED_SIZE : 0);
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
    () => normalizeLocalUpgradeOptions(hardware.upgrade_options || [], hardware.total_memory_gib),
    [hardware.upgrade_options, hardware.total_memory_gib],
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
  const hardwareBlocked = hardware.can_enable === false;
  const hardwareLabel = runtime.label || (loading || !status ? '正在检查硬件' : '默认使用云端模型');
  const stateLabel = useMemo(() => {
    if (endpointForeign) return '非默认本地端点运行中';
    if (jobRunning) return '正在准备';
    if (endpointLoading) return '正在加载';
    if (endpointRunning) return '已运行';
    if (needsMtpUpgrade) return '可升级';
    if (hasModel && hasRuntime) return '可启动';
    return '待安装';
  }, [endpointForeign, endpointLoading, endpointRunning, hasModel, hasRuntime, jobRunning, needsMtpUpgrade]);

  useEffect(() => {
    if (!jobRunning) return undefined;
    const id = window.setInterval(() => {
      loadStatus(true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [jobRunning, loadStatus]);

  useEffect(() => {
    if (!endpointRunning && !endpointForeign) return undefined;
    const id = window.setInterval(() => {
      loadStatus(true);
    }, 3000);
    return () => window.clearInterval(id);
  }, [endpointForeign, endpointRunning, loadStatus]);

  const authorizeAndSetup = async () => {
    const profile = runtime.label ? `\n\n推荐配置：${runtime.label}，上下文 ${runtime.ctx_size || 8192}，并发 ${runtime.parallel || 1}` : '';
    const warning = hardwareWarnings.length ? `\n\n注意：${hardwareWarnings.join(' ')}` : '';
    const setupText = hasModel && hasRuntime
      ? 'Lynn 将按你的确认启动本地 Qwen3.5-9B MTP 模型服务，并切换为本地模型。启动会占用约 6GB 显存/统一内存。'
      : needsMtpUpgrade
        ? 'Lynn 将保留旧版 9B 文件，并下载新版 Qwen3.5-9B MTP；这是显式启用流程，完成后会启动 MTP 端点。\n\n模型约 5.78GB / 5.38GiB；旧文件不会被删除，你可以稍后手动清理。启动会占用约 6GB 显存/统一内存。'
        : 'Lynn 将在本机安装或定位 llama.cpp，下载 Qwen3.5-9B Q4_K_M imatrix MTP，并启动本地模型服务。\n\n模型约 5.78GB / 5.38GiB；新版 MTP 在 DGX Spark 单流从 36.61 提升到 60.95 TPS，thinking-on 和工具调用稳定性强于 4B。完成后可离线使用，不需要 API Key，不上传对话。启动会占用约 6GB 显存/统一内存。';
    const ok = window.confirm(`${setupText}${profile}${warning}\n\n继续吗？`);
    if (!ok) return;
    if (platform?.llamacppStartDownload) {
      setSettingUp(true);
        setActionStatus({
          kind: 'info',
          text: hasModel
            ? '正在启动本地 Qwen3.5-9B；如果模型文件已完整，Lynn 会直接校验并拉起本地端点。'
            : needsMtpUpgrade
              ? '正在升级到本地 Qwen3.5-9B MTP；旧版文件会保留，新版校验完成后按本次授权启动。'
              : '正在下载本地 Qwen3.5-9B，进度会留在当前页面；下载完成后按本次授权启动本地端点。',
        });
      try {
        const res = await platform.llamacppStartDownload({
          modelId: 'qwen35-9b-q4km-imatrix',
          startAfterDownload: true,
        });
        if (!res?.ok) throw new Error(localModelActionErrorText(res?.reason, res?.detail));
        showToast(
          res.alreadyRunning
            ? '本地 9B 已在下载/启动队列中。'
            : hasModel
              ? '本地 Qwen3.5-9B 正在启动。'
              : needsMtpUpgrade
                ? '本地 Qwen3.5-9B MTP 升级已开始。'
                : '本地 Qwen3.5-9B 已开始下载。',
          'info',
        );
        setActionStatus({
          kind: 'info',
          text: res.alreadyRunning
            ? '本地 9B 已在下载/启动队列中，进度会自动刷新。'
            : hasModel
              ? '启动任务已提交。加载完成后会自动切换为本地模型。'
            : needsMtpUpgrade
              ? '新版 MTP 下载已启动，校验完成后会自动启动本地端点。'
                : '本地 9B 下载已启动，校验完成后会自动启动本地端点。',
        });
        await onRefresh();
        window.setTimeout(loadStatus, 1500);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast('本地 9B 启动失败：' + msg, 'error');
        setActionStatus({ kind: 'error', text: `任务未启动：${msg}` });
      } finally {
        setSettingUp(false);
      }
      return;
    }
    setSettingUp(true);
    setActionStatus({ kind: 'info', text: hasModel && hasRuntime ? '正在启动本地模型服务…' : '已获得授权，正在后台准备 llama.cpp 和模型文件…' });
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        timeout: 30_000,
      });
      const data = await res.json();
      setStatus((prev) => ({ ...(prev || {}), job: data.job }));
      showToast(
        hasModel && hasRuntime
          ? '本地 Qwen3.5-9B 正在启动，加载完成后会自动切换为当前模型。'
          : '本地 Qwen3.5-9B 正在后台准备，完成后会自动注册并切换为当前模型。',
        'info',
      );
      setActionStatus({
        kind: 'info',
        text: hasModel && hasRuntime
          ? '启动任务已提交。加载完成后会自动切换为本地模型。'
          : '安装/下载任务已提交。进度会在此处持续刷新。',
      });
      await onRefresh();
      window.setTimeout(loadStatus, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('本地 Qwen3.5-9B 启用失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `启用失败：${msg}` });
    } finally {
      setSettingUp(false);
    }
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
      showToast('本地 Qwen3.5-9B 已注册到模型列表。', 'success');
      setActionStatus({ kind: 'success', text: '已重新注册本地端点，并切换到本地 Qwen3.5-9B。' });
      platform?.settingsChanged?.('models-changed');
      window.dispatchEvent(new CustomEvent('models-changed'));
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
    const modelId = option.id || 'qwen36-35b-a3b-apex-mtp';
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
        setActionStatus({ kind: 'info', text: '未选择模型。默认 Qwen3.5-9B 仍保持可用。' });
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
      <div className={styles['pv-local-qwen-main']}>
        <div>
          <div className={styles['pv-local-qwen-kicker']}>默认本地 Qwen3.5-9B MTP，Lynn imatrix 校准 · 24GB 显存/统一内存推荐</div>
          <div className={styles['pv-local-qwen-title']}>Qwen3.5-9B Q4_K_M imatrix MTP</div>
          <div className={styles['pv-local-qwen-desc']}>
            5.78GB / 5.38GiB · 32K 上下文 · DGX Spark MTP 单流 36.61→60.95 TPS · Q4_K_M imatrix 校准 · thinking-on 稳定性优先。
            Lynn 会在用户授权后自动准备 llama.cpp、模型文件和本地 OpenAI 端点；完成后可离线使用，
            不需要 API Key，不上传对话。低配设备可在模型页手动选择 4B 降级档；Lynn 会提示 thinking-on 风险。
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
        <span>5.78GB / 5.38GiB</span>
        <span>32K 上下文</span>
        <span>MTP 加速</span>
        <span>Lynn imatrix 校准</span>
        <span>MMLU 500 81.20%</span>
        <span>24GB+ 推荐</span>
        <span>本地优先</span>
        <span>无 API Key</span>
        <span>隐私留在本机</span>
      </div>

      <div className={styles['pv-local-qwen-facts']}>
        <span>模型 {hasModel ? '已就绪' : needsMtpUpgrade ? '可升级到 MTP' : '待下载'}</span>
        {modelFileName && <span title={modelPath}>模型文件 {modelFileName}</span>}
        {needsMtpUpgrade && legacyModelFileName && <span title={legacyModelPath}>旧版 9B {legacyModelFileName}</span>}
        {needsMtpUpgrade && <span>新版 MTP 待下载</span>}
        <span>llama.cpp {hasRuntime ? '已找到' : '待安装'}</span>
        {endpointForeign && <span>当前端点 {servedModelIds.join(', ') || '非默认 9B'}</span>}
        {(endpointActive || endpointForeign) && runtimeStats?.pid && <span>PID {runtimeStats.pid}</span>}
        {endpointForeign && <span>停止后可启用默认 9B</span>}
        {endpointLoading && <span>模型权重加载中</span>}
        {endpointRunning && <span>{runtimeTpsLabel ? `当前 ${runtimeTpsLabel}` : '速度等待采样'}</span>}
        {endpointRunning && <span>{runtimeMetricsReady ? `服务累计处理 ${runtimeTokens.toLocaleString()} tokens` : '运行统计同步中'}</span>}
        {endpointRunning && slotLabel && <span>{slotLabel}</span>}
        <span>{plan.base_url || 'http://127.0.0.1:18099/v1'}</span>
      </div>

      {(defaultDownloadActive || defaultDownloadDone || defaultDownloadError) && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>
              {defaultDownloadState === 'verifying'
                ? '正在校验默认 9B'
                : defaultDownloadDone
                  ? '默认 9B 已下载完成'
                  : defaultDownloadError
                    ? `默认 9B 下载失败：${defaultDownload.lastError || '请重试'}`
                    : `${defaultDownload.activeSource || '正在下载默认 9B'}${defaultDownload.parallelSegments && defaultDownload.parallelSegments > 1 ? ` · ${defaultDownload.parallelSegments} 路` : ''}`}
            </span>
            {(defaultDownloadActive || defaultDownloadDone) && <strong>{(defaultDownloadDone ? 100 : defaultDownloadPercent).toFixed(0)}%</strong>}
          </div>
          <div className={styles['pv-local-qwen-progress-track']} aria-label="默认 9B 下载进度">
            <div
              className={styles['pv-local-qwen-progress-bar']}
              style={{ width: `${defaultDownloadDone ? 100 : defaultDownloadPercent}%` }}
            />
          </div>
          <div className={styles['pv-local-qwen-progress-meta']}>
            {defaultDownloadSizeText.length > 0 && (
              <span>{defaultDownloadSizeText.length > 1 ? defaultDownloadSizeText.join(' / ') : defaultDownloadSizeText[0]}</span>
            )}
            {defaultDownload.target && <span title={defaultDownload.target}>{defaultDownload.fileName || 'Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf'}</span>}
          </div>
        </div>
      )}

      <div className={styles['pv-local-qwen-hardware']}>
        <div className={styles['pv-local-qwen-hardware-title']}>硬件判断</div>
        <div className={styles['pv-local-qwen-facts']}>
          <span>{hardwareLabel}</span>
          {hardware.chip && <span>{hardware.chip}</span>}
          {gpu?.name && <span>{gpu.name}{gpu.memory_gib ? ` · ${gpu.memory_gib.toFixed(1)}GB` : ''}</span>}
          {hardware.total_memory_gib && <span>内存 {hardware.total_memory_gib.toFixed(1)}GB</span>}
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
            const optionId = option.id || 'qwen36-35b-a3b-apex-mtp';
            const download = llamaState.download;
            const isThisDownload = download.modelId === optionId
              || (!!option.file_name && download.fileName === option.file_name);
            const isDownloading = isThisDownload && (download.state === 'downloading' || download.state === 'verifying');
            const isDownloaded = isThisDownload && download.state === 'done' && !!download.target;
            const downloadErrored = isThisDownload && download.state === 'error';
            const downloadPercent = Math.max(0, Math.min(100, Number(download.percent || 0)));
            const downloadedText = formatBytes(download.bytesTransferred);
            const totalText = formatBytes(download.totalBytes);
            return (
              <div key={option.id || option.label} className={styles['pv-local-qwen-upgrade-card']}>
                <div className={styles['pv-local-qwen-upgrade-copy']}>
                  <strong>{option.label || 'Qwen3.6-35B-A3B APEX-MTP I-Balanced'}</strong>
                  {option.profile && <em>{option.profile}</em>}
                  {Array.isArray(option.metrics) && option.metrics.length > 0 && (
                    <div className={styles['pv-local-qwen-upgrade-metrics']}>
                      {option.metrics.map((metric) => (
                        <span key={metric}>{metric}</span>
                      ))}
                    </div>
                  )}
                  <span>{option.reason || '24GB+ 设备可试高能力本地模型。'}</span>
                  {(isDownloading || isDownloaded || downloadErrored) && (
                    <div className={styles['pv-local-qwen-upgrade-progress']}>
                      <div className={styles['pv-local-qwen-upgrade-progress-row']}>
                        <span>
                          {download.state === 'verifying'
                            ? '正在校验文件'
                            : isDownloaded
                              ? '下载完成，可启动'
                              : downloadErrored
                                ? `下载失败：${download.lastError || '请重试'}`
                                : `${download.activeSource || '正在下载'}${download.parallelSegments && download.parallelSegments > 1 ? ` · ${download.parallelSegments} 路` : ''}`}
                        </span>
                        {(isDownloading || isDownloaded) && <strong>{downloadPercent.toFixed(0)}%</strong>}
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
                    disabled={isDownloading || customStarting || upgradeStartingId === optionId}
                  >
                    {isDownloading
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
                    onClick={() => isDownloading ? cancelRecommendedDownload(option) : chooseGgufModel()}
                    disabled={customStarting}
                  >
                    {isDownloading ? '取消下载' : customStarting ? '启动中' : '导入本机 GGUF'}
                  </button>
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
              <span>默认使用 Qwen3.5-9B MTP。4B 仅作为低配降级，thinking-on 可能长思考后无正文；也可以导入已经下载好的 35B 或其他 GGUF。</span>
              {modelPath && <code className={styles['pv-local-qwen-model-path']}>{modelPath}</code>}
              {needsMtpUpgrade && legacyModelPath && <code className={styles['pv-local-qwen-model-path']}>旧版 9B：{legacyModelPath}</code>}
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
          disabled={settingUp || jobRunning || hardwareBlocked || endpointLoading || defaultDownloadActive}
        >
          {hardwareBlocked
            ? '硬件不建议本地启用'
            : defaultDownloadActive
              ? `下载中 ${defaultDownloadPercent.toFixed(0)}%`
            : endpointLoading
              ? '模型加载中'
              : endpointRunning
                ? '已启用，重新检查'
                : hasModel && hasRuntime
                  ? '启动本地模型'
                  : needsMtpUpgrade
                    ? '升级到 9B MTP (5.78 GB)'
                  : !hasModel
                    ? '下载 9B 并启动 (5.78 GB)'
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
      platform?.settingsChanged?.('models-changed');
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
