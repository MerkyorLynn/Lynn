import { useMemo } from 'react';
import { useStore } from '../stores';
import { connectWebSocket } from '../services/websocket';
import { isDisplayDefaultModel } from '../utils/brain-models';
import { getBrainComplianceNote } from '../../../../shared/brain-provider.js';
import styles from './StatusBar.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

function formatModelTag(kind: string, model: { id: string; provider: string } | null): string | null {
  if (!model?.id) return null;
  if (isDisplayDefaultModel(model.id, model.provider)) {
    return `${kind} 默认模型 · 已备案`;
  }
  const ref = model.provider ? `${model.provider}/${model.id}` : model.id;
  return `${kind} ${ref}`;
}

export function StatusBar() {
  const wsState = useStore((s) => s.wsState);
  const attempt = useStore((s) => s.wsReconnectAttempt);
  const currentModel = useStore((s) => s.currentModel);
  const utilityModel = useStore((s) => s.utilityModel);
  const utilityLargeModel = useStore((s) => s.utilityLargeModel);

  const meta = useMemo(() => {
    const parts: string[] = [];
    const chat = formatModelTag('chat', currentModel);
    const tool = formatModelTag('tool', utilityModel);
    const large = formatModelTag('large', utilityLargeModel);

    if (chat) parts.push(chat);
    if (tool) parts.push(tool);
    if (large) parts.push(large);

    return parts;
  }, [currentModel, utilityModel, utilityLargeModel]);

  if (wsState === 'connected' && meta.length === 0) return null;

  return (
    <div className={styles.bar}>
      {meta.length > 0 && (
        <div className={styles.metaRow}>
          {meta.map((item) => (
            <span
              key={item}
              className={styles.metaChip}
              title={item.includes('默认模型') ? getBrainComplianceNote() : item}
            >
              {item}
            </span>
          ))}
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
