import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { getWebSocket } from '../../services/websocket';
import styles from './InputArea.module.css';

const AUTO_COMPACT_THRESHOLD = 80;
const WARNING_THRESHOLD = 70;

export function ContextRing() {
  const { t } = useI18n();
  const agentYuan = useStore(s => s.agentYuan);
  const isStreaming = useStore(s => s.isStreaming);
  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const autoCompactFired = useRef(false);

  const storeContextTokens = useStore(s => s.contextTokens);
  const storeContextWindow = useStore(s => s.contextWindow);
  const storeContextPercent = useStore(s => s.contextPercent);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const storeCompacting = useStore(s => currentSessionPath ? s.compactingSessions.includes(currentSessionPath) : false);

  useEffect(() => {
    if (storeContextTokens != null) {
      setTokens(storeContextTokens);
      setContextWindow(storeContextWindow);
      setPercent(storeContextPercent);
    } else {
      setTokens(null);
      autoCompactFired.current = false;
    }
    setCompacting(storeCompacting);
  }, [storeContextTokens, storeContextWindow, storeContextPercent, storeCompacting]);

  // Auto-compact when approaching limit
  useEffect(() => {
    const pct = percent ?? 0;
    if (pct >= AUTO_COMPACT_THRESHOLD && !compacting && !autoCompactFired.current && !isStreaming) {
      autoCompactFired.current = true;
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'compact' }));
      }
    }
    if (pct < WARNING_THRESHOLD) {
      autoCompactFired.current = false;
    }
  }, [percent, compacting, isStreaming]);

  const handleClick = useCallback(() => {
    if (compacting) return;
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'compact' }));
    }
  }, [compacting]);

  const pct = percent ?? 0;
  if (tokens == null) return null;

  const r = 6;
  const sw = 2.5;
  const size = (r + sw) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(pct, 100) / 100);
  const yuan = agentYuan || 'hanako';

  const tokensK = (tokens / 1000).toFixed(1);
  const windowK = contextWindow != null ? Math.round(contextWindow / 1000) : 0;

  // Warning colors
  const isWarning = pct >= WARNING_THRESHOLD;
  const isCritical = pct >= AUTO_COMPACT_THRESHOLD;
  const ringColor = isCritical ? 'var(--coral, #da6f6f)' : isWarning ? '#d4a043' : 'var(--ring-fg)';

  return (
    <span className={styles['context-ring-wrap']}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={`${styles['context-ring']}${compacting ? ` ${styles.compacting}` : ''}${isWarning ? ` ${styles['context-ring-warning']}` : ''}`}
        data-yuan={yuan}
        onClick={handleClick}
        disabled={compacting}
        title={`${tokensK}k / ${windowK}k`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={sw} />
          <circle
            cx={center} cy={center} r={r}
            fill="none"
            stroke={ringColor}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${center} ${center})`}
            className={styles['context-ring-progress']}
          />
        </svg>
        <span className={styles['context-ring-label']}>{tokensK}k</span>
      </button>
      {hovered && (
        <div className={styles['context-ring-tooltip']}>
          <div>{tokensK}k / {windowK}k tokens ({Math.round(pct)}%)</div>
          {isWarning && !isCritical && <div style={{ color: '#d4a043' }}>{t('input.contextWarning') || 'Context getting full'}</div>}
          {isCritical && <div style={{ color: 'var(--coral, #da6f6f)' }}>{t('input.contextCritical') || 'Auto-compacting...'}</div>}
        </div>
      )}
    </span>
  );
}
