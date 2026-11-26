import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TRANSLATION_TARGETS, translationTargetLabel } from './AssistantMessage.helpers';
import { useI18n } from '../../hooks/use-i18n';
import styles from './Chat.module.css';

export function TranslationMenu({ busy, disabled, onTranslate }: {
  busy: boolean;
  disabled: boolean;
  onTranslate: (language: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const element = menu.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(position.top, window.innerHeight - rect.height - 8))}px`;
      element.querySelector<HTMLButtonElement>('button')?.focus();
    }
    const close = () => setPosition(null);
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position]);

  const busyLabel = t('chat.translating') || 'Translating';
  const moreLabel = t('chat.moreMessageActions') || 'More message actions';
  const menuLabel = t('chat.translateReply') || 'Translate reply';

  return <>
    <button ref={trigger} type="button" className={styles.msgCopyBtn} disabled={busy || disabled}
      title={busy ? busyLabel : moreLabel} aria-label={busy ? busyLabel : moreLabel}
      aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined}
      onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition(position ? null : { left: Math.max(8, Math.min(rect.right - 168, window.innerWidth - 176)), top: rect.bottom + 6 });
      }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
      </svg>
    </button>
    {position && createPortal(
      <div id={id} ref={menu} role="menu" aria-label={menuLabel} className={styles.translationMenu} style={position}
        onKeyDown={event => {
          const buttons = Array.from(menu.current?.querySelectorAll('button') || []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'Escape') { event.preventDefault(); setPosition(null); trigger.current?.focus(); }
          if (event.key === 'Tab') setPosition(null);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }}>
        <span className={styles.translationMenuLabel}>{menuLabel}</span>
        {TRANSLATION_TARGETS.map(language => <button type="button" role="menuitem" key={language}
          onClick={() => { setPosition(null); trigger.current?.focus(); void onTranslate(translationTargetLabel(language, locale)); }}>
          {(t('chat.translateTo', { language: translationTargetLabel(language, locale) }) || `Translate to ${translationTargetLabel(language, locale)}`)}
        </button>)}
      </div>, document.body,
    )}
  </>;
}
