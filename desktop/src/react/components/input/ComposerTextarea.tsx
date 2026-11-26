import type { ClipboardEvent, KeyboardEvent, MutableRefObject } from 'react';
import styles from './InputArea.module.css';

interface ComposerTextareaProps {
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  isComposing: MutableRefObject<boolean>;
  value: string;
  placeholder: string;
  inputLargeSummary: string | null;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocusChange: (focused: boolean) => void;
  onCompositionValue: (value: string) => void;
}

export function ComposerTextarea({
  textareaRef,
  isComposing,
  value,
  placeholder,
  inputLargeSummary,
  onChange,
  onKeyDown,
  onPaste,
  onFocusChange,
  onCompositionValue,
}: ComposerTextareaProps) {
  return (
    <>
      <textarea
        ref={textareaRef}
        id="inputBox"
        className={styles['input-box']}
        placeholder={placeholder}
        aria-label={window.t?.('input.composerAria') || 'Message input'}
        rows={1}
        spellCheck={false}
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onCompositionStart={() => {
          isComposing.current = true;
        }}
        onCompositionEnd={(event) => {
          isComposing.current = false;
          const next = event.currentTarget.value;
          onCompositionValue(next);
          // 组合事件结束的同一 tick 里继续改 textarea 布局，macOS IME
          // 偶发会把候选窗坐标缓存成屏幕左下角。延后一帧再补高度。
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el || isComposing.current) return;
            el.style.height = 'auto';
            el.style.height = Math.min(Math.max(el.scrollHeight, 34), 120) + 'px';
          });
        }}
      />
      {inputLargeSummary && (
        <div
          className={styles['input-large-summary']}
          title={window.t?.('input.longTextKeptHint') || 'The full input is kept and will be sent in full'}
        >
          <span className={styles['input-large-summary-dot']} />
          <span>{window.t?.('input.longTextLoaded') || 'Long text loaded'}</span>
          <strong>{inputLargeSummary}</strong>
        </div>
      )}
    </>
  );
}
