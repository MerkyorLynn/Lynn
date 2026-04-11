import { Fragment, useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import styles from './DiagnosticsPanel.module.css';

type DiagnosticRecord = {
  at?: string | null;
  [key: string]: unknown;
};

type McpState = {
  name: string;
  label?: string;
  transport?: string;
  connected?: boolean;
  builtin?: boolean;
  toolCount?: number;
  error?: string | null;
};

type RuntimeDiagnostics = {
  current?: DiagnosticRecord | null;
  lastToolCall?: DiagnosticRecord | null;
  lastFallback?: DiagnosticRecord | null;
  lastProviderIssue?: DiagnosticRecord | null;
  mcp?: McpState[];
};

function formatTime(value: unknown): string {
  if (!value || typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function DetailGrid({ data, fields }: { data?: DiagnosticRecord | null; fields: Array<[string, string]> }) {
  return (
    <div className={styles.grid}>
      {fields.map(([label, key]) => (
        <Fragment key={key}>
          <div className={styles.label}>{label}</div>
          <div className={`${styles.value}${!data?.[key] ? ` ${styles.muted}` : ''}`}>
            {key === 'at' ? formatTime(data?.[key]) : renderValue(data?.[key])}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function RecordCard({ title, data, fields }: { title: string; data?: DiagnosticRecord | null; fields: Array<[string, string]> }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {data ? (
        <>
          <DetailGrid data={data} fields={fields} />
          {'message' in data && data.message ? (
            <div className={styles.mono} style={{ marginTop: 8 }}>{renderValue(data.message)}</div>
          ) : null}
        </>
      ) : (
        <div className={styles.muted}>暂无记录</div>
      )}
    </div>
  );
}

export function DiagnosticsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<RuntimeDiagnostics | null>(null);
  const startupPhase = useStore((state) => state.startupPhase);
  const startupStartedAt = useStore((state) => state.startupStartedAt);
  const startupFinishedAt = useStore((state) => state.startupFinishedAt);
  const startupSteps = useStore((state) => state.startupSteps);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    const load = async () => {
      try {
        const res = await hanaFetch('/api/debug/runtime');
        const data = await res.json();
        if (!cancelled) setSnapshot(data);
      } catch {
        if (!cancelled) setSnapshot(null);
      }
    };

    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const mcpStates = Array.isArray(snapshot?.mcp) ? snapshot!.mcp! : [];
  const startupDurationMs = startupStartedAt
    ? Math.max(
        0,
        new Date(startupFinishedAt || new Date().toISOString()).getTime() - new Date(startupStartedAt).getTime(),
      )
    : null;

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>开发诊断面板</div>
          <div className={styles.hint}>Cmd/Ctrl + Shift + D</div>
        </div>
        <button className={styles.close} onClick={onClose} aria-label="Close diagnostics">×</button>
      </div>

      <RecordCard
        title="当前链路"
        data={snapshot?.current}
        fields={[
          ['时间', 'at'],
          ['Provider', 'provider'],
          ['模型 ID', 'modelId'],
          ['模型名', 'modelName'],
          ['任务类型', 'routeIntent'],
          ['Session', 'sessionPath'],
        ]}
      />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>启动诊断</div>
        <div className={styles.startupSummary}>
          <span
            className={`${styles.pill} ${
              startupPhase === 'ready'
                ? styles.pillOk
                : startupPhase === 'degraded'
                  ? styles.pillWarn
                  : startupPhase === 'running'
                    ? styles.pillRunning
                    : ''
            }`}
          >
            {startupPhase}
          </span>
          <span className={styles.meta}>开始：{formatTime(startupStartedAt)}</span>
          <span className={styles.meta}>结束：{formatTime(startupFinishedAt)}</span>
          <span className={styles.meta}>耗时：{startupDurationMs !== null ? `${Math.round(startupDurationMs / 100) / 10}s` : '—'}</span>
        </div>
        {startupSteps.length > 0 ? (
          <div className={styles.timeline}>
            {startupSteps.map((step) => (
              <div key={step.id} className={styles.timelineItem}>
                <div
                  className={`${styles.timelineDot} ${
                    step.status === 'success'
                      ? styles.timelineDotOk
                      : step.status === 'warning'
                        ? styles.timelineDotWarn
                        : step.status === 'error'
                          ? styles.timelineDotErr
                          : styles.timelineDotRunning
                  }`}
                />
                <div className={styles.timelineBody}>
                  <div className={styles.timelineHead}>
                    <div className={styles.listItemTitle}>{step.label}</div>
                    <div className={styles.meta}>{formatTime(step.at)}</div>
                  </div>
                  <div className={styles.pillRow}>
                    <span
                      className={`${styles.pill} ${
                        step.status === 'success'
                          ? styles.pillOk
                          : step.status === 'warning'
                            ? styles.pillWarn
                            : step.status === 'error'
                              ? styles.pillErr
                              : styles.pillRunning
                      }`}
                    >
                      {step.status}
                    </span>
                    {step.detail ? <span className={styles.meta}>{step.detail}</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.muted}>暂无启动记录</div>
        )}
      </div>

      <RecordCard
        title="最近一次工具调用"
        data={snapshot?.lastToolCall}
        fields={[
          ['时间', 'at'],
          ['工具', 'name'],
          ['阶段', 'phase'],
          ['成功', 'success'],
          ['Session', 'sessionPath'],
        ]}
      />

      <RecordCard
        title="最近一次 fallback"
        data={snapshot?.lastFallback}
        fields={[
          ['时间', 'at'],
          ['原因', 'reason'],
          ['任务类型', 'routeIntent'],
          ['Provider', 'provider'],
          ['模型 ID', 'modelId'],
          ['Session', 'sessionPath'],
        ]}
      />

      <RecordCard
        title="最近一次 timeout / 429 / 400"
        data={snapshot?.lastProviderIssue}
        fields={[
          ['时间', 'at'],
          ['类型', 'kind'],
          ['Provider', 'provider'],
          ['模型 ID', 'modelId'],
          ['任务类型', 'routeIntent'],
          ['Session', 'sessionPath'],
        ]}
      />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>MCP 状态</div>
        {mcpStates.length > 0 ? (
          <div className={styles.list}>
            {mcpStates.map((server) => (
              <div key={server.name} className={styles.listItem}>
                <div className={styles.listItemTitle}>{server.label || server.name}</div>
                <div className={styles.meta}>{server.name} · {server.transport || 'unknown'} · tools {Number(server.toolCount || 0)}</div>
                <div className={styles.pillRow}>
                  <span className={`${styles.pill} ${server.connected ? styles.pillOk : styles.pillErr}`}>
                    {server.connected ? 'connected' : 'disconnected'}
                  </span>
                  {server.builtin ? <span className={styles.pill}>builtin</span> : null}
                  {server.error ? <span className={`${styles.pill} ${styles.pillErr}`}>{server.error}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.muted}>暂无 MCP 服务</div>
        )}
      </div>
    </aside>
  );
}
