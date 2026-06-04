/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ExecutionTraceBlock } from './ExecutionTraceBlock';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { AuthorizationCard } from './AuthorizationCard';
import { TtsControlButton } from './TtsControlButton';
import { ArtifactCard, BrowserScreenshot, CronConfirmCard, FileOutputCard, SkillCard } from './MessageCards';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { isBundledLynnAvatarSrc, yuanFallbackAvatar } from '../../utils/agent-helpers';
import { buildRetryDraftFromMessage } from '../../utils/composer-state';
import { formatCompactModelLabel } from '../../utils/brain-models';
import { resendPromptRequest } from '../../stores/prompt-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

const XingCard = lazy(() => import('./XingCard').then((m) => ({ default: m.XingCard })));
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })));
const WritingDiffViewer = lazy(() => import('./WritingDiffViewer').then((m) => ({ default: m.WritingDiffViewer })));
const ReviewCard = lazy(() => import('./ReviewCard').then((m) => ({ default: m.ReviewCard })));

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  isLastAssistant: boolean;
}

import {
  parseMessageModelRef,
  providerRouteLabel,
  providerRouteTitle,
  summarizeToolState,
  extractPlainTextFromBlocks,
  reviewerKindFromConfig,
  reviewerNameFromKind,
  TRANSLATION_TARGETS,
  MAX_TRANSLATE_CHARS,
  findLatestReviewBlock,
  shouldShowFollowUpAction,
  fallbackI18n,
  type ReviewConfigResponse,
} from "./AssistantMessage.helpers";

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, isLastAssistant }: Props) {
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const agentYuan = useStore(s => s.agentYuan) || 'hanako';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const addToast = useStore(s => s.addToast);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = sessionAgent?.name || agentName;
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => yuanFallbackAvatar(displayYuan), [displayYuan]);
  const avatarSrc = sessionAgent?.avatarUrl || agentAvatarUrl || fallbackAvatar;
  const isBundledLynnAvatar = useMemo(() => isBundledLynnAvatarSrc(avatarSrc), [avatarSrc]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = useMemo(() => message.blocks || [], [message.blocks]);
  const toolGroups = useMemo(
    () => blocks.filter((block): block is Extract<ContentBlock, { type: 'tool_group' }> => block.type === 'tool_group'),
    [blocks],
  );
  const contentBlocks = useMemo(
    () => blocks.filter((block) => block.type !== 'tool_group'),
    [blocks],
  );
  const executionTools = useMemo(
    () => toolGroups.flatMap((group) => group.tools),
    [toolGroups],
  );
  const plainText = useMemo(() => extractPlainTextFromBlocks(blocks), [blocks]);
  const latestReviewBlock = useMemo(() => findLatestReviewBlock(blocks), [blocks]);
  const { running: runningTools, total: totalTools, activeLabel: activeToolLabel } = useMemo(() => summarizeToolState(blocks), [blocks]);
  const isStreamMsg = !!message.id?.startsWith('stream-');
  const appIsStreaming = useStore(s => s.isStreaming);
  const currentModel = useStore(s => s.currentModel);
  const messageModelLabel = useMemo(() => {
    const modelRef = parseMessageModelRef(message.model);
    const isActiveStreamingMessage = isStreamMsg && isLastAssistant && appIsStreaming;
    const fallbackRef = isActiveStreamingMessage ? currentModel : { provider: 'brain', id: 'lynn-brain-router' };
    return formatCompactModelLabel(modelRef || fallbackRef, { role: displayYuan, purpose: 'chat' });
  }, [message.model, currentModel, displayYuan, isStreamMsg, isLastAssistant, appIsStreaming]);
  const providerFallbackLabel = useMemo(() => providerRouteLabel(message.providerRoute), [message.providerRoute]);
  const providerFallbackTitle = useMemo(() => providerRouteTitle(message.providerRoute), [message.providerRoute]);
  const showStreamingMeta = isStreamMsg && (runningTools > 0 || blocks.some(block => block.type === 'thinking' && !block.sealed));
  // T2: TTFT 等待提示——streaming 中但还没有任何实际内容
  const showWaitingHint = isStreamMsg && blocks.length === 0;

  // 等待计时器：显示已等待的秒数
  const [waitSeconds, setWaitSeconds] = useState(0);
  useEffect(() => {
    if (!showWaitingHint) { setWaitSeconds(0); return; }
    const timer = setInterval(() => setWaitSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [showWaitingHint]);

  // 超时提示：等待超过 30 秒未收到内容，提示用户可能是网络问题
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  useEffect(() => {
    if (!showWaitingHint) { setWaitingTooLong(false); return; }
    const timer = setTimeout(() => setWaitingTooLong(true), 15000);
    return () => clearTimeout(timer);
  }, [showWaitingHint]);

  // ── 空回复兜底：模型只产了 thinking 但没给正文 / 工具调用 ──
  // 流已结束 + 至少有一个 thinking block + 没有任何正文 / 工具 / 授权卡片
  // → 用户看到的是"两个折叠的思考完成 chip"然后没了，给个重试入口。
  const isEmptyAnswerAfterThinking = useMemo(() => {
    if (isStreamMsg) return false;
    if (blocks.length === 0) return false;
    if (toolGroups.length > 0) return false;
    if (plainText.length > 0) return false;
    return blocks.some((b) => b.type === 'thinking')
      && blocks.every((b) => b.type === 'thinking' || b.type === 'mood');
  }, [isStreamMsg, blocks, toolGroups, plainText]);

  // ── 模型表现评估：回复质量不佳时提示用户切换模型 ──
  const modelHintDismissKey = 'lynn-model-hint-dismissed';
  const showModelHint = false; // disabled: short response does not mean the model is weak
  const dismissModelHint = useCallback(() => {
    try { localStorage.setItem(modelHintDismissKey, String(Date.now())); } catch { /* localStorage may be unavailable */ }
  }, []);
  const openProvidersFromHint = useCallback(() => {
    dismissModelHint();
    window.platform?.openSettings?.({ tab: 'providers' });
  }, [dismissModelHint]);

  const { t } = useI18n();
  const openLabel = fallbackI18n(t('common.open'), 'Open');
  const [copied, setCopied] = useState(false);
  const [reviewRequestPending, setReviewRequestPending] = useState(false);
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigResponse | null>(null);
  const [reviewConfigLoaded, setReviewConfigLoaded] = useState(false);
  const [translateTarget, setTranslateTarget] = useState('英文');
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const reviewBusy = reviewRequestPending || !!pendingReviewId || latestReviewBlock?.status === 'loading';
  const canRequestReview = plainText.length > 0 && !showStreamingMeta;
  const showFollowUpAction = shouldShowFollowUpAction(latestReviewBlock);
  const showReviewActions = canRequestReview || showFollowUpAction || isLastAssistant;

  useEffect(() => {
    if (!isLastAssistant) return;

    let cancelled = false;
    const loadConfig = () => {
      hanaFetch('/api/review/config')
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setReviewConfig(data);
        })
        .catch((err) => {
          console.warn('[review] config load failed:', err);
        })
        .finally(() => {
          if (!cancelled) setReviewConfigLoaded(true);
        });
    };

    loadConfig();
    const handleSettingsFocus = () => loadConfig();
    const handleReviewConfigChanged = () => loadConfig();
    window.addEventListener('focus', handleSettingsFocus);
    window.addEventListener('review-config-changed', handleReviewConfigChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleSettingsFocus);
      window.removeEventListener('review-config-changed', handleReviewConfigChanged);
    };
  }, [isLastAssistant]);

  useEffect(() => {
    if (!pendingReviewId) return;
    if (latestReviewBlock?.reviewId !== pendingReviewId) return;
    setPendingReviewId(null);
  }, [latestReviewBlock, pendingReviewId]);

  const defaultReviewerKind = reviewerKindFromConfig(reviewConfig);
  const defaultReviewerName = reviewerNameFromKind(defaultReviewerKind);
  const reviewTargetLabel = reviewConfigLoaded
    ? defaultReviewerName
    : (isLastAssistant ? (t('review.loading') || 'Loading') : (t('review.auto') || 'Auto select'));
  const reviewButtonLabel = `${t('review.button') || 'Review'} ${reviewConfigLoaded ? defaultReviewerName : (t('review.auto') || 'Auto select')}`;
  const showActionRail = !showStreamingMeta && (showReviewActions || !!plainText || isLastAssistant);

  const openReviewSettings = useCallback((reviewerKind?: 'hanako' | 'butter', reviewerAgentId?: string | null) => {
    if (reviewerAgentId) {
      window.platform?.openSettings?.({ tab: 'agent', agentId: reviewerAgentId });
      return;
    }
    window.platform?.openSettings?.({ tab: 'work', reviewerKind: reviewerKind ?? null });
  }, []);

  const resolveReviewConfig = useCallback(async (): Promise<ReviewConfigResponse | null> => {
    if (reviewConfigLoaded) return reviewConfig;
    try {
      const res = await hanaFetch('/api/review/config');
      const data = await res.json() as ReviewConfigResponse;
      setReviewConfig(data);
      setReviewConfigLoaded(true);
      return data;
    } catch (err) {
      console.warn('[review] config load failed:', err);
      setReviewConfigLoaded(true);
      return reviewConfig;
    }
  }, [reviewConfig, reviewConfigLoaded]);

  const handleReview = useCallback(async () => {
    if (reviewBusy || !plainText) return;

    const config = await resolveReviewConfig();
    const reviewerKind = reviewerKindFromConfig(config);
    setReviewRequestPending(true);
    try {
      const res = await hanaFetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: plainText, reviewerKind }),
      });
      const data = await res.json().catch(() => null) as { reviewId?: string } | null;
      setPendingReviewId(typeof data?.reviewId === 'string' ? data.reviewId : null);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const normalized = messageText.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
      console.error('[review] request failed:', err);
      if (/reviewer_not_configured/i.test(messageText) || /Hanako reviewer|Butter reviewer|Settings > Work/.test(messageText)) {
        addToast(normalized || (t('review.needsConfig') || 'Configure a reviewer first'), 'error');
        openReviewSettings(reviewerKind);
      } else {
        addToast(normalized || (t('review.requestFailed') || 'Review request failed'), 'error');
      }
      setPendingReviewId(null);
    } finally {
      setReviewRequestPending(false);
    }
  }, [addToast, openReviewSettings, plainText, resolveReviewConfig, reviewBusy, t]);

  const handleCopy = useCallback(() => {
    if (!plainText) return;
    const setOK = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    // [COPY-FIX 2026-05-05] navigator.clipboard 在 Electron 失焦/权限场景会 reject,fallback 到 execCommand
    const legacyFallback = () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- Electron clipboard fallback needs a temporary textarea for execCommand when navigator.clipboard rejects.
        const ta = document.createElement('textarea');
        ta.value = plainText;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) setOK();
      } catch { /* swallow */ }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(plainText).then(setOK).catch(legacyFallback);
    } else {
      legacyFallback();
    }
  }, [plainText]);

  const handleTranslate = useCallback(async () => {
    if (!plainText || translateBusy) return;
    if (showStreamingMeta) {
      addToast('回复完成后再翻译', 'info');
      return;
    }
    if (plainText.length > MAX_TRANSLATE_CHARS) {
      const msg = `文本超过 ${MAX_TRANSLATE_CHARS} 字，请先拆成更短片段再翻译。`;
      setTranslateError(msg);
      addToast(msg, 'error');
      return;
    }
    setTranslateBusy(true);
    setTranslateError(null);
    try {
      const res = await hanaFetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: plainText,
          targetLanguage: translateTarget,
        }),
        timeout: 70_000,
      });
      const data = await res.json().catch(() => null) as { text?: string; message?: string; error?: string } | null;
      if (!res.ok || !data?.text) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setTranslatedText(data.text);
      addToast(`已翻译成${translateTarget}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTranslateError(msg);
      addToast(`翻译失败：${msg}`, 'error');
    } finally {
      setTranslateBusy(false);
    }
  }, [addToast, plainText, showStreamingMeta, translateBusy, translateTarget]);

  useEffect(() => {
    setTranslatedText(null);
    setTranslateError(null);
  }, [plainText, translateTarget]);


  const handleRetry = useCallback(() => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) return;
    const chatSession = state.chatSessions[sessionPath];
    if (!chatSession?.items) return;

    for (let i = chatSession.items.length - 1; i >= 0; i--) {
      const item = chatSession.items[i];
      if (item.type !== 'message' || item.data.id !== message.id) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = chatSession.items[j];
        if (prev.type !== 'message' || prev.data.role !== 'user') continue;
        if (prev.data.requestText) {
          if (resendPromptRequest(prev.data.requestText, prev.data.requestImages, sessionPath)) {
            return;
          }
        }
        const draft = buildRetryDraftFromMessage(prev.data);
        state.applyComposerDraft(draft);
        state.requestInputFocus();
        return;
      }
      return;
    }
  }, [message.id]);

  const handleReviewFollowUp = useCallback(() => {
    if (!latestReviewBlock?.followUpPrompt) return;
    const state = useStore.getState();
    state.applyComposerDraft({ text: latestReviewBlock.followUpPrompt });
    state.requestInputFocus();
  }, [latestReviewBlock]);

  const handleReviewTaskCreated = useCallback(() => {
    useStore.getState().setActivePanel('activity');
  }, []);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          {!avatarFailed ? (
            <span className={styles.avatar}>
              <img
                className={`${styles.hanaAvatar}${isBundledLynnAvatar ? ` ${styles.hanaAvatarBundledLynn}` : ''}`}
                src={avatarSrc}
                alt={displayName}
                draggable={false}
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (img.src.endsWith(fallbackAvatar)) {
                    img.onerror = null;
                    setAvatarFailed(true);
                    return;
                  }
                  img.onerror = null;
                  img.src = fallbackAvatar;
                }}
              />
            </span>
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>🌸</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
          {messageModelLabel && (
            <span className={styles.avatarMeta}>
              {messageModelLabel}
            </span>
          )}
          {providerFallbackLabel && (
            <span
              className={`${styles.avatarMeta} ${styles.providerRouteMeta}`}
              data-fallback="true"
              title={providerFallbackTitle}
            >
              {providerFallbackLabel}
            </span>
          )}
          {showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {runningTools > 0 ? activeToolLabel + ' ' + runningTools + '/' + totalTools : (t('chat.thinking') || '正在思考')}
              <span className={styles.thinkingDots}><span /><span /><span /></span>
            </span>
          )}
          {showWaitingHint && !showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {waitSeconds > 0 ? (t('chat.waiting') || '等待回复') + ' ' + waitSeconds + 's' : (t('chat.waiting') || '等待回复')}
              <span className={styles.thinkingDots}><span /><span /><span /></span>
            </span>
          )}
          {waitingTooLong && showWaitingHint && (
            <span className={styles.avatarMetaWarn}>
              {t('chat.waitingTooLong') || '响应较慢，可能正在切换备用模型...'}
            </span>
          )}
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        {executionTools.length > 0 && (
          <ExecutionTraceBlock tools={executionTools} />
        )}
        {contentBlocks.map((block, i) => (
        <ContentBlockView
          key={`block-${i}`}
          block={block}
          agentName={displayName}
          agentYuan={displayYuan}
          agentAvatarUrl={avatarSrc}
          agentModelLabel={messageModelLabel}
          openLabel={openLabel}
          stateKey={message.id}
          sourceResponse={plainText}
          onReviewTaskCreated={handleReviewTaskCreated}
        />
        ))}
        {showActionRail && (
          <div className={styles.messageActionRail}>
            <div className={styles.messageActionRailMain}>
              {showReviewActions && (
                <div className={styles.reviewActionGroup} data-last-assistant={isLastAssistant ? 'true' : 'false'}>
                  {canRequestReview && (
                    <button
                      className={styles.reviewBtn}
                      onClick={handleReview}
                      disabled={reviewBusy}
                      title={reviewButtonLabel}
                      aria-label={reviewButtonLabel}
                    >
                      <span className={styles.reviewBtnPrefix}>{t('review.button') || 'Review'}</span>
                      <span className={styles.reviewBtnTarget}>{reviewTargetLabel}</span>
                    </button>
                  )}
                  {showFollowUpAction && (
                    <button
                      className={`${styles.reviewBtn} ${styles.reviewFollowUpBtn}`}
                      onClick={handleReviewFollowUp}
                      title={t('review.followUp') || 'Handle review findings'}
                      aria-label={t('review.followUp') || 'Handle review findings'}
                    >
                      <span className={styles.reviewBtnPrefix}>{t('review.followUp') || 'Handle findings'}</span>
                    </button>
                  )}
                  {isLastAssistant && (
                    <button
                      className={styles.reviewConfigBtn}
                      onClick={() => openReviewSettings(defaultReviewerKind, reviewConfig?.resolvedReviewer?.id || null)}
                      title={t('review.configure') || 'Configure reviewer'}
                      aria-label={t('review.configure') || 'Configure reviewer'}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3a2.5 2.5 0 0 1 2.45 2h1.13a2 2 0 0 1 1.73 1l.57.99 1-.58a2 2 0 0 1 2.73.73l1 1.73a2 2 0 0 1-.73 2.73l-.98.57.57.99a2 2 0 0 1 0 2l-.57.99.98.57a2 2 0 0 1 .73 2.73l-1 1.73a2 2 0 0 1-2.73.73l-1-.58-.57.99a2 2 0 0 1-1.73 1h-1.13a2.5 2.5 0 0 1-4.9 0H8.55a2 2 0 0 1-1.73-1l-.57-.99-1 .58a2 2 0 0 1-2.73-.73l-1-1.73a2 2 0 0 1 .73-2.73l.98-.57-.57-.99a2 2 0 0 1 0-2l.57-.99-.98-.57a2 2 0 0 1-.73-2.73l1-1.73a2 2 0 0 1 2.73-.73l1 .58.57-.99a2 2 0 0 1 1.73-1h1.13A2.5 2.5 0 0 1 12 3Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className={styles.messageActionRailIcons}>
              {!!plainText && (
                <span className={styles.msgTranslateGroup}>
                  <select
                    className={styles.msgTranslateSelect}
                    value={translateTarget}
                    onChange={(e) => setTranslateTarget(e.target.value)}
                    title="选择译文语言"
                    aria-label="选择译文语言"
                  >
                    {TRANSLATION_TARGETS.map((target) => (
                      <option key={target} value={target}>{target}</option>
                    ))}
                  </select>
                  <button
                    className={styles.msgTranslateBtn}
                    onClick={handleTranslate}
                    disabled={translateBusy || showStreamingMeta}
                    title={`翻译成${translateTarget}`}
                    aria-label={`翻译成${translateTarget}`}
                  >
                    {translateBusy ? '翻译中' : '翻译'}
                  </button>
                </span>
              )}
              <button className={`${styles.msgCopyBtn}${copied ? ` ${styles.msgCopyBtnCopied}` : ''}`} onClick={handleCopy} title={t('common.copyText')} aria-label={t('common.copyText')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {copied
                    ? <polyline points="20 6 9 17 4 12" />
                    : <>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </>
                  }
                </svg>
              </button>
              <TtsControlButton plainText={plainText} messageId={message.id} isStreamingMessage={isStreamMsg} />
              {isLastAssistant && (
                <button className={styles.msgCopyBtn} onClick={handleRetry} title={t('chat.retry') || 'Retry'} aria-label={t('chat.retry') || 'Retry'}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
        {(translatedText || translateError) && (
          <div className={styles.translationCard}>
            <div className={styles.translationCardHead}>
              <span>{translateError ? '翻译失败' : `译文 · ${translateTarget}`}</span>
              {translatedText && (
                <button
                  className={styles.translationCardCopy}
                  onClick={() => navigator.clipboard.writeText(translatedText).then(() => addToast('译文已复制', 'success')).catch(() => {})}
                >
                  复制
                </button>
              )}
            </div>
            <div className={styles.translationCardBody}>
              {translateError || translatedText}
            </div>
          </div>
        )}
        {showModelHint && (
          <div className={styles.modelHintBar}>
            <span className={styles.modelHintText}>
              {t('chat.modelHint') || '当前模型回复较简短，切换到更强的模型可能效果更好'}
            </span>
            <button className={styles.modelHintBtn} onClick={openProvidersFromHint}>
              {t('chat.modelHintAction') || '去设置'}
            </button>
            <button className={styles.modelHintDismiss} onClick={dismissModelHint}>×</button>
          </div>
        )}
        {isEmptyAnswerAfterThinking && (
          <div className={styles.modelHintBar}>
            <span className={styles.modelHintText}>
              {t('chat.emptyAnswerHint') || '模型只想了想，没说出话来。可以点重试再试一次。'}
            </span>
            <button className={styles.modelHintBtn} onClick={handleRetry}>
              {t('chat.emptyAnswerRetry') || '重试'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentYuan, agentAvatarUrl, agentModelLabel, openLabel, stateKey, sourceResponse, onReviewTaskCreated }: {
  block: ContentBlock;
  agentName: string;
  agentYuan?: string;
  agentAvatarUrl?: string | null;
  agentModelLabel?: string | null;
  openLabel: string;
  stateKey?: string;
  sourceResponse?: string;
  onReviewTaskCreated?: () => void;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} modelLabel={agentModelLabel} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'text':
      return <MarkdownContent html={block.html} stateKey={stateKey} />;
    case 'xing':
      return (
        <Suspense fallback={null}>
          <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />
        </Suspense>
      );
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} openLabel={openLabel} />;
    case 'file_diff': {
      const ext = (block.filePath.split('.').pop() || '').toLowerCase();
      const isProse = ext === 'md' || ext === 'markdown' || ext === 'txt';
      return (
        <Suspense fallback={null}>
          {isProse
            ? <WritingDiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} rollbackId={block.rollbackId} />
            : <DiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} rollbackId={block.rollbackId} />}
        </Suspense>
      );
    }
    case 'artifact':
      return <ArtifactCard title={block.title} artifactType={block.artifactType} artifactId={block.artifactId} content={block.content} language={block.language} />;
    case 'browser_screenshot':
      return <BrowserScreenshot base64={block.base64} mimeType={block.mimeType} />;
    case 'skill':
      return <SkillCard skillName={block.skillName} skillFilePath={block.skillFilePath} />;
    case 'cron_confirm':
      return <CronConfirmCard confirmId={(block as any).confirmId} jobData={block.jobData} status={block.status} />;
    case 'settings_confirm':
      return <SettingsConfirmCard {...block} />;
    case 'tool_authorization':
      return <AuthorizationCard
        confirmId={(block as any).confirmId}
        command={(block as any).command}
        reason={(block as any).reason}
        description={(block as any).description}
        category={(block as any).category}
        identifier={(block as any).identifier}
        trustedRoot={(block as any).trustedRoot}
        status={(block as any).status}
      />;
    case 'review':
      return (
        <Suspense fallback={null}>
          <ReviewCard
            reviewId={(block as any).reviewId}
            reviewerName={(block as any).reviewerName}
            reviewerAgent={(block as any).reviewerAgent}
            reviewerAgentName={(block as any).reviewerAgentName}
            reviewerYuan={(block as any).reviewerYuan}
            reviewerHasAvatar={(block as any).reviewerHasAvatar}
            reviewerModelLabel={(block as any).reviewerModelLabel}
            executorName={agentName}
            executorYuan={agentYuan}
            executorAvatarUrl={agentAvatarUrl}
            executorModelLabel={agentModelLabel}
            content={(block as any).content}
            error={(block as any).error}
            errorCode={(block as any).errorCode}
            status={(block as any).status}
            stage={(block as any).stage}
            findingsCount={(block as any).findingsCount}
            verdict={(block as any).verdict}
            workflowGate={(block as any).workflowGate}
            structured={(block as any).structured}
            contextPack={(block as any).contextPack}
            followUpPrompt={(block as any).followUpPrompt}
            followUpTask={(block as any).followUpTask}
            sourceResponse={sourceResponse}
            fallbackNote={(block as any).fallbackNote}
            onFollowUpTaskCreated={onReviewTaskCreated}
          />
        </Suspense>
      );
    default:
      return null;
  }
});
