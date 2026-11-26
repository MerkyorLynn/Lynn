import { Fragment, useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { isChineseLocale } from '../../utils/locale';
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

/** Inline zh/en picker for developer-facing copy; follows the active locale. */
function L(zhText: string, enText: string): string {
  return isChineseLocale() ? zhText : enText;
}

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
        <div className={styles.muted}>{L('暂无记录', 'No records yet')}</div>
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
          <div className={styles.title}>{L('开发诊断面板', 'Developer diagnostics')}</div>
          <div className={styles.hint}>Cmd/Ctrl + Shift + D</div>
        </div>
        <button className={styles.close} onClick={onClose} aria-label="Close diagnostics">×</button>
      </div>

      <RecordCard
        title={L('当前链路', 'Current route')}
        data={snapshot?.current}
        fields={[
          [L('时间', 'Time'), 'at'],
          ['Provider', 'provider'],
          [L('模型 ID', 'Model ID'), 'modelId'],
          [L('模型名', 'Model name'), 'modelName'],
          [L('任务类型', 'Task type'), 'routeIntent'],
          ['Session', 'sessionPath'],
        ]}
      />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{L('启动诊断', 'Startup diagnostics')}</div>
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
          <span className={styles.meta}>{L('开始：', 'Started: ')}{formatTime(startupStartedAt)}</span>
          <span className={styles.meta}>{L('结束：', 'Finished: ')}{formatTime(startupFinishedAt)}</span>
          <span className={styles.meta}>{L('耗时：', 'Took: ')}{startupDurationMs !== null ? `${Math.round(startupDurationMs / 100) / 10}s` : '—'}</span>
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
          <div className={styles.muted}>{L('暂无启动记录', 'No startup records yet')}</div>
        )}
      </div>

      <RecordCard
        title={L('最近一次工具调用', 'Last tool call')}
        data={snapshot?.lastToolCall}
        fields={[
          [L('时间', 'Time'), 'at'],
          [L('工具', 'Tool'), 'name'],
          [L('阶段', 'Phase'), 'phase'],
          [L('成功', 'Success'), 'success'],
          ['Session', 'sessionPath'],
        ]}
      />

      <RecordCard
        title={L('最近一次 fallback', 'Last fallback')}
        data={snapshot?.lastFallback}
        fields={[
          [L('时间', 'Time'), 'at'],
          [L('原因', 'Reason'), 'reason'],
          [L('任务类型', 'Task type'), 'routeIntent'],
          ['Provider', 'provider'],
          [L('模型 ID', 'Model ID'), 'modelId'],
          ['Session', 'sessionPath'],
        ]}
      />

      <RecordCard
        title={L('最近一次 timeout / 429 / 400', 'Last timeout / 429 / 400')}
        data={snapshot?.lastProviderIssue}
        fields={[
          [L('时间', 'Time'), 'at'],
          [L('类型', 'Kind'), 'kind'],
          ['Provider', 'provider'],
          [L('模型 ID', 'Model ID'), 'modelId'],
          [L('任务类型', 'Task type'), 'routeIntent'],
          ['Session', 'sessionPath'],
        ]}
      />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{L('MCP 状态', 'MCP status')}</div>
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
          <div className={styles.muted}>{L('暂无 MCP 服务', 'No MCP servers')}</div>
        )}
      </div>
    </aside>
  );
}
