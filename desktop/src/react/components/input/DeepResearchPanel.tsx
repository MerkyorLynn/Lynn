import styles from './InputArea.module.css';

interface DeepResearchPanelProps {
  busy: boolean;
  isStreaming: boolean;
  onClose: () => void;
  onFillTemplate: () => void;
  onStart: () => void;
}

export function DeepResearchPanel({
  busy,
  isStreaming,
  onClose,
  onFillTemplate,
  onStart,
}: DeepResearchPanelProps) {
  return (
    <div className={styles['deep-research-card']}>
      <div className={styles['deep-research-orb']} aria-hidden="true">
        <span />
      </div>
      <div className={styles['deep-research-copy']}>
        <strong>Deep Research</strong>
        <span>适合长调研、竞品梳理、报告初稿。会并行生成多份候选答案，再用 verifier 做质量地板拦截。</span>
      </div>
      <div className={styles['deep-research-actions']}>
        <button
          type="button"
          className={styles['deep-research-example']}
          onClick={onFillTemplate}
        >
          填入模板
        </button>
        <button
          type="button"
          className={styles['deep-research-start']}
          onClick={onStart}
          disabled={busy || isStreaming}
        >
          {busy ? '深研中…' : '开始深研'}
        </button>
        <button
          type="button"
          className={styles['deep-research-close']}
          onClick={onClose}
          aria-label="关闭 Deep Research 引导"
          title="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}
