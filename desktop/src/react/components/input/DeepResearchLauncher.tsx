import { useStore } from '../../stores';
import { DeepResearchPanel } from './DeepResearchPanel';

export function DeepResearchLauncher({
  busy,
  inlineError,
  isStreaming,
  onClose,
  onStart,
  readLatestInputValue,
  recoveryMessage,
  requestInputFocus,
  setComposerText,
  setInputValue,
  taskRecoveryMessage,
  visible,
}: {
  busy: boolean;
  inlineError: string | null;
  isStreaming: boolean;
  onClose: () => void;
  onStart: () => void | Promise<void>;
  readLatestInputValue: () => string;
  recoveryMessage: string | null;
  requestInputFocus: () => void;
  setComposerText: (text: string) => void;
  setInputValue: (text: string) => void;
  taskRecoveryMessage: string | null;
  visible: boolean;
}) {
  if (!visible || recoveryMessage || taskRecoveryMessage || inlineError) return null;

  return (
    <DeepResearchPanel
      busy={busy}
      isStreaming={isStreaming}
      onClose={onClose}
      onFillTemplate={() => {
        const next = '为我做一份深度调研：';
        if (readLatestInputValue().trim()) {
          useStore.getState().addToast?.('输入框已有内容，未覆盖模板；可以直接开始深研。', 'info', 3000, {
            dedupeKey: 'deep-research-template-kept',
          });
          requestInputFocus();
          return;
        }
        setInputValue(next);
        setComposerText(next);
        useStore.getState().addToast?.('已填入深度调研模板。', 'success', 2200, {
          dedupeKey: 'deep-research-template-filled',
        });
        requestInputFocus();
      }}
      onStart={onStart}
    />
  );
}
