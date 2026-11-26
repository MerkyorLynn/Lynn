/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { resolveUiI18nText } from '../../utils/ui-i18n';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
  modelLabel?: string | null;
  // #12: explicit capability flag — preferred over modelLabel regex (regex breaks on model rename).
  // Falls back to regex on modelLabel when not provided. Caller can wire from provider meta.
  isLocalProvider?: boolean;
}

const TRANSLATE_CHUNK_CHARS = 2_500; // #29: chunked translate ceiling per request
const MAX_TRANSLATE_CHUNKS = 8;       // #29: cap total chunks (≈ 20K char absolute ceiling)

/**
 * Translation target for the "translate thinking" action.
 *
 * It used to be hardcoded to `'中文'`, so an English-speaking user got their
 * English reasoning translated into Chinese. Target the UI language instead,
 * and only offer the action when the text is not already in that language.
 */
const CJK_CHARS = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_CHARS = /[A-Za-z]{4,}/;

function resolveTranslateTarget(): { label: string; isAlreadyTarget: (text: string) => boolean } {
  const locale = (() => {
    try {
      return String(
        (window as unknown as { i18n?: { locale?: string } }).i18n?.locale
        || document.documentElement?.lang
        || navigator.language
        || 'zh',
      ).toLowerCase();
    } catch {
      return 'zh';
    }
  })();

  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk') || locale.startsWith('zh-hant')) {
    return { label: '繁体中文', isAlreadyTarget: (text) => /[\u3400-\u9fff]/.test(text) };
  }
  if (locale.startsWith('zh')) {
    return { label: '中文', isAlreadyTarget: (text) => /[\u3400-\u9fff]/.test(text) };
  }
  if (locale.startsWith('ja')) {
    return { label: '日文', isAlreadyTarget: (text) => /[\u3040-\u30ff]/.test(text) };
  }
  if (locale.startsWith('ko')) {
    return { label: '韩文', isAlreadyTarget: (text) => /[\uac00-\ud7af]/.test(text) };
  }
  return { label: '英文', isAlreadyTarget: (text) => !CJK_CHARS.test(text) && LATIN_CHARS.test(text) };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed, modelLabel, isLocalProvider }: Props) {
  // Keep raw provider thinking opt-in. Some providers stream internal thoughts in
  // English, so default-collapsing prevents that text from reading like the answer.
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [translated, setTranslated] = useState<string | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const startRef = useRef(Date.now());
  // #12: prefer explicit prop; fallback to regex (kept for callers not yet passing the flag)
  // 2026-06-27: 默认本地模型切到 27B;正则保留 4B/9B/35B 兼容以覆盖自选 GGUF 和降级档。
  const isLocalModelThinking = isLocalProvider === true
    || (isLocalProvider !== false && /local-qwen|qwen35-4b|qwen35-9b|qwen36-27b|qwen36-35b|Qwen3(?:\.5|\.6)?-(?:4B|9B|27B|35B)|本地\s*(?:4B|9B|27B|35B|Qwen)/i.test(modelLabel || ""));
  const isLocalProgressThinking = isLocalModelThinking || /本地\s*(?:4B|9B|27B|35B|Qwen)|本地模型|llama\.cpp|等待工具/.test(content || "");
  const isLocalColdStartThinking = /首次启动|第一问|暖机|等待首字/.test(content || "");
  // Local cold-start notes are user-facing progress, but raw provider thinking
  // can be long or English. Keep it collapsed unless the user explicitly opens it.
  const open = explicitOpen ?? false;
  const toggle = useCallback(() => setExplicitOpen(v => !(v ?? false)), []);
  const translateTarget = useMemo(resolveTranslateTarget, []);
  const shouldOfferTranslate = sealed
    && !!content
    && (LATIN_CHARS.test(content) || CJK_CHARS.test(content))
    && !translateTarget.isAlreadyTarget(content);

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

  // Keep the folded thinking label lightweight; the answer should remain the visual subject.
  const elapsedLabel = !sealed && elapsed >= 2000
    ? ` (${formatElapsed(elapsed)})`
    : '';
  const activeLabel = useMemo(() => {
    if (sealed) return resolveUiI18nText('thinking.done');
    if (isLocalColdStartThinking && elapsed >= 8_000) return resolveUiI18nText('thinking.localWarmup');
    if (isLocalModelThinking && elapsed >= 40_000) return resolveUiI18nText('thinking.localStillGeneratingShort');
    if (isLocalModelThinking && elapsed >= 25_000) return resolveUiI18nText('thinking.localGeneratingOnDevice');
    if (isLocalProgressThinking && elapsed >= 8_000) return resolveUiI18nText('thinking.localOrganizingAnswer');
    if (elapsed >= 8_000) return resolveUiI18nText('thinking.organizingAnswer');
    return resolveUiI18nText('thinking.active');
  }, [elapsed, isLocalColdStartThinking, isLocalModelThinking, isLocalProgressThinking, sealed]);

  const fallbackBody = useMemo(() => {
    if (sealed || content.trim()) return '';
    if (!isLocalModelThinking) return resolveUiI18nText('thinking.localOrganizing');
    // Guard text lives in ui-i18n: 本地模型正在本机生成答案 / 首次启动后的第一问可能较慢
    if (elapsed >= 8_000) {
      return resolveUiI18nText('thinking.localStillGenerating');
    }
    return resolveUiI18nText('thinking.localGenerating');
  }, [content, elapsed, isLocalModelThinking, sealed]);

  const handleTranslateThinking = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!content || translateBusy) return;
    if (!sealed) {
      setTranslateError(resolveUiI18nText('thinking.translateWaitDone'));
      return;
    }
    // #29: chunked translate for long thinking (was: hard reject > 3000)
    setTranslateBusy(true);
    setTranslateError(null);
    setExplicitOpen(true);
    try {
      // Split into ≤ MAX_TRANSLATE_CHUNKS chunks of ≤ TRANSLATE_CHUNK_CHARS each at sentence boundaries
      const splitIntoChunks = (text: string): string[] => {
        if (text.length <= TRANSLATE_CHUNK_CHARS) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0 && chunks.length < MAX_TRANSLATE_CHUNKS) {
          if (remaining.length <= TRANSLATE_CHUNK_CHARS) {
            chunks.push(remaining);
            break;
          }
          // find last sentence boundary within window
          const window = remaining.slice(0, TRANSLATE_CHUNK_CHARS);
          const lastBoundary = Math.max(
            window.lastIndexOf('. '),
            window.lastIndexOf('.\n'),
            window.lastIndexOf('。'),
            window.lastIndexOf('！'),
            window.lastIndexOf('？'),
            window.lastIndexOf('\n\n'),
          );
          const cut = lastBoundary > TRANSLATE_CHUNK_CHARS * 0.5 ? lastBoundary + 1 : TRANSLATE_CHUNK_CHARS;
          chunks.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut).trimStart();
        }
        return chunks;
      };

      const chunks = splitIntoChunks(content);
      const wasTruncated = content.length > TRANSLATE_CHUNK_CHARS * MAX_TRANSLATE_CHUNKS;
      const pieces: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const res = await hanaFetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: chunks[i], targetLanguage: translateTarget.label }),
          timeout: 70_000,
        });
        const data = await res.json().catch(() => null) as { text?: string; error?: string; message?: string } | null;
        if (!res.ok || !data?.text) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        pieces.push(data.text);
      }
      const combined = pieces.join('\n\n') + (wasTruncated
        ? '\n\n[' + resolveUiI18nText('thinking.translationTruncated', { count: TRANSLATE_CHUNK_CHARS * MAX_TRANSLATE_CHUNKS }) + ']'
        : '');
      if (!combined) throw new Error('translation produced empty result');
      setTranslated(combined);
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslateBusy(false);
    }
  }, [content, sealed, translateBusy, translateTarget]);

  return (
    <details
      className={`${styles.thinkingBlock}${sealed ? '' : ` ${styles.thinkingBlockRunning}`}`}
      open={open}
      onToggle={(e) => setExplicitOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.thinkingBlockSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        <span className={styles.thinkingBlockLabel}>
          {activeLabel}
          {elapsedLabel}
        </span>
        {shouldOfferTranslate && (
          <button
            className={styles.thinkingTranslateBtn}
            onClick={handleTranslateThinking}
            disabled={translateBusy || !sealed}
            title={resolveUiI18nText('thinking.translateTitle')}
            aria-label={resolveUiI18nText('thinking.translateTitle')}
          >
            {translateBusy ? resolveUiI18nText('thinking.translateBusy') : resolveUiI18nText('thinking.translateAction')}
          </button>
        )}
        {!sealed && <span className={styles.thinkingDots}><span /><span /><span /></span>}
      </summary>
      {open && (content || fallbackBody) && (
        <>
          <div className={styles.thinkingBlockBody}>{content || fallbackBody}</div>
          {(translated || translateError) && (
            <div className={styles.thinkingTranslationCard}>
              <div className={styles.translationCardHead}>
                <span>{translateError ? resolveUiI18nText('thinking.translateFailed') : resolveUiI18nText('thinking.translationTitle')}</span>
              </div>
              <div className={styles.translationCardBody}>{translateError || translated}</div>
            </div>
          )}
        </>
      )}
    </details>
  );
});
