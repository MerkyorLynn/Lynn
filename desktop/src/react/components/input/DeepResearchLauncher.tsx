import { useStore } from '../../stores';
import { isChineseLocale } from '../../utils/locale';

/** Inline zh/en picker for copy that ships near this module. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);
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
        const next = D('为我做一份深度调研：', 'Please do a deep research report on: ');
        if (readLatestInputValue().trim()) {
          useStore.getState().addToast?.(
            D(
              '输入框已有内容，未覆盖模板；可以直接开始深研。',
              'The composer already has text, so the template was not applied. You can start research directly.',
            ),
            'info',
            3000,
            {
                dedupeKey: 'deep-research-template-kept',
            },
          );
          requestInputFocus();
          return;
        }
        setInputValue(next);
        setComposerText(next);
        useStore.getState().addToast?.(
          D('已填入深度调研模板。', 'Deep research template inserted.'),
          'success',
          2200,
          {
            dedupeKey: 'deep-research-template-filled',
          },
        );
        requestInputFocus();
      }}
      onStart={onStart}
    />
  );
}
