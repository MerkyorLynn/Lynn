import type { LocalQwen35RuntimeStatus } from './local-qwen-status';
import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export interface LocalQwenStatusStackProps {
  status: LocalQwen35RuntimeStatus | null;
  visible: boolean;
  active: boolean;
  dismissed: boolean;
  panelOpen: boolean;
  statusBarClass: string;
  warmupTitle: string;
  warmupCopy: string;
  endpoint: string;
  endpointOccupied: boolean;
  running: boolean;
  loading: boolean;
  current: boolean;
  coldStartLikely: boolean;
  canSwitch: boolean;
  canShowStopped: boolean;
  tpsSummary: string | null;
  metricSummary: string;
  slotSummary: string | null;
  servedModelIds: string[];
  onSwitch: () => void;
  onRefresh: () => void;
  onOpenDashboard: () => void;
  onStop: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onStart: () => void;
  onOpenSettings: () => void;
  onSetPanelOpen: (open: boolean) => void;
}

export function LocalQwenStatusStack(props: LocalQwenStatusStackProps) {
  // Localise inline copy and re-render when the user switches language.
  const { locale } = useI18n();
  const zh = String(locale || '').toLowerCase().startsWith('zh');
  const L = (zhText: string, enText: string) => (zh ? zhText : enText);
  return (
    <>
      {props.visible && (
        <div className={styles['local-model-status-stack']}>
          <div className={props.statusBarClass}>
            <div className={styles['local-model-status-left']}>
              <span className={styles['local-model-status-dot']} aria-hidden="true" />
              <div className={styles['local-model-status-copy']}>
                <strong>{props.warmupTitle}</strong>
                <span>{props.warmupCopy}</span>
              </div>
            </div>
            <div className={styles['local-model-status-actions']}>
              {props.canSwitch && (
                <button type="button" onClick={props.onSwitch}>{L('切换', 'Switch')}</button>
              )}
              <button type="button" onClick={props.onRefresh}>{L('刷新', 'Refresh')}</button>
              <button type="button" onClick={props.onOpenDashboard} aria-expanded={props.panelOpen}>{L('状态', 'Status')}</button>
              {props.active && <button type="button" onClick={props.onStop}>{L('停止', 'Stop')}</button>}
              <button type="button" onClick={props.onDismiss} aria-label={L('收起本地模型状态', 'Collapse local model status')}>×</button>
            </div>
          </div>
          {!props.endpointOccupied && (props.coldStartLikely || (props.active && !props.running)) && (
            <div className={styles['local-model-warmup-note']} role="status" aria-live="polite">
              <strong>{L('首次暖机提示', 'First-run warm-up')}</strong>
              <span>
                {L(
                  '本地 Qwen3.8-27B 刚启动时要加载权重和预热上下文，第一问可能更慢；后续速度取决于设备和上下文长度。',
                  'Local Qwen3.8-27B loads weights and warms up its context right after starting, so the first question can be slower. Later speed depends on the device and context length.',
                )}
              </span>
            </div>
          )}
          {props.panelOpen && (
            <div className={styles['local-model-status-panel']} role="status" aria-live="polite">
              <div className={styles['local-model-status-panel-head']}>
                <div>
                  <strong>{L('本地 Qwen3.8-27B', 'Local Qwen3.8-27B')}</strong>
                  <span>{props.endpointOccupied
                    ? L('当前端口由降级/兼容端点占用，默认 27B 尚未启动', 'This port is used by a fallback/compatible endpoint; the default 27B is not running yet')
                    : L('Q4 imatrix · MTP 加速 · 端侧默认推荐', 'Q4 imatrix · MTP accelerated · recommended for on-device')}</span>
                </div>
                <button type="button" onClick={() => props.onSetPanelOpen(false)} aria-label={L('收起本地模型状态', 'Collapse local model status')}>×</button>
              </div>
              <details>
                <summary>{L('诊断详情', 'Diagnostics')}</summary>
                <div className={styles['local-model-status-panel-grid']}>
                  <span><b>{L('端点', 'Endpoint')}</b>{props.endpoint}</span>
                  <span><b>{L('进程', 'Process')}</b>{props.status?.runtime?.pid ? `PID ${props.status.runtime.pid}` : props.loading ? L('加载中', 'Loading') : L('运行中', 'Running')}</span>
                  <span><b>{L('速度', 'Speed')}</b>{props.tpsSummary || L('等待下一次采样', 'Waiting for the next sample')}</span>
                  <span><b>{L('任务槽', 'Slots')}</b>{props.endpointOccupied ? L('非默认端点', 'non-default endpoint') : (props.slotSummary || L('可用 1/1', 'Available 1/1'))}</span>
                  <span><b>{L('统计', 'Stats')}</b>{props.metricSummary}</span>
                  {props.endpointOccupied && (
                    <span><b>{L('当前模型', 'Current model')}</b>{props.servedModelIds.join(', ') || L('非 27B', 'not 27B')}</span>
                  )}
                </div>
              </details>
              <p>{props.endpointOccupied
                ? L('这不是默认 27B 引导模型。需要启用默认 27B 时，先停止当前本地端点。', 'This is not the default 27B bootstrap model. Stop the current local endpoint first to enable the default 27B.')
                : L('退出 Lynn 时会自动停止本地模型；需要马上释放内存时点“停止”。', 'Quitting Lynn stops the local model automatically; use Stop when you need the memory back right away.')}</p>
            </div>
          )}
        </div>
      )}
      {props.active && props.dismissed && (
        <button
          type="button"
          className={styles['local-model-status-restore']}
          onClick={props.onRestore}
        >
          <span className={styles['local-model-status-dot']} aria-hidden="true" />
          <strong>{props.endpointOccupied
            ? L('其他模型端点正在运行', 'Another model endpoint is running')
            : (props.running ? L('本地 Qwen3.8-27B 正在运行', 'Local Qwen3.8-27B is running') : L('本地 Qwen3.8-27B 正在加载', 'Local Qwen3.8-27B is loading'))}</strong>
          <span>{L('显示状态', 'Show status')}</span>
        </button>
      )}
      {props.canShowStopped && (
        <div className={`${styles['local-model-status-bar']} ${styles['local-model-status-bar-muted']}`}>
          <div className={styles['local-model-status-left']}>
            <span className={styles['local-model-status-dot-muted']} aria-hidden="true" />
            <div className={styles['local-model-status-copy']}>
              <strong>{props.current ? L('当前本地 Qwen3.8-27B 未启动', 'The selected local Qwen3.8-27B is not started') : L('本地 Qwen3.8-27B 未运行', 'Local Qwen3.8-27B is not running')}</strong>
              <span>
                {props.current
                  ? L('你已选择本地模型。点击启动后，Lynn 会拉起 llama.cpp 并继续使用当前模型。', 'You have selected the local model. After you press Start, Lynn brings up llama.cpp and keeps using that model.')
                  : L('模型文件已就绪。点击启动后，Lynn 会自动拉起本地端点。', 'The model files are ready. After you press Start, Lynn brings the local endpoint up automatically.')}
              </span>
            </div>
          </div>
          <div className={styles['local-model-status-actions']}>
            <button type="button" onClick={props.onStart}>{L('启动', 'Start')}</button>
            <button type="button" onClick={props.onRefresh}>{L('刷新', 'Refresh')}</button>
            <button type="button" onClick={props.onDismiss} aria-label={L('收起本地模型状态', 'Collapse local model status')}>×</button>
          </div>
        </div>
      )}

    </>
  );
}
