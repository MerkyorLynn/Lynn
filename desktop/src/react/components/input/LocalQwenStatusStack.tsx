import type { LocalQwen35RuntimeStatus } from './local-qwen-status';
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
  canShowInstallPrompt: boolean;
  hasModel: boolean;
  hasRuntime: boolean;
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
  onSnooze: () => void;
  onSetPanelOpen: (open: boolean) => void;
}

export function LocalQwenStatusStack(props: LocalQwenStatusStackProps) {
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
            <div className={styles['local-model-status-meta']}>
              <span>llama.cpp</span>
              {props.tpsSummary && <span>{props.tpsSummary}</span>}
              <span>{props.metricSummary}</span>
              {props.slotSummary && <span>{props.slotSummary}</span>}
              <span>{props.endpoint.replace(/^https?:\/\//, '')}</span>
            </div>
            <div className={styles['local-model-status-actions']}>
              {props.canSwitch && (
                <button type="button" onClick={props.onSwitch}>切换</button>
              )}
              <button type="button" onClick={props.onRefresh}>刷新</button>
              <button type="button" onClick={props.onOpenDashboard} aria-expanded={props.panelOpen}>状态</button>
              {props.active && <button type="button" onClick={props.onStop}>停止</button>}
              <button type="button" onClick={props.onDismiss} aria-label="收起本地模型状态">×</button>
            </div>
          </div>
          {!props.endpointOccupied && (props.coldStartLikely || (props.active && !props.running)) && (
            <div className={styles['local-model-warmup-note']} role="status" aria-live="polite">
              <strong>首次暖机提示</strong>
              <span>本地 Qwen3.5-9B 刚启动时要加载权重和预热上下文，第一问可能 10-20 秒；暖好后同一会话会明显更快。</span>
            </div>
          )}
          {props.panelOpen && (
            <div className={styles['local-model-status-panel']} role="status" aria-live="polite">
              <div className={styles['local-model-status-panel-head']}>
                <div>
                  <strong>本地 Qwen3.5-9B</strong>
                  <span>{props.endpointOccupied
                    ? '当前端口由 4B 降级/兼容端点占用，默认 9B 尚未启动'
                    : 'Q4_K_M imatrix · MTP 加速 · thinking-on 稳定性优先'}</span>
                </div>
                <button type="button" onClick={() => props.onSetPanelOpen(false)} aria-label="收起本地模型状态">×</button>
              </div>
              <div className={styles['local-model-status-panel-grid']}>
                <span><b>端点</b>{props.endpoint}</span>
                <span><b>进程</b>{props.status?.runtime?.pid ? `PID ${props.status.runtime.pid}` : props.loading ? '加载中' : '运行中'}</span>
                <span><b>速度</b>{props.tpsSummary || '等待下一次采样'}</span>
                <span><b>任务槽</b>{props.endpointOccupied ? '非默认端点' : (props.slotSummary || '可用 1/1')}</span>
                <span><b>统计</b>{props.metricSummary}</span>
                {props.endpointOccupied && (
                  <span><b>当前模型</b>{props.servedModelIds.join(', ') || '非 9B'}</span>
                )}
              </div>
              <p>{props.endpointOccupied
                ? '这不是默认 9B 引导模型。需要启用默认 9B 时，先停止当前本地端点。'
                : '退出 Lynn 时会自动停止本地模型；需要马上释放内存时点“停止”。'}</p>
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
          <strong>{props.endpointOccupied ? '4B 降级端点正在运行' : (props.running ? '本地 Qwen3.5-9B 正在运行' : '本地 Qwen3.5-9B 正在加载')}</strong>
          <span>显示状态</span>
        </button>
      )}
      {props.canShowStopped && (
        <div className={`${styles['local-model-status-bar']} ${styles['local-model-status-bar-muted']}`}>
          <div className={styles['local-model-status-left']}>
            <span className={styles['local-model-status-dot-muted']} aria-hidden="true" />
            <div className={styles['local-model-status-copy']}>
              <strong>{props.current ? '当前本地 Qwen3.5-9B 未启动' : '本地 Qwen3.5-9B 未运行'}</strong>
              <span>
                {props.current
                  ? '你已选择本地模型。点击启动后，Lynn 会拉起 llama.cpp 并继续使用当前模型。'
                  : '模型文件已就绪。点击启动后，Lynn 会自动拉起本地端点。'}
              </span>
            </div>
          </div>
          <div className={styles['local-model-status-actions']}>
            <button type="button" onClick={props.onStart}>启动</button>
            <button type="button" onClick={props.onRefresh}>刷新</button>
            <button type="button" onClick={props.onDismiss} aria-label="收起本地模型状态">×</button>
          </div>
        </div>
      )}
      {props.canShowInstallPrompt && (
        <div className={`${styles['local-model-status-bar']} ${styles['local-model-status-bar-recommend']}`}>
          <div className={styles['local-model-status-left']}>
            <span className={styles['local-model-status-dot']} aria-hidden="true" />
            <div className={styles['local-model-status-copy']}>
              <strong>可安装本地 Qwen3.5-9B</strong>
              <span>
                {props.hasModel && props.hasRuntime
                  ? '模型和 llama.cpp 已就绪，授权后即可启动本地离线端点。'
                  : 'Qwen3.5-9B Q4_K_M imatrix MTP · 5.78GB / 5.38GiB · 32K 上下文；授权后自动准备，当前模型照常保留。'}
              </span>
            </div>
          </div>
          <div className={styles['local-model-status-actions']}>
            <button type="button" onClick={props.onOpenSettings}>安装本地模型</button>
            <button type="button" onClick={props.onSnooze}>稍后</button>
          </div>
        </div>
      )}
    </>
  );
}
