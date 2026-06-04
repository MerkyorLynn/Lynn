import type { SlashCommand } from '../InputArea';
import { LocalQwenStatusStack } from './LocalQwenStatusStack';
import type { LocalQwenStatusController } from './useLocalQwenStatusController';
import styles from './InputArea.module.css';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface InputStatusBarsProps {
  compacting: boolean;
  inlineError: string | null;
  inlineNotice: string | null;
  localQwen: LocalQwenStatusController;
  onOpenActivity: () => void;
  onReconnect: () => void;
  onRestoreLastDraft: () => void;
  recoverableDraft: unknown;
  recoveryMessage: string | null;
  slashBusy: string | null;
  slashCommands: SlashCommand[];
  slashResult: { text: string; type: 'success' | 'error' } | null;
  t: Translate;
  taskRecoveryMessage: string | null;
  translatedInlineNotice: string | null;
  wsState: string;
}

export function InputStatusBars({
  compacting,
  inlineError,
  inlineNotice,
  localQwen,
  onOpenActivity,
  onReconnect,
  onRestoreLastDraft,
  recoverableDraft,
  recoveryMessage,
  slashBusy,
  slashCommands,
  slashResult,
  t,
  taskRecoveryMessage,
  translatedInlineNotice,
  wsState,
}: InputStatusBarsProps) {
  return (
    <>
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}</span>
        </div>
      )}
      {compacting && (
        <div className={`${styles['slash-busy-bar']} ${styles['slash-busy-bar-soft']}`}>
          <span className={styles['slash-busy-dot']} />
          <span>{t('chat.compacting')}，输入会保留；完成后可继续发送</span>
        </div>
      )}
      {recoveryMessage && (
        <div className={styles['connection-recovery-bar']}>
          <span>{recoveryMessage}</span>
          <div className={styles['recovery-actions']}>
            {!!recoverableDraft && (
              <button className={styles['recovery-action']} onClick={onRestoreLastDraft}>
                {t('input.restoreDraft') || '恢复草稿'}
              </button>
            )}
            {wsState !== 'connected' && (
              <button className={styles['recovery-action']} onClick={onReconnect}>
                {t('status.reconnect')}
              </button>
            )}
          </div>
        </div>
      )}
      {!recoveryMessage && taskRecoveryMessage && (
        <div className={styles['connection-recovery-bar']}>
          <span>{taskRecoveryMessage}</span>
          <div className={styles['recovery-actions']}>
            <button className={styles['recovery-action']} onClick={onOpenActivity}>
              {t('activity.openRecoveredTasks')}
            </button>
          </div>
        </div>
      )}
      {translatedInlineNotice && !recoveryMessage && !taskRecoveryMessage && (
        <div className={styles['slash-notice-bar']}>
          <span className={styles['slash-notice-dot']} />
          <span>{translatedInlineNotice}</span>
        </div>
      )}
      {inlineError && !recoverableDraft && (
        <div className={styles['slash-error-bar']}>
          <span className={styles['slash-error-dot']} />
          <span>{inlineError}</span>
        </div>
      )}
      {!slashBusy && !compacting && !inlineError && !inlineNotice && slashResult && (
        <div className={styles['slash-busy-bar']}><span>{slashResult.text}</span></div>
      )}
      <LocalQwenStatusStack
        status={localQwen.status}
        visible={localQwen.visible}
        active={localQwen.active}
        dismissed={localQwen.dismissed}
        panelOpen={localQwen.panelOpen}
        statusBarClass={localQwen.statusBarClass}
        warmupTitle={localQwen.warmupTitle}
        warmupCopy={localQwen.warmupCopy}
        endpoint={localQwen.endpoint}
        endpointOccupied={localQwen.endpointOccupied}
        running={localQwen.running}
        loading={localQwen.loading}
        current={localQwen.current}
        coldStartLikely={localQwen.coldStartLikely}
        canSwitch={localQwen.canSwitch}
        canShowStopped={localQwen.canShowStopped}
        canShowInstallPrompt={localQwen.canShowInstallPrompt}
        hasModel={localQwen.hasModel}
        hasRuntime={localQwen.hasRuntime}
        tpsSummary={localQwen.tpsSummary}
        metricSummary={localQwen.metricSummary}
        slotSummary={localQwen.slotSummary}
        servedModelIds={localQwen.servedModelIds}
        onSwitch={localQwen.switchToLocal}
        onRefresh={() => localQwen.refresh(true)}
        onOpenDashboard={localQwen.openDashboard}
        onStop={localQwen.stop}
        onDismiss={localQwen.dismiss}
        onRestore={localQwen.showStatus}
        onStart={localQwen.start}
        onOpenSettings={localQwen.openSettings}
        onSnooze={localQwen.snoozePrompt}
        onSetPanelOpen={localQwen.setPanelOpen}
      />
    </>
  );
}
