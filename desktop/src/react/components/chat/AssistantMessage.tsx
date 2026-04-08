/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { ImageBlock } from './ImageBlock';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ExecutionTraceBlock } from './ExecutionTraceBlock';
import { XingCard } from './XingCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { AuthorizationCard } from './AuthorizationCard';
import { DiffViewer } from './DiffViewer';
import { ReviewCard } from './ReviewCard';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import { buildRetryDraftFromMessage } from '../../utils/composer-state';
import { formatCompactModelLabel } from '../../utils/brain-models';
import { resendPromptRequest } from '../../stores/prompt-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  isLastAssistant: boolean;
}

interface ReviewConfigAgent {
  id: string;
  name: string;
  yuan: string;
  hasAvatar?: boolean;
}

interface ReviewConfigResponse {
  defaultReviewer: 'hanako' | 'butter';
  hanakoReviewerId?: string | null;
  butterReviewerId?: string | null;
  resolvedReviewer?: ReviewConfigAgent | null;
}

function summarizeToolState(blocks: ContentBlock[]): { running: number; total: number } {
  let running = 0;
  let total = 0;
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    total += block.tools.length;
    running += block.tools.filter(tool => !tool.done).length;
  }
  return { running, total };
}

function extractPlainTextFromBlocks(blocks: ContentBlock[]): string {
  const textBlocks = blocks.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
  if (textBlocks.length === 0) return '';
  const parser = new DOMParser();
  return textBlocks
    .map((block) => {
      const doc = parser.parseFromString(block.html, 'text/html');
      return (doc.body.innerText || doc.body.textContent || '').trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reviewerKindFromConfig(config: ReviewConfigResponse | null): 'hanako' | 'butter' {
  return config?.defaultReviewer === 'butter' ? 'butter' : 'hanako';
}

function reviewerNameFromKind(kind: 'hanako' | 'butter'): string {
  return kind === 'butter' ? 'Butter' : 'Hanako';
}

function findLatestReviewBlock(blocks: ContentBlock[]): Extract<ContentBlock, { type: 'review' }> | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'review') return block;
  }
  return null;
}

function shouldShowFollowUpAction(reviewBlock: Extract<ContentBlock, { type: 'review' }> | null): boolean {
  if (!reviewBlock || reviewBlock.status !== 'done') return false;
  if (!reviewBlock.followUpPrompt) return false;
  return reviewBlock.workflowGate === 'follow_up' || reviewBlock.workflowGate === 'hold';
}

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
  const currentModel = useStore(s => s.currentModel);
  const { running: runningTools, total: totalTools } = useMemo(() => summarizeToolState(blocks), [blocks]);
  const isStreamMsg = !!message.id?.startsWith('stream-');
  const showStreamingMeta = isStreamMsg && (runningTools > 0 || blocks.some(block => block.type === 'thinking' && !block.sealed));
  // T2: TTFT 等待提示——streaming 中但还没有任何实际内容
  const showWaitingHint = isStreamMsg && blocks.length === 0;

  // 超时提示：等待超过 30 秒未收到内容，提示用户可能是网络问题
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  useEffect(() => {
    if (!showWaitingHint) { setWaitingTooLong(false); return; }
    const timer = setTimeout(() => setWaitingTooLong(true), 15000);
    return () => clearTimeout(timer);
  }, [showWaitingHint]);

  // ── 模型表现评估：回复质量不佳时提示用户切换模型 ──
  const hasToolCalls = totalTools > 0;
  const isFinished = !isStreamMsg || (blocks.length > 0 && !showStreamingMeta && !showWaitingHint);
  const textLen = plainText.length;
  const modelHintDismissKey = 'lynn-model-hint-dismissed';
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      const ts = Number(localStorage.getItem(modelHintDismissKey) || 0);
      return ts > 0 && Date.now() - ts < 86400000;
    } catch { return false; }
  });
  const showModelHint = useMemo(() => {
    if (hintDismissed || !isLastAssistant || !isFinished) return false;
    if (hasToolCalls) return false;
    if (textLen > 0 && textLen < 15) return true;
    return false;
  }, [hintDismissed, isLastAssistant, isFinished, hasToolCalls, textLen]);
  const dismissModelHint = useCallback(() => {
    setHintDismissed(true);
    try { localStorage.setItem(modelHintDismissKey, String(Date.now())); } catch {}
  }, []);
  const openProvidersFromHint = useCallback(() => {
    dismissModelHint();
    window.platform?.openSettings?.({ tab: 'providers' });
  }, [dismissModelHint]);

  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [reviewRequestPending, setReviewRequestPending] = useState(false);
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigResponse | null>(null);
  const [reviewConfigLoaded, setReviewConfigLoaded] = useState(false);
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
    navigator.clipboard.writeText(plainText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [plainText]);


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
            <img
              className={`${styles.avatar} ${styles.hanaAvatar}`}
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
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>🌸</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
          {formatCompactModelLabel(currentModel) && (
            <span className={styles.avatarMeta}>
              {formatCompactModelLabel(currentModel)}
            </span>
          )}
          {showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {runningTools > 0 ? 'tools ' + runningTools + '/' + totalTools : 'thinking'}
            </span>
          )}
          {showWaitingHint && !showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {t('chat.waiting') || '等待回复'}
              <span className={styles.thinkingDots}><span /><span /><span /></span>
            </span>
          )}
          {waitingTooLong && showWaitingHint && (
            <span className={styles.avatarMetaWarn}>
              {t('chat.waitingTooLong') || '响应超时，当前网络可能受限。可尝试切换网络或在设置中更换模型。'}
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
          agentModelLabel={formatCompactModelLabel(currentModel)}
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
      </div>
    </div>
  );
});

const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentYuan, agentAvatarUrl, agentModelLabel, stateKey, sourceResponse, onReviewTaskCreated }: {
  block: ContentBlock;
  agentName: string;
  agentYuan?: string;
  agentAvatarUrl?: string | null;
  agentModelLabel?: string | null;
  stateKey?: string;
  sourceResponse?: string;
  onReviewTaskCreated?: () => void;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'text':
      return <MarkdownContent html={block.html} stateKey={stateKey} />;
    case 'xing':
      return <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />;
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} />;
    case 'file_diff':
      return <DiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} rollbackId={block.rollbackId} />;
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
      return <ReviewCard
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
      />;
    default:
      return null;
  }
});

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
};

function extLabel(ext: string): string {
  return EXT_LABELS[ext.toLowerCase()] || ext.toUpperCase();
}

function FileOutputCard({ filePath, label, ext }: { filePath: string; label: string; ext: string }) {
  const [hover, setHover] = useState(false);
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const isMd = ext === 'md' || ext === 'markdown';

  useEffect(() => {
    if (!isMd) return;
    let cancelled = false;
    window.platform?.readFile?.(filePath)?.then((content: string | null) => {
      if (cancelled || !content) return;
      import('../../utils/markdown').then(({ renderMarkdown }) => {
        if (!cancelled) setMdHtml(renderMarkdown(content));
      });
    });
    return () => { cancelled = true; };
  }, [filePath, isMd]);

  return (
    <div
      className={styles.fileOutputCard}
      style={isMd && mdHtml ? { flexDirection: 'column', alignItems: 'stretch', maxWidth: '100%' } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{extLabel(ext)}</span>
        <span className={styles.fileOutputLabel}>{label || filePath.split('/').pop() || filePath}</span>
        {isMd && mdHtml && (
          <button
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem', padding: '0 4px' }}
            onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }}
          >
            {collapsed ? '▶' : '▼'}
          </button>
        )}
      </div>
      <div className={styles.fileOutputPath}>{filePath}</div>
      {hover && (
        <button className={styles.fileOutputOpen} onClick={() => openFilePreview(filePath, label, ext)}>
          {window.t('common.open') || 'Open'}
        </button>
      )}
      {isMd && mdHtml && !collapsed && (
        <div
          className="md-content"
          style={{
            marginTop: '8px',
            padding: '12px',
            background: 'var(--bg-card, var(--bg))',
            borderRadius: '6px',
            border: '1px solid var(--overlay-light, rgba(0,0,0,0.06))',
            fontSize: '0.88rem',
            lineHeight: '1.6',
            maxHeight: '400px',
            overflowY: 'auto',
            wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: mdHtml }}
        />
      )}
    </div>
  );
}

function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string;
  artifactType: string;
  artifactId: string;
  content: string;
  language?: string;
}) {
  return (
    <button
      className={styles.fileOutputCard}
      onClick={() => openPreview({ id: artifactId, type: artifactType as any, title, content, language })}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{artifactType.toUpperCase()}</span>
        <span className={styles.fileOutputLabel}>{title}</span>
      </div>
    </button>
  );
}

function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  return <ImageBlock className={styles.browserShot} src={`data:${mimeType};base64,${base64}`} alt="Browser Screenshot" />;
}

function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <button
      className={styles.fileOutputCard}
      onClick={() => openSkillPreview(skillName, skillFilePath)}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>SKILL</span>
        <span className={styles.fileOutputLabel}>{skillName}</span>
      </div>
      <div className={styles.fileOutputPath}>{skillFilePath}</div>
    </button>
  );
}

function CronConfirmCard({ confirmId, jobData, status }: { confirmId?: string; jobData: any; status: string }) {
  const { t } = useI18n();
  const addToast = useStore((s) => s.addToast);
  const [submitting, setSubmitting] = useState(false);

  const sendDecision = useCallback(async (action: 'approved' | 'rejected') => {
    if (!confirmId || submitting) return;
    setSubmitting(true);
    try {
      await hanaFetch(`/api/cron/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      addToast(action === 'approved' ? t('common.saved') : t('common.cancelled'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [addToast, confirmId, submitting, t]);

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{jobData.label || t('cron.confirm.title')}</div>
      <div className={styles.cronConfirmMeta}>{jobData.schedule}</div>
      <div className={styles.cronConfirmPrompt}>{jobData.prompt}</div>
      {status === 'pending' && confirmId && (
        <div className={styles.cronConfirmActions}>
          <button onClick={() => sendDecision('rejected')} disabled={submitting}>{t('common.cancel')}</button>
          <button onClick={() => sendDecision('approved')} disabled={submitting}>{t('common.confirm')}</button>
        </div>
      )}
    </div>
  );
}
