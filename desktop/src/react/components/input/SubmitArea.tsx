import { useEffect, useRef, useState, type ChangeEvent, type MutableRefObject } from 'react';
import type { ThinkingLevel } from '../../stores/model-slice';
import { ContextRing } from './ContextRing';
import { SessionCostChip } from './SessionCostChip';
import { ModelSelector } from './ModelSelector';
import { SecurityModeSelector } from './SecurityModeSelector';
import { SendButton } from './SendButton';
import { ThinkingLevelButton } from './ThinkingLevelButton';
import { WritingModeToggle } from './WritingModeToggle';
import styles from './InputArea.module.css';

interface SubmitAreaProps {
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  thinkingLevel: ThinkingLevel;
  modelXhigh: boolean;
  showThinkingControl: boolean;
  selectorModels: any[];
  isStreaming: boolean;
  localQwenRunning: boolean;
  localQwenLoading: boolean;
  showModelConfigHint: boolean;
  deepResearchOpen: boolean;
  deepResearchBusy: boolean;
  canSteer: boolean;
  canSend: boolean;
  sendDisabledTitle?: string;
  t: (key: string) => string;
  onAttachClick: () => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onVoiceClick: () => void;
  onDeepResearchToggle: () => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onOpenProvidersSettings: () => void;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}

export function SubmitArea({
  fileInputRef,
  thinkingLevel,
  modelXhigh,
  showThinkingControl,
  selectorModels,
  isStreaming,
  localQwenRunning,
  localQwenLoading,
  showModelConfigHint,
  deepResearchOpen,
  deepResearchBusy,
  canSteer,
  canSend,
  sendDisabledTitle,
  t,
  onAttachClick,
  onFileInputChange,
  onVoiceClick,
  onDeepResearchToggle,
  onThinkingLevelChange,
  onOpenProvidersSettings,
  onSend,
  onSteer,
  onStop,
}: SubmitAreaProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') setMoreOpen(false);
      if (event instanceof MouseEvent && !moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('mousedown', close);
    };
  }, [moreOpen]);

  return (
    <div className={styles['input-bottom-bar']}>
      <div className={styles['input-actions']}>
        <button type="button" className={styles['attach-btn']} onClick={onAttachClick} title={t('input.attachFileTitle') || 'Attach file'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onFileInputChange} />
        <button
          type="button"
          className={styles['attach-btn']}
          onClick={onVoiceClick}
          title={t('input.voiceChatTitle') || 'Live voice chat'}
          aria-label={t('input.voiceChatAria') || 'Open Lynn live voice chat'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
            <path d="M8 22h8" />
          </svg>
        </button>
        <div ref={moreRef} className={styles['composer-more']}>
          <button
            type="button"
            className={styles['attach-btn']}
            onClick={() => setMoreOpen((open) => !open)}
            aria-label={t('input.moreInputOptions') || 'More input options'}
            aria-expanded={moreOpen}
            title={t('input.moreInputOptions') || 'More input options'}
          >
            ⋯
          </button>
          {moreOpen && (
            <div className={styles['composer-more-menu']} role="menu" aria-label={t('input.moreInputOptions') || 'More input options'}>
              <button
                type="button"
                className={`${styles['deep-research-pill']} ${deepResearchOpen ? styles['deep-research-pill-active'] : ''}`}
                onClick={onDeepResearchToggle}
                disabled={deepResearchBusy}
                aria-pressed={deepResearchOpen}
              >
                <span className={styles['deep-research-pill-mark']}>⌁</span>
                <span>{t('input.deepResearch') || 'Deep research'}</span>
              </button>
              <SecurityModeSelector />
              <WritingModeToggle />
            </div>
          )}
        </div>
      </div>
      <div className={styles['input-controls']}>
        {showThinkingControl && (
          <ThinkingLevelButton level={thinkingLevel} onChange={onThinkingLevelChange} modelXhigh={modelXhigh} />
        )}
        <ContextRing />
        <SessionCostChip />
        <div className={styles['send-controls']}>
          <ModelSelector
            models={selectorModels}
            disabled={isStreaming}
            localQwenRunning={localQwenRunning}
            localQwenLoading={localQwenLoading}
          />
          {showModelConfigHint && (
            <button
              type="button"
              className={styles['model-upgrade-btn']}
              onClick={onOpenProvidersSettings}
              title={t('input.embeddedModel.upgradeTitle')}
            >
              <span className={styles['model-upgrade-icon']}>✦</span>
              <span className={styles['model-upgrade-copy']}>
                <span className={styles['model-upgrade-title']}>{t('input.embeddedModel.upgrade')}</span>
                <span className={styles['model-upgrade-subtitle']}>{t('input.embeddedModel.hint')}</span>
              </span>
            </button>
          )}
          <SendButton
            isStreaming={isStreaming}
            canSteer={canSteer}
            disabled={isStreaming ? false : !canSend}
            title={sendDisabledTitle}
            onSend={onSend}
            onSteer={onSteer}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
}
