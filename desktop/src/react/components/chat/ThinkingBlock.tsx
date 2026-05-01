/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback, useEffect, useRef, type MouseEvent } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
}

const MAX_THINKING_TRANSLATE_CHARS = 3_000;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const t = window.t ?? ((p: string) => p);
  // Keep raw provider thinking opt-in. Some providers stream internal thoughts in
  // English, so default-collapsing prevents that text from reading like the answer.
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null);
  const open = explicitOpen ?? false;
  const [elapsed, setElapsed] = useState(0);
  const [translated, setTranslated] = useState<string | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const startRef = useRef(Date.now());
  const toggle = useCallback(() => setExplicitOpen(v => !(v ?? false)), []);
  const shouldOfferTranslate = sealed && /[A-Za-z]{4,}/.test(content || "");

  useEffect(() => {
    if (sealed) return;
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [sealed]);

  useEffect(() => {
    if (sealed) setExplicitOpen(false);
  }, [sealed]);

  useEffect(() => {
    setTranslated(null);
    setTranslateError(null);
  }, [content]);

  const elapsedLabel = !sealed && elapsed >= 2000 ? ` (${formatElapsed(elapsed)})` : '';

  const handleTranslateThinking = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!content || translateBusy) return;
    if (!sealed) {
      setTranslateError('思考完成后再翻译。');
      return;
    }
    if (content.length > MAX_THINKING_TRANSLATE_CHARS) {
      setTranslateError(`思考内容超过 ${MAX_THINKING_TRANSLATE_CHARS} 字，请先复制需要的片段再翻译。`);
      setExplicitOpen(true);
      return;
    }
    setTranslateBusy(true);
    setTranslateError(null);
    setExplicitOpen(true);
    try {
      const res = await hanaFetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: content,
          targetLanguage: '中文',
        }),
        timeout: 70_000,
      });
      const data = await res.json().catch(() => null) as { text?: string; error?: string; message?: string } | null;
      if (!res.ok || !data?.text) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setTranslated(data.text);
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslateBusy(false);
    }
  }, [content, sealed, translateBusy]);

  return (
    <details className={styles.thinkingBlock} open={open} onToggle={(e) => setExplicitOpen((e.target as HTMLDetailsElement).open)}>
      <summary className={styles.thinkingBlockSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        <span className={styles.thinkingBlockLabel}>
          {sealed ? t('thinking.done') : t('thinking.active')}
          {elapsedLabel}
        </span>
        {shouldOfferTranslate && (
          <button
            className={styles.thinkingTranslateBtn}
            onClick={handleTranslateThinking}
            disabled={translateBusy || !sealed}
            title="把思考内容翻译成中文"
            aria-label="把思考内容翻译成中文"
          >
            {translateBusy ? '翻译中' : '译中文'}
          </button>
        )}
        {!sealed && <span className={styles.thinkingDots}><span /><span /><span /></span>}
      </summary>
      {open && content && (
        <>
          <div className={styles.thinkingBlockBody}>{content}</div>
          {(translated || translateError) && (
            <div className={styles.thinkingTranslationCard}>
              <div className={styles.translationCardHead}>
                <span>{translateError ? '翻译失败' : '中文译文'}</span>
              </div>
              <div className={styles.translationCardBody}>{translateError || translated}</div>
            </div>
          )}
        </>
      )}
    </details>
  );
});
