/**
 * ProviderStatusBadge.tsx — Compact model-route chip for the welcome screen.
 *
 * Local Qwen3.8-27B state is sourced from the server-side /api/local-qwen35-9b/*
 * route (legacy endpoint name kept for backward compat) so this chip,
 * Settings, onboarding, and chat routing share the same provider id and
 * setup lifecycle. Default setup is hardware-adaptive Qwen3.8 Q3/Q2 with Q4 DFlash2.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { isChineseLocale } from '../utils/locale';

/** Inline zh/en picker for copy that ships near this module. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

import { useI18n } from '../hooks/use-i18n';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { loadModels } from '../utils/ui-helpers';
import { BRAIN_PROVIDER_ID, BRAIN_DEFAULT_MODEL_ID } from '../../../../shared/brain-provider.js';

const LOCAL_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
const LOCAL_MODEL_ID = 'qwen38-27b-coder390-q3-lynnstyle';

type LocalStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  provider_state?: {
    state?: string;
    severity?: string;
    canSwitch?: boolean;
    canSetup?: boolean;
    reason?: string;
  };
  runtime?: {
    endpoint_running?: boolean;
    endpoint_running_any?: boolean;
    endpoint_loading?: boolean;
    endpoint_occupied?: boolean;
    serves_default_model?: boolean;
    process_alive?: boolean;
    base_url?: string;
    model_ids?: string[];
  };
  plan?: {
    hardware?: {
      can_enable?: boolean;
      recommended_model_id?: string | null;
    };
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      endpoint_occupied?: boolean;
      served_model_ids?: string[];
      gguf?: string | null;
      llama_server?: string | null;
    };
  };
  job?: {
    status?: string;
    progress?: {
      percent?: number | null;
      phase?: string;
    } | null;
  } | null;
};

function localProviderState(status: LocalStatus | null): string {
  return String(status?.provider_state?.state || '');
}

function providerDisplayLabel(provider: string | null, isZh: boolean): string {
  if (!provider) return isZh ? '未配置' : 'No model';
  if (provider === BRAIN_PROVIDER_ID) return isZh ? '默认模型' : 'Default model';
  if (provider === LOCAL_PROVIDER_ID) return isZh ? '本地 Qwen3.8-27B' : 'Local Qwen3.8-27B';
  return provider;
}

function isLocalReady(status: LocalStatus | null): boolean {
  if (localProviderState(status) === 'ready') return true;
  const modelIds = status?.runtime?.model_ids || status?.plan?.observed?.served_model_ids || [];
  const servesDefault = status?.runtime?.serves_default_model === true || modelIds.includes(LOCAL_MODEL_ID);
  return servesDefault && (status?.runtime?.endpoint_running === true || status?.plan?.observed?.endpoint_running === true);
}

function isLocalEndpointOccupied(status: LocalStatus | null): boolean {
  if (localProviderState(status) === 'occupied') return true;
  const modelIds = status?.runtime?.model_ids || status?.plan?.observed?.served_model_ids || [];
  const servesDefault = status?.runtime?.serves_default_model === true || modelIds.includes(LOCAL_MODEL_ID);
  return status?.runtime?.endpoint_occupied === true
    || status?.plan?.observed?.endpoint_occupied === true
    || ((status?.runtime?.endpoint_running_any === true || status?.runtime?.endpoint_running === true)
      && modelIds.length > 0
      && !servesDefault);
}

function isLocalBusy(status: LocalStatus | null): boolean {
  if (localProviderState(status) === 'preparing') return true;
  return !isLocalReady(status) && !isLocalEndpointOccupied(status) && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
      || status?.job?.status === 'running'
  );
}

function hasLocalAssets(status: LocalStatus | null): boolean {
  const state = localProviderState(status);
  if (state === 'ready_to_start' || state === 'ready' || state === 'endpoint_ready_unregistered') return true;
  return !!(status?.plan?.observed?.gguf && status?.plan?.observed?.llama_server);
}

export function ProviderStatusBadge() {
  const { locale } = useI18n();
  const isZh = (locale || '').startsWith('zh');
  const currentModel = useStore((s) => s.currentModel);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refreshLocal = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 10_000 });
      const data = await res.json();
      setLocalStatus(data);
      if (data?.registered_provider && (data?.runtime?.endpoint_running || data?.plan?.observed?.endpoint_running)) {
        void loadModels();
      }
      return data as LocalStatus;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    const id = window.setInterval(refreshLocal, 12_000);
    return () => window.clearInterval(id);
  }, [refreshLocal]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const t1 = window.setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => {
      window.clearTimeout(t1);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [menuOpen]);

  const activeProvider = currentModel?.provider || null;
  const isLocalActive = activeProvider === LOCAL_PROVIDER_ID;
  const localReady = isLocalReady(localStatus);
  const localOccupied = isLocalEndpointOccupied(localStatus);
  const localBusy = isLocalBusy(localStatus) || preparing;
  const localAssets = hasLocalAssets(localStatus);
  const localCanSetup = localStatus?.plan?.hardware?.can_enable === true;
  const localCannotSetup = localStatus?.plan?.hardware?.can_enable === false;

  const { statusText, tone } = useMemo<{ statusText: string; tone: 'ready' | 'busy' | 'standby' | 'error' | 'cloud' }>(() => {
    if (!isLocalActive) {
      return { statusText: providerDisplayLabel(activeProvider, isZh), tone: 'cloud' };
    }
    if (localReady) return { statusText: isZh ? '本地就绪' : 'Local ready', tone: 'ready' };
    if (localOccupied) return { statusText: isZh ? '其他模型占用' : 'Other model active', tone: 'error' };
    if (localBusy) {
      const percent = localStatus?.job?.progress?.percent;
      return {
        statusText: typeof percent === 'number' ? `${Math.round(percent)}%` : (isZh ? '准备中' : 'Preparing'),
        tone: 'busy',
      };
    }
    if (localCannotSetup && !localReady && !localAssets) return { statusText: isZh ? '配置不足' : 'Hardware low', tone: 'standby' };
    if (!localAssets) return { statusText: isZh ? '待准备' : 'Needs setup', tone: 'standby' };
    return { statusText: isZh ? '可启动' : 'Ready to start', tone: 'standby' };
  }, [activeProvider, isLocalActive, isZh, localAssets, localBusy, localCannotSetup, localOccupied, localReady, localStatus?.job?.progress?.percent]);

  const switchToProvider = useCallback(async (targetProvider: typeof BRAIN_PROVIDER_ID | typeof LOCAL_PROVIDER_ID, localModelId?: string) => {
    if (switching) return;
    setSwitching(true);
    setMenuOpen(false);
    try {
      const modelId = targetProvider === BRAIN_PROVIDER_ID ? BRAIN_DEFAULT_MODEL_ID
        : localModelId || localStatus?.runtime?.model_ids?.find(id => /^qwen38-27b-(?:coder390|efficientthink)-q[23]-lynnstyle$/.test(id)) || LOCAL_MODEL_ID;
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, provider: targetProvider }),
      });
      await loadModels();
    } catch (err) {
      console.warn('[ProviderStatusBadge] switch failed:', err);
    } finally {
      setSwitching(false);
    }
  }, [switching, localStatus]);

  const prepareAndSwitchLocal = useCallback(async () => {
    if (preparing || switching) return;
    setPreparing(true);
    setMenuOpen(false);
    try {
      const latest = await refreshLocal();
      if (!isLocalReady(latest) && latest?.plan?.hardware?.can_enable !== true) {
        return;
      }
      if (!isLocalReady(latest)) {
        const managerStart = await window.platform?.llamacppStartDownload?.({
          modelId: latest?.plan?.hardware?.recommended_model_id || LOCAL_MODEL_ID,
          startAfterDownload: true,
        });
        if (managerStart) {
          if (managerStart.ok === false) {
            throw new Error(managerStart.reason || 'llamacpp_manager_start_failed');
          }
          setLocalStatus((prev) => ({
            ...(prev || { ok: true }),
            ok: prev?.ok ?? true,
            job: {
              status: 'running',
              progress: {
                phase: managerStart.alreadyRunning
                  ? D('本地模型已在准备中', 'The local model is already being prepared')
                  : D('正在准备本地模型', 'Preparing the local model'),
                percent: null,
                message: managerStart.fileCount && managerStart.fileCount > 1
                  ? D(
                    `正在准备主模型与 DFlash2（${managerStart.fileCount} 个文件）`,
                    `Preparing the main model and DFlash2 (${managerStart.fileCount} files)`,
                  )
                  : D('正在准备 GGUF 文件', 'Preparing GGUF files'),
              },
            },
          }));
        } else {
          throw new Error(D(
            '此方案需要 Lynn 桌面端下载器，请在设置中使用部署助手。',
            'This option needs the Lynn desktop downloader. Use the deployment assistant in Settings.',
          ));
        }
      }
      window.setTimeout(() => void refreshLocal(), 1000);
      if (isLocalReady(latest)) await switchToProvider(LOCAL_PROVIDER_ID,
        latest?.runtime?.model_ids?.find(id => /^qwen38-27b-(?:coder390|efficientthink)-q[23]-lynnstyle$/.test(id)));
    } catch (err) {
      console.warn('[ProviderStatusBadge] local setup failed:', err);
    } finally {
      setPreparing(false);
    }
  }, [preparing, refreshLocal, switching, switchToProvider]);

  const chipTitle = (() => {
    const provider = providerDisplayLabel(activeProvider, isZh);
    if (!isLocalActive) return `${provider}${currentModel?.id ? ` · ${currentModel.id}` : ''}`;
    const base = localStatus?.runtime?.base_url || 'http://127.0.0.1:18099/v1';
    return `${provider} · ${statusText} · ${base}`;
  })();

  return (
    <div ref={wrapRef} className={`provider-status-badge tone-${tone}`}>
      <button
        type="button"
        className="provider-status-chip"
        title={chipTitle}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={switching || preparing}
      >
        <span className="provider-status-icon" aria-hidden>
          <span className="provider-status-dot" />
        </span>
        <span className="provider-status-label">{providerDisplayLabel(activeProvider, isZh)}</span>
        <span className="provider-status-sep">·</span>
        <span className="provider-status-status">{statusText}</span>
      </button>
      {menuOpen && (
        <div className="provider-status-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeProvider === BRAIN_PROVIDER_ID}
            className={`provider-status-menu-item${activeProvider === BRAIN_PROVIDER_ID ? ' is-active' : ''}`}
            onClick={() => void switchToProvider(BRAIN_PROVIDER_ID)}
            disabled={switching || preparing}
          >
            <span className="provider-status-menu-dot tone-cloud" aria-hidden />
            <span>{isZh ? '默认模型' : 'Default model'}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeProvider === LOCAL_PROVIDER_ID}
            className={`provider-status-menu-item${activeProvider === LOCAL_PROVIDER_ID ? ' is-active' : ''}`}
            onClick={() => void (localReady ? switchToProvider(LOCAL_PROVIDER_ID) : prepareAndSwitchLocal())}
            disabled={switching || preparing || (!localReady && localCannotSetup)}
          >
            <span className="provider-status-menu-dot tone-local" aria-hidden />
            <span>
              {localReady
                ? (isZh ? '本地 Qwen3.8-27B' : 'Local Qwen3.8-27B')
                : localBusy
                  ? (isZh ? '本地 Qwen3.8-27B 准备中' : 'Local Qwen3.8-27B preparing')
                  : localCannotSetup
                    ? (isZh ? '本机不建议启用默认 27B' : '27B not recommended here')
                    : (isZh ? '准备并切换本地 Qwen3.8-27B' : 'Prepare and switch to Local Qwen3.8-27B')}
            </span>
          </button>
          {!localReady && (
            <div className="provider-status-menu-note">
              {!localCannotSetup
                ? (isZh
                  ? 'Lynn 会在授权后自动准备 llama.cpp、模型文件和本地端点。'
                  : 'Lynn will prepare llama.cpp, the model file, and the local endpoint after authorization.')
                : (isZh
                  ? '16GB 及以上默认安装 Coder390 Q3，16GB 以下使用 Q2。'
                  : '16GB and above installs Coder390 Q3. Below 16GB uses Q2.')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
