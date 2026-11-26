import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { connectWebSocket } from '../services/websocket';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { isDisplayDefaultModel } from '../utils/brain-models';
import { brainComplianceNote } from '../utils/brain-models';
import { getUserFacingModelAlias } from '../../../../shared/assistant-role-models.js';
import styles from './StatusBar.module.css';
import { useI18n } from '../hooks/use-i18n';

declare function t(key: string, vars?: Record<string, string | number>): string;

const LOCAL_QWEN_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
const LOCAL_QWEN_MODEL_ID = 'qwen38-27b-coder390-q3-lynnstyle';

type LocalQwenStatus = {
  runtime?: {
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
      predicted_tps?: number | null;
      tps_window_seconds?: number | null;
    } | null;
  } | null;
  plan?: {
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
    } | null;
  } | null;
};

function isLocalQwenModel(model: { id: string; provider: string } | null): boolean {
  return model?.provider === LOCAL_QWEN_PROVIDER_ID && (model.id === LOCAL_QWEN_MODEL_ID || model.id === 'qwen38-27b-efficientthink-q2-lynnstyle');
}

function formatTps(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} tok/s`;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function formatLocalQwenTag(status: LocalQwenStatus | null, translate: Translate): string {
  const endpointRunning = status?.runtime?.endpoint_running === true
    || status?.plan?.observed?.endpoint_running === true;
  const endpointLoading = !endpointRunning && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
  );
  if (endpointRunning) {
    const promptTokens = Number(status?.runtime?.metrics?.prompt_tokens_total || 0);
    const predictedTokens = Number(status?.runtime?.metrics?.predicted_tokens_total || 0);
    const totalTokens = Math.round(promptTokens + predictedTokens);
    const tps = formatTps(status?.runtime?.metrics?.predicted_tps);
    const parts = [translate('status.model.localRunning')];
    if (tps) parts.push(translate('status.model.currentSpeed', { speed: tps }));
    if (totalTokens > 0) parts.push(translate('status.model.totalTokens', { tokens: totalTokens.toLocaleString() }));
    return parts.join(' · ');
  }
  if (endpointLoading) return translate('status.model.localLoading');
  return translate('status.model.localSelected');
}

function formatModelTag(
  kind: string,
  model: { id: string; provider: string } | null,
  role?: string | null,
  purpose?: 'chat' | 'utility' | 'utility_large',
  localQwenStatus?: LocalQwenStatus | null,
  translate: Translate = t,
): string | null {
  if (!model?.id) return null;
  if (isLocalQwenModel(model)) {
    return formatLocalQwenTag(localQwenStatus || null, translate);
  }
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider,
    role,
    purpose,
  });
  if (alias) {
    return translate('status.model.ready', { kind, model: alias });
  }
  if (isDisplayDefaultModel(model.id, model.provider)) {
    return translate('status.model.default', { kind });
  }
  const ref = model.provider ? `${model.provider}/${model.id}` : model.id;
  return `${kind} ${ref}`;
}

export function StatusBar() {
  const { t: translate } = useI18n();
  const wsState = useStore((s) => s.wsState);
  const attempt = useStore((s) => s.wsReconnectAttempt);
  const currentModel = useStore((s) => s.currentModel);
  const utilityModel = useStore((s) => s.utilityModel);
  const utilityLargeModel = useStore((s) => s.utilityLargeModel);
  const agentYuan = useStore((s) => s.agentYuan) || 'lynn';
  const [localQwenStatus, setLocalQwenStatus] = useState<LocalQwenStatus | null>(null);
  const showLocalQwenRuntime = isLocalQwenModel(currentModel)
    || isLocalQwenModel(utilityModel)
    || isLocalQwenModel(utilityLargeModel);

  useEffect(() => {
    if (!showLocalQwenRuntime) {
      setLocalQwenStatus(null);
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 8000 });
        const data = await res.json();
        if (!cancelled) setLocalQwenStatus(data);
      } catch {
        // Keep the last known state. The status chip should never flicker to a false offline state.
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showLocalQwenRuntime]);

  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const sessionUsageMap = useStore((s) => s.sessionUsage);

  const meta = useMemo(() => {
    const parts: string[] = [];
    const chat = formatModelTag('chat', currentModel, agentYuan, 'chat', localQwenStatus, translate);
    const tool = formatModelTag('tool', utilityModel, agentYuan, 'utility', localQwenStatus, translate);
    const large = formatModelTag('large', utilityLargeModel, agentYuan, 'utility_large', localQwenStatus, translate);

    if (chat) parts.push(chat);
    if (tool) parts.push(tool);
    if (large) parts.push(large);

    return parts;
  }, [agentYuan, currentModel, localQwenStatus, translate, utilityModel, utilityLargeModel]);

  // 会话成本(StepFun 一条龙:全 token 云计费)。来自 usage-slice 的去重累计。
  const usageChip = useMemo(() => {
    const u = currentSessionPath ? sessionUsageMap[currentSessionPath] : undefined;
    if (!u || u.totalTokens <= 0) return null;
    const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));
    const cachePct = u.input > 0 ? Math.round((u.cacheRead / u.input) * 100) : 0;
    const cost = u.costTotal > 0 ? ` · $${u.costTotal >= 0.1 ? u.costTotal.toFixed(2) : u.costTotal.toFixed(4)}` : '';
    return `Σ ${fmt(u.totalTokens)} tok (in ${fmt(u.input)} · out ${fmt(u.output)}) · ${translate('status.usage.cache')} ${cachePct}%${cost}`;
  }, [currentSessionPath, sessionUsageMap, translate]);

  if (wsState === 'connected' && meta.length === 0 && !usageChip) return null;

  return (
    <div className={styles.bar}>
      {(meta.length > 0 || usageChip) && (
        <div className={styles.metaRow}>
          {meta.map((item) => (
            <span
              key={item}
              className={styles.metaChip}
              title={item.includes(translate('status.model.defaultName')) ? brainComplianceNote() : item}
            >
              {item}
            </span>
          ))}
          {usageChip && (
            <span
              className={styles.metaChip}
              title={(() => { const v = t('status.usage.tip'); return v && v !== 'status.usage.tip' ? v : '本会话累计云端 token 消耗(含前缀缓存命中与费用估算)'; })()}
            >
              {usageChip}
            </span>
          )}
        </div>
      )}
      {wsState === 'reconnecting' && (
        <span className={styles.text}>{t('status.reconnecting')} ({attempt})</span>
      )}
      {wsState === 'disconnected' && (
        <>
          <span className={styles.text}>{t('status.disconnected')}</span>
          <button className={styles.reconnect} onClick={() => connectWebSocket()}>
            {t('status.reconnect')}
          </button>
        </>
      )}
    </div>
  );
}
