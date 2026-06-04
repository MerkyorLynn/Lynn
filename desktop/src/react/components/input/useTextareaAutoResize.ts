import { useEffect, type RefObject } from 'react';

export function useTextareaAutoResize({
  inputValue,
  isComposing,
  textareaRef,
}: {
  inputValue: string;
  isComposing: RefObject<boolean>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // IME 组合态不要 resize，避免中文输入法候选框飞到左下角。
    if (isComposing.current) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputValue, isComposing, textareaRef]);
}
