/**
 * LocalModelDownloadStep.tsx — Lynn default local model setup.
 *
 * This step keeps the legacy local provider id for routing compatibility, but
 * setup uses Electron main's llama.cpp downloader exclusively. The current
 * Q3/Q2 + DFlash2 installer never falls back to the legacy Python model setup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { saveProvider } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';
import { useOnboardingI18n } from '../use-onboarding-i18n';
import { QUICK_LOCAL_PROVIDER } from '../constants';
import { useLlamacppState } from '../../hooks/use-llamacpp-state';
import { LocalModelSetupChoice, getLocalModelTier, localModelCatalog, requestLocalModelHelp } from '../../components/input/LocalModelSetupChoice';
import {
  BRAIN_PROVIDER_ID,
  BRAIN_PROVIDER_BASE_URL,
  BRAIN_PROVIDER_API,
  BRAIN_DEFAULT_MODEL_ID,
} from '../../../../../shared/brain-provider.js';

interface LocalModelDownloadStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onProviderReady: (providerName: string, providerUrl: string, providerApi: string, apiKey: string) => void;
  nextStep: number;
  backStep: number;
}

type LocalSetupStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  error?: string;
  runtime?: {
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    base_url?: string;
    model_ids?: string[];
  };
  plan?: {
    base_url?: string;
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      gguf?: string | null;
      llama_server?: string | null;
    };
    hardware?: {
      can_enable?: boolean;
      recommended_model_id?: string | null;
      accelerator_memory_gib?: number | null;
      warnings?: string[];
      blockers?: string[];
      recommended_runtime?: {
        label?: string;
        ctx_size?: number;
        parallel?: number;
      };
    };
  };
  job?: {
    status?: string;
    log_file?: string;
    progress?: {
      phase?: string;
      percent?: number | null;
      downloaded?: string;
      total?: string;
      eta?: string;
      speed?: string;
      message?: string;
      tail?: string[];
    } | null;
  } | null;
};

function endpointReady(status: LocalSetupStatus | null): boolean {
  return status?.runtime?.endpoint_running === true || status?.plan?.observed?.endpoint_running === true;
}

function endpointLoading(status: LocalSetupStatus | null): boolean {
  return !endpointReady(status) && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
      || status?.job?.status === 'running'
  );
}

function hasModelAndRuntime(status: LocalSetupStatus | null): boolean {
  return !!(status?.plan?.observed?.gguf && status?.plan?.observed?.llama_server);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return null;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

function localModelErrorText(reason: string | null | undefined): string {
  const code = String(reason || '').trim();
  if (!code) return '本地模型准备失败，请重试。';
  if (code.includes('desktop-installer-required')) return '此方案需要 Lynn 桌面端的下载器，请打开桌面版或让 Lynn 协助部署。';
  if (code.includes('insufficient-disk-space')) return '磁盘空间不足，请按所选方案的空间提示释放磁盘后重试。';
  if (code.includes('binary-not-found') || code.includes('needs-binary')) return '没有找到本地推理运行时，请在设置里重新安装。';
  if (code.includes('port-in-use')) return '本地模型端口正被其他程序占用，请关闭对应程序后重试。';
  if (code.includes('checksum')) return '模型文件校验失败，Lynn 会在重试时重新下载损坏部分。';
  if (code.includes('all-sources-failed') || code.includes('request-timeout')) return '下载源暂时不可用，请检查网络后继续。';
  if (code.includes('cancel')) return '下载已取消。';
  return '本地模型准备失败，请重试或暂时使用云端模型。';
}

export function LocalModelDownloadStep({
  preview, onboardingFetch, goToStep, showError, onProviderReady,
  nextStep, backStep,
}: LocalModelDownloadStepProps) {
  const { t } = useOnboardingI18n();
  const llamaState = useLlamacppState();
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualTierId, setManualTierId] = useState<string | null>(null);
  const runningTierId = localModelCatalog.tiers.find(tier => status?.runtime?.model_ids?.includes(tier.modelId))?.modelId;
  const selectedTier = getLocalModelTier(manualTierId || runningTierId || status?.plan?.hardware?.recommended_model_id);
  const selectedModelId = selectedTier.modelId;
  useEffect(() => {
    if (!manualTierId && localModelCatalog.tiers.some(tier => tier.modelId === llamaState.download.modelId)
      && ['downloading', 'verifying', 'paused'].includes(llamaState.download.state)) {
      setManualTierId(llamaState.download.modelId!);
    }
  }, [manualTierId, llamaState.download.modelId, llamaState.download.state]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await onboardingFetch('/api/local-qwen35-9b/status');
      const data = await res.json();
      setStatus(data);
      return data as LocalSetupStatus;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    }
  }, [onboardingFetch]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const ready = (status?.runtime?.model_ids?.includes(selectedModelId) && endpointReady(status))
    || (llamaState.modelId === selectedModelId && (llamaState.healthy || llamaState.status === 'ready'));
  const downloadActive = llamaState.download.state === 'downloading'
    || llamaState.download.state === 'verifying';
  const downloadCanPause = llamaState.download.state === 'downloading';
  const downloadPaused = llamaState.download.state === 'paused';
  const busy = endpointLoading(status) || downloadActive || llamaState.status === 'starting';
  const modelPrepared = hasModelAndRuntime(status) || !!(llamaState.modelPath && llamaState.binaryPath);
  const jobRunning = status?.job?.status === 'running';
  const jobFailed = status?.job?.status === 'failed';
  const progress = status?.job?.progress || null;
  // #21: keep warnings and blockers visually separate
  const softWarnings: string[] = status?.plan?.hardware?.warnings || [];
  const hardBlockers: string[] = status?.plan?.hardware?.blockers || [];
  const canEnableDefault = !!manualTierId || status?.plan?.hardware?.can_enable === true;
  const hardwareBlocked = status?.plan?.hardware?.can_enable === false;
  const canStart = !busy && !downloadPaused && !ready && canEnableDefault;
  const progressPercent = ready
    ? 100
    : downloadActive || downloadPaused || llamaState.download.state === 'done'
      ? Math.max(0, Math.min(100, Number(llamaState.download.overallPercent ?? llamaState.download.percent ?? 0)))
      : typeof progress?.percent === 'number'
        ? Math.max(0, Math.min(100, progress.percent))
        : 0;

  useEffect(() => {
    if (!busy && !jobRunning) return undefined;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(id);
  }, [busy, jobRunning, refreshStatus]);

  const persistAndAdvance = useCallback(async () => {
    if (preview) {
      goToStep(nextStep);
      return;
    }
    if (savingProvider || providerSaved) return;
    setSavingProvider(true);
    try {
      await saveProvider({
        onboardingFetch,
        providerName: QUICK_LOCAL_PROVIDER.providerName,
        providerUrl: QUICK_LOCAL_PROVIDER.providerUrl,
        apiKey: '',
        providerApi: QUICK_LOCAL_PROVIDER.providerApi,
        defaultModelId: selectedModelId,
      });
      onProviderReady(QUICK_LOCAL_PROVIDER.providerName, QUICK_LOCAL_PROVIDER.providerUrl, QUICK_LOCAL_PROVIDER.providerApi, '');
      setProviderSaved(true);
      goToStep(nextStep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showError(t('onboarding.error'));
    } finally {
      setSavingProvider(false);
    }
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, providerSaved, savingProvider, showError, t, selectedModelId]);

  const startSetup = useCallback(async () => {
    if (preview) {
      goToStep(nextStep);
      return;
    }
    setLoading(true);
    setSetupStarted(true);
    setError(null);
    try {
      const managerStart = await llamaState.startDownload({
        modelId: selectedModelId,
        startAfterDownload: true,
      });
      if (managerStart) {
        if (managerStart.ok === false) {
          throw new Error(managerStart.reason || 'llamacpp_manager_start_failed');
        }
        setStatus((prev) => ({
          ...(prev || { ok: true }),
          ok: prev?.ok ?? true,
          runtime: {
            ...(prev?.runtime || {}),
            base_url: prev?.runtime?.base_url || QUICK_LOCAL_PROVIDER.providerUrl,
            endpoint_loading: true,
            process_alive: true,
          },
          job: {
            status: 'running',
            progress: {
              phase: managerStart.alreadyRunning ? '本地模型已在准备中' : '正在下载并启动本地模型',
              percent: null,
              message: managerStart.fileCount && managerStart.fileCount > 1
                ? `正在准备主模型与 DFlash2（${managerStart.fileCount} 个文件）`
                : '正在准备 GGUF 文件',
            },
          },
        }));
        window.setTimeout(() => void refreshStatus(), 900);
        return;
      }
      throw new Error('desktop-installer-required');
    } catch (err) {
      const msg = localModelErrorText(err instanceof Error ? err.message : String(err));
      setError(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, [goToStep, llamaState, nextStep, onboardingFetch, preview, refreshStatus, showError, selectedModelId]);

  const fallbackToBrain = useCallback(async () => {
    if (preview) { goToStep(nextStep); return; }
    setSavingProvider(true);
    try {
      await saveProvider({
        onboardingFetch,
        providerName: BRAIN_PROVIDER_ID,
        providerUrl: BRAIN_PROVIDER_BASE_URL,
        apiKey: '',
        providerApi: BRAIN_PROVIDER_API,
        defaultModelId: BRAIN_DEFAULT_MODEL_ID,
      });
      onProviderReady(BRAIN_PROVIDER_ID, BRAIN_PROVIDER_BASE_URL, BRAIN_PROVIDER_API, '');
      goToStep(nextStep);
    } catch (err) {
      console.error('[onboarding] brain fallback failed:', err);
      showError(t('onboarding.error'));
    } finally {
      setSavingProvider(false);
    }
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, showError, t]);

  const statusLine = useMemo(() => {
    if (error) return error;
    if (ready) return t('onboarding.localModel.spawnReady');
    if (jobFailed || llamaState.download.state === 'error') {
      return localModelErrorText(status?.job?.progress?.message || llamaState.download.lastError);
    }
    if (downloadPaused) return '下载已暂停，可以稍后从这里继续。';
    if (llamaState.download.state === 'verifying') return '下载完成，正在校验模型文件。';
    if (downloadActive) {
      const fileProgress = llamaState.download.fileCount && llamaState.download.fileCount > 1
        ? `第 ${llamaState.download.fileIndex || 1}/${llamaState.download.fileCount} 个文件`
        : '模型文件';
      return `正在下载${fileProgress}`;
    }
    if (busy) return progress?.message || progress?.phase || t('onboarding.localModel.spawning');
    if (modelPrepared) return t('onboarding.localModel.modelPreparedHint');
    if (!canEnableDefault) return t('onboarding.localModel.hardwareNotRecommended');
    return t('onboarding.localModel.subtitle');
  }, [busy, canEnableDefault, downloadActive, downloadPaused, error, jobFailed, llamaState.download, modelPrepared, progress?.message, progress?.phase, ready, status?.job?.progress?.message, t]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.localModel.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.localModel.subtitle')} />
      <p className="ob-step-note">{t('onboarding.localModel.specsLine')}</p>
      <LocalModelSetupChoice value={selectedModelId} recommendedId={status?.plan?.hardware?.recommended_model_id}
        onChange={setManualTierId} disabled={busy || loading || downloadPaused}
        onHelp={() => { void requestLocalModelHelp(selectedModelId, status?.plan?.hardware, error || llamaState.download.lastError)
          .catch(err => showError(String(err.message))); }} />

      <div className="local-model-progress" role="status" aria-live="polite">
        <div className="local-model-progress-bar">
          <div
            className="local-model-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="local-model-progress-meta">
          <span>{ready
            ? '100%'
            : downloadPaused
              ? `已暂停 · ${Math.round(progressPercent)}%`
              : busy
                ? `${Math.round(progressPercent)}%`
                : modelPrepared
                  ? t('onboarding.localModel.statusReady')
                  : t('onboarding.localModel.statusWaiting')}</span>
          <span>{status?.plan?.hardware?.recommended_runtime?.label || t('onboarding.localModel.runtimeLocalDefault')}</span>
        </div>
        {(downloadActive || downloadPaused) && (
          <div className="local-model-progress-meta">
            <span>
              {formatBytes(llamaState.download.bytesTransferred)} / {formatBytes(llamaState.download.totalBytes)}
              {llamaState.download.fileCount && llamaState.download.fileCount > 1
                ? ` · 文件 ${llamaState.download.fileIndex || 1}/${llamaState.download.fileCount}`
                : ''}
            </span>
            <span>
              {llamaState.download.bytesPerSecond
                ? `${formatBytes(llamaState.download.bytesPerSecond)}/s`
                : '正在连接下载源'}
              {formatDuration(llamaState.download.etaSeconds)
                ? ` · 剩余 ${formatDuration(llamaState.download.etaSeconds)}`
                : ''}
            </span>
          </div>
        )}
        <div className={`local-model-progress-substatus${error || jobFailed ? ' is-error' : ''}`}>
          {statusLine}
        </div>
      </div>

      {/* #21+#22: hard blockers (red) get prominent display + actionable hint;
          soft warnings (grey) stay subtle */}
      {hardBlockers.length > 0 && (
        <div className="ob-step-blocker" style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'rgba(255, 78, 78, 0.08)',
          border: '1px solid rgba(255, 78, 78, 0.35)',
          color: '#b73a3a',
          fontSize: 13,
          lineHeight: 1.55,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hardwareBlocked ? '⚠ ' : ''}{hardBlockers[0]}
          </div>
          {hardBlockers.slice(1).map((b, i) => (
            <div key={i} style={{ marginTop: 4 }}>{b}</div>
          ))}
          {hardwareBlocked && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
              {t('onboarding.localModel.switchBackBtn')} →
            </div>
          )}
        </div>
      )}
      {softWarnings.length > 0 && (
        <p className="ob-step-note">{softWarnings.join(' ')}</p>
      )}

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.localModel.back')}
        </button>
        {ready ? (
          <button className="ob-btn ob-btn-primary" disabled={savingProvider} onClick={() => void persistAndAdvance()}>
            {t('onboarding.localModel.next')}
          </button>
        ) : downloadPaused ? null : (
          <button className="ob-btn ob-btn-primary" disabled={!canStart || loading} onClick={() => void startSetup()}>
            {busy || loading
              ? t('onboarding.localModel.spawning')
              : setupStarted || jobFailed
                ? t('onboarding.localModel.retryBtn')
                : t('onboarding.localModel.startBtn')}
          </button>
        )}
        {downloadCanPause && !ready && (
          <button
            className="ob-btn ob-btn-secondary"
            onClick={() => void llamaState.pauseDownload()}
          >
            暂停下载
          </button>
        )}
        {downloadPaused && !ready && (
          <button
            className="ob-btn ob-btn-primary"
            onClick={() => void startSetup()}
          >
            继续下载
          </button>
        )}
        {(downloadActive || downloadPaused) && !ready && (
          <button
            className="ob-btn ob-btn-secondary"
            onClick={() => void llamaState.cancelDownload()}
            title={t('onboarding.localModel.cancelBtn')}
          >
            {t('onboarding.localModel.cancelBtn')}
          </button>
        )}
        <button className="ob-btn ob-btn-secondary" disabled={savingProvider} onClick={() => void fallbackToBrain()}>
          {t('onboarding.localModel.switchBackBtn')}
        </button>
      </div>
    </StepContainer>
  );
}
