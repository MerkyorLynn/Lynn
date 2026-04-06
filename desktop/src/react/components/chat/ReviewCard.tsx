/**
 * ReviewCard — 按需 Review 结果卡片
 */

import { memo, useMemo, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { MarkdownContent } from './MarkdownContent';
import { renderMarkdown } from '../../utils/markdown';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import { useStore } from '../../stores';
import type { ChatListItem, ContentBlock, ReviewContextPack, ReviewFollowUpTaskState, StructuredReview } from '../../stores/chat-types';
import styles from './Chat.module.css';

type ReviewBlock = Extract<ContentBlock, { type: 'review' }>;

function isReviewBlock(block: ContentBlock, reviewId: string): block is ReviewBlock {
  return block.type === 'review' && block.reviewId === reviewId;
}

interface Props {
  reviewId: string;
  reviewerName: string;
  reviewerAgent?: string;
  reviewerAgentName?: string;
  reviewerYuan?: string;
  reviewerHasAvatar?: boolean;
  reviewerModelLabel?: string | null;
  executorName: string;
  executorYuan?: string;
  executorAvatarUrl?: string | null;
  executorModelLabel?: string | null;
  content: string;
  error?: string;
  errorCode?: string | null;
  status: 'loading' | 'done';
  stage?: 'packing_context' | 'reviewing' | 'structuring' | 'done';
  findingsCount?: number;
  verdict?: StructuredReview['verdict'];
  workflowGate?: StructuredReview['workflowGate'];
  structured?: StructuredReview | null;
  contextPack?: ReviewContextPack | null;
  followUpPrompt?: string | null;
  followUpTask?: ReviewFollowUpTaskState | null;
  sourceResponse?: string;
  fallbackNote?: string | null;
  onFollowUpTaskCreated?: () => void;
}

const STAGE_LABELS: Record<NonNullable<Props['stage']>, string> = {
  packing_context: 'Packing context',
  reviewing: 'Reviewing',
  structuring: 'Structuring findings',
  done: 'Done',
};

const STAGE_LABELS_ZH: Record<NonNullable<Props['stage']>, string> = {
  packing_context: '整理上下文',
  reviewing: '复查中',
  structuring: '整理结论',
  done: '完成',
};

const VERDICT_CLASS: Record<NonNullable<Props['verdict']>, string> = {
  pass: styles.reviewVerdictPass,
  concerns: styles.reviewVerdictConcerns,
  blocker: styles.reviewVerdictBlocker,
};

function stageLabel(stage: Props['stage'], zh: boolean): string {
  if (!stage) return zh ? '复查中' : 'Reviewing';
  return zh ? STAGE_LABELS_ZH[stage] : STAGE_LABELS[stage];
}

function reviewStageHint(stage: Props['stage'], zh: boolean): string {
  if (stage === 'packing_context') {
    return zh
      ? '正在整理这次对话、工作目录和工具轨迹，通常几秒内就会进入正式复查。'
      : 'Gathering this conversation, workspace and tool trace. This usually takes a few seconds before the actual review starts.';
  }
  if (stage === 'structuring') {
    return zh
      ? '主体复查已经完成，正在把结论整理成更易读的发现、建议和继续条件。'
      : 'The main review is done. Now organizing the verdict into readable findings, suggestions, and next steps.';
  }
  return zh
    ? 'Hanako 正在逐段检查这次回答与改动。你现在可以继续聊天，结果会自动回填到这里。'
    : 'Hanako is checking the reply and changes step by step. You can keep chatting while the result fills in here automatically.';
}

function reviewStageSupportText(stage: Props['stage'], zh: boolean): string {
  if (stage === 'packing_context') {
    return zh ? '这一步只是在准备材料，不代表卡住。' : 'This is just prep work, not a stall.';
  }
  if (stage === 'structuring') {
    return zh ? '已经接近完成，马上会给出可继续或建议暂停的结论。' : 'Almost done. A continue/hold recommendation is coming next.';
  }
  return zh ? '你不用停在这里等，复查完成后会自动显示。' : 'No need to wait here. The review will appear automatically when it finishes.';
}

function reviewStageSteps(stage: Props['stage'], zh: boolean): Array<{ label: string; state: 'done' | 'active' | 'pending' }> {
  const current = stage || 'reviewing';
  const order: Array<NonNullable<Props['stage']>> = ['packing_context', 'reviewing', 'structuring'];
  const currentIndex = Math.max(order.indexOf(current), 0);
  return order.map((step, index) => ({
    label: zh ? STAGE_LABELS_ZH[step] : STAGE_LABELS[step],
    state: index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending',
  }));
}

function verdictLabel(verdict: Props['verdict'], zh: boolean): string | null {
  if (!verdict) return null;
  if (zh) {
    if (verdict === 'pass') return '通过';
    if (verdict === 'concerns') return '需跟进';
    return '阻断';
  }
  if (verdict === 'pass') return 'Pass';
  if (verdict === 'concerns') return 'Needs follow-up';
  return 'Blocker';
}

function gateLabel(gate: Props['workflowGate'], zh: boolean): string | null {
  if (!gate) return null;
  if (zh) {
    if (gate === 'clear') return '可继续';
    if (gate === 'follow_up') return '建议处理后继续';
    return '建议暂停';
  }
  if (gate === 'clear') return 'Clear';
  if (gate === 'follow_up') return 'Follow up';
  return 'Hold';
}

function findingsSummary(count: number | undefined, zh: boolean): string | null {
  if (typeof count !== 'number') return null;
  return zh ? `${count} 条发现` : `${count} findings`;
}

function contextPackSummary(contextPack: ReviewContextPack | null | undefined, zh: boolean): string | null {
  if (!contextPack) return null;
  const bits: string[] = [];
  if (contextPack.gitContext?.sessionFile) bits.push(zh ? `会话 ${contextPack.gitContext.sessionFile}` : `session ${contextPack.gitContext.sessionFile}`);
  if (contextPack.workspacePath) bits.push(zh ? '工作目录' : 'workspace');
  if (contextPack.sessionContext?.toolUses?.length) bits.push(zh ? `${contextPack.sessionContext.toolUses.length} 个工具轨迹` : `${contextPack.sessionContext.toolUses.length} tool notes`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

function isFollowUpTaskActive(task: ReviewFollowUpTaskState | null | undefined): boolean {
  return task?.status === 'pending' || task?.status === 'running' || task?.status === 'waiting_approval';
}

function followUpTaskLabel(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
  if (!task) return null;
  if (zh) {
    if (task.status === 'pending') return '准备执行';
    if (task.status === 'running') return '已开始执行';
    if (task.status === 'waiting_approval') return '等待授权';
    if (task.status === 'completed') return '执行完成';
    if (task.status === 'failed') return '执行失败';
    return '已取消';
  }
  if (task.status === 'pending') return 'Queued';
  if (task.status === 'running') return 'Started';
  if (task.status === 'waiting_approval') return 'Waiting for approval';
  if (task.status === 'completed') return 'Completed';
  if (task.status === 'failed') return 'Failed';
  return 'Cancelled';
}

function followUpTaskDefaultDetail(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
  if (!task) return null;
  if (task.error || task.resultSummary || task.title) return null;
  if (zh) {
    if (task.status === 'pending') return '复查结论已经提交给执行器，正在排队接手，通常会在几秒内开始。';
    if (task.status === 'running') return '已经开始执行了，正在根据复查结论修改、验证并把结果回填到当前对话。';
    if (task.status === 'waiting_approval') return '执行已经进行到需要你确认的步骤，授权后会继续往下跑。';
    if (task.status === 'completed') return '执行已经完成，结果会继续回填到当前对话。';
    if (task.status === 'failed') return '这次执行没有顺利完成，你可以稍后重试。';
    return '这次执行已取消。';
  }
  if (task.status === 'pending') return 'The follow-up has been submitted and should start in a few seconds.';
  if (task.status === 'running') return 'Applying Hanako’s review, validating the result, and writing it back now.';
  if (task.status === 'waiting_approval') return 'Execution is waiting for your approval before it can continue.';
  if (task.status === 'completed') return 'Execution completed and the result will be written back into this chat.';
  if (task.status === 'failed') return 'This execution did not finish successfully. You can retry it later.';
  return 'This execution was cancelled.';
}

function normalizeFollowUpTaskDetail(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
  if (!task) return null;
  const raw = String(task.error || task.resultSummary || task.title || '').trim();
  const looksPendingOnly = /已创建.?等待执行|created.*waiting|waiting to start/i.test(raw);
  if (task.error) return task.error;
  if (task.status === 'running' && looksPendingOnly) {
    return zh
      ? '已经开始执行了，正在根据复查结论修改、验证并把结果回填到当前对话。'
      : 'Execution already started and is applying the review, validating the result, and writing it back into this conversation.';
  }
  if (task.status === 'waiting_approval' && looksPendingOnly) {
    return zh
      ? '执行已经推进到需要你确认的步骤，授权后会继续往下跑。'
      : 'Execution has reached a step that needs your approval before it can continue.';
  }
  if (task.status === 'completed' && looksPendingOnly) {
    return zh
      ? '执行已经完成，结果会继续回填到当前对话。'
      : 'Execution already completed and the result will continue writing back into this conversation.';
  }
  return raw || followUpTaskDefaultDetail(task, zh);
}

function followUpTaskBadgeClass(task: ReviewFollowUpTaskState | null | undefined): string {
  if (!task) return styles.reviewBadgeAction;
  if (task.status === 'completed') return styles.reviewVerdictPass;
  if (task.status === 'failed' || task.status === 'cancelled') return styles.reviewVerdictBlocker;
  if (task.status === 'waiting_approval') return styles.reviewVerdictConcerns;
  return styles.reviewBadgeStage;
}

function buildDiscussionDraft(sourceResponse: string, structured: StructuredReview, zh: boolean): string {
  const findings = structured.findings
    .map((finding, index) => {
      const bits = [`${index + 1}. ${finding.title}`];
      if (finding.detail) bits.push(finding.detail);
      if (finding.suggestion) bits.push(zh ? `建议：${finding.suggestion}` : `Suggestion: ${finding.suggestion}`);
      return bits.join('\n');
    })
    .join('\n\n');

  if (zh) {
    return [
      '请帮我对照 Lynn 原回答和 Hanako 的复查意见，判断应该采纳哪一边；如果两边都有道理，请给我一个折中后的最终版本。',
      '',
      '[Lynn 原回答]',
      sourceResponse.trim(),
      '',
      '[Hanako 复查结论]',
      structured.summary,
      '',
      '[Hanako 发现]',
      findings || '暂无明确发现。',
      '',
      '[请输出]',
      '1. 关键分歧',
      '2. 更可信的一边及理由',
      '3. 建议我最终采用的表述',
    ].join('\n');
  }

  return [
    'Please compare Lynn\'s original answer with Hanako\'s review and tell me which side to trust more. If both have valid points, give me a merged final version.',
    '',
    '[Lynn original answer]',
    sourceResponse.trim(),
    '',
    '[Hanako review summary]',
    structured.summary,
    '',
    '[Hanako findings]',
    findings || 'No explicit findings.',
    '',
    '[Please return]',
    '1. Key disagreements',
    '2. Which side is more reliable and why',
    '3. A final merged answer I should use',
  ].join('\n');
}

function cleanInlineText(value: string, maxLength?: number): string {
  const compact = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';
  if (!maxLength || compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trim()}…`;
}

function normalizeReviewErrorMessage(error: string | undefined, errorCode: string | null | undefined, zh: boolean): string | null {
  const raw = String(error || '').trim();
  if (!raw) return null;
  if (errorCode === 'review_timeout' || /aborted due to timeout/i.test(raw) || /AbortError/i.test(raw)) {
    return zh
      ? '这次复查超时了。我已经尝试自动切换到更稳的模型，但仍然没能在时限内完成。你可以稍后重试，或先继续讨论原回答。'
      : 'This review timed out. Lynn already tried a more stable fallback model, but it still did not finish in time. You can retry later or continue discussing the original answer.';
  }
  return raw;
}

function summarizeOriginalAnswer(sourceResponse: string, zh: boolean): string {
  const summary = cleanInlineText(sourceResponse);
  if (summary) return summary;
  return zh ? '原回答里没有可提炼的明确结论。' : 'No clear conclusion was found in the original answer.';
}

function summarizeHanakoConcerns(structured: StructuredReview, zh: boolean): string {
  const findings = structured.findings || [];
  if (findings.length === 0) {
    return structured.summary || (zh ? 'Hanako 没有提出需要阻断的问题。' : 'Hanako did not raise blocking concerns.');
  }

  const topTitles = findings
    .slice(0, 3)
    .map((finding) => finding.title?.trim())
    .filter(Boolean)
    .join(zh ? '、' : ', ');

  const prefix = structured.summary ? cleanInlineText(structured.summary) : '';
  if (prefix && topTitles) {
    return zh ? `${prefix} 重点在：${topTitles}。` : `${prefix} Main concerns: ${topTitles}.`;
  }
  if (topTitles) return topTitles;
  return structured.summary || (zh ? 'Hanako 提出了一些需要继续核实的点。' : 'Hanako raised points that should be checked further.');
}

function buildExecutionResolution(structured: StructuredReview, sourceResponse: string | undefined, zh: boolean): string {
  const findings = structured.findings || [];
  const highCount = findings.filter((finding) => finding.severity === 'high').length;
  const mediumCount = findings.filter((finding) => finding.severity === 'medium').length;
  const originalSummary = sourceResponse?.trim() ? cleanInlineText(sourceResponse, 120) : '';
  const topSuggestions = findings
    .slice(0, 3)
    .map((finding) => finding.suggestion?.trim() || finding.title?.trim())
    .filter(Boolean)
    .join(zh ? '；' : '; ');

  if (findings.length === 0) {
    return zh
      ? `建议继续沿用 Lynn 的主结论${originalSummary ? `：${originalSummary}` : ''}。这次复查没有发现需要阻断的风险，只需在执行时顺手核对边界和措辞。`
      : `Proceed with Lynn's original conclusion${originalSummary ? `: ${originalSummary}` : ''}. The review did not surface blocking risks, so execution can continue with only light wording and edge-case checks.`;
  }

  if (structured.workflowGate === 'hold' || structured.verdict === 'blocker' || highCount > 0) {
    return zh
      ? `先不要直接按原回答执行。建议先吸收 Hanako 指出的关键风险${topSuggestions ? `：${topSuggestions}` : ''}，把高风险问题处理完后，再回到 Lynn 的原目标继续推进。`
      : `Do not execute the original answer directly yet. First absorb Hanako's key risk callouts${topSuggestions ? `: ${topSuggestions}` : ''}, resolve the high-risk issues, and only then resume Lynn's original direction.`;
  }

  if (structured.workflowGate === 'follow_up' || mediumCount > 0) {
    return zh
      ? `建议保留 Lynn 的主方向，但执行时必须先合并 Hanako 的修正意见${topSuggestions ? `：${topSuggestions}` : ''}。也就是说，先改掉这些问题，再按修正后的版本继续执行。`
      : `Keep Lynn's overall direction, but merge Hanako's corrections before execution${topSuggestions ? `: ${topSuggestions}` : ''}. In practice: fix these issues first, then continue with the corrected version.`;
  }

  return zh
    ? `建议以 Lynn 的主结论为底稿，结合 Hanako 的补充一起执行${topSuggestions ? `：${topSuggestions}` : ''}。`
    : `Use Lynn's conclusion as the base draft and execute with Hanako's additions merged in${topSuggestions ? `: ${topSuggestions}` : ''}.`;
}

function shouldCollapseText(value: string | null | undefined): boolean {
  return (value || '').trim().length > 220;
}

function stripReviewThinkTags(raw: string | null | undefined): string {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>\n*/gi, '')
    .trim();
}

function CollapsibleReviewText({
  text,
  expanded,
  onToggle,
  zh,
  clampClass,
  contentClass,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
  zh: boolean;
  clampClass: string;
  contentClass: string;
}) {
  const collapsible = shouldCollapseText(text);
  return (
    <div className={styles.reviewTextBlock}>
      <div className={`${styles.reviewTextContent} ${contentClass} ${!expanded && collapsible ? clampClass : ''}`}>
        {text}
      </div>
      {collapsible && (
        <button
          type="button"
          className={styles.reviewTextToggle}
          onClick={onToggle}
        >
          {expanded ? (zh ? '收起' : 'Show less') : (zh ? '展开全文' : 'Show more')}
        </button>
      )}
    </div>
  );
}

export const ReviewCard = memo(function ReviewCard({
  reviewId,
  reviewerName,
  reviewerAgent,
  reviewerAgentName,
  reviewerYuan,
  reviewerHasAvatar,
  reviewerModelLabel,
  executorName,
  executorYuan,
  executorAvatarUrl,
  executorModelLabel,
  content,
  error,
  errorCode,
  status,
  stage,
  findingsCount,
  verdict,
  workflowGate,
  structured,
  contextPack,
  followUpPrompt,
  followUpTask,
  sourceResponse,
  fallbackNote,
  onFollowUpTaskCreated,
}: Props) {
  const t = window.t ?? ((key: string) => key);
  const [reviewerAvatarFailed, setReviewerAvatarFailed] = useState(false);
  const [executorAvatarFailed, setExecutorAvatarFailed] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [showOriginalFull, setShowOriginalFull] = useState(false);
  const [showConcernFull, setShowConcernFull] = useState(false);
  const [showResolutionFull, setShowResolutionFull] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const zh = String(document?.documentElement?.lang || '').startsWith('zh') || !!t('review.button')?.includes('复');

  const reviewerFallbackAvatar = useMemo(() => yuanFallbackAvatar(reviewerYuan), [reviewerYuan]);
  const reviewerAvatarSrc = useMemo(() => {
    if (reviewerAgent && reviewerHasAvatar) {
      return hanaUrl(`/api/agents/${reviewerAgent}/avatar?t=${Date.now()}`);
    }
    return reviewerFallbackAvatar;
  }, [reviewerFallbackAvatar, reviewerAgent, reviewerHasAvatar]);
  const executorFallbackAvatar = useMemo(() => yuanFallbackAvatar(executorYuan || 'lynn'), [executorYuan]);
  const resolvedExecutorAvatarSrc = executorAvatarUrl || executorFallbackAvatar;

  const verdictText = verdictLabel(verdict, zh);
  const gateText = gateLabel(workflowGate, zh);
  const findingsText = findingsSummary(findingsCount, zh);
  const packText = contextPackSummary(contextPack, zh);
  const followUpTaskText = followUpTaskLabel(followUpTask, zh);
  const followUpTaskBusy = isFollowUpTaskActive(followUpTask);
  const followUpTaskDetail = normalizeFollowUpTaskDetail(followUpTask, zh);
  const effectiveSummary = structured?.summary || stripReviewThinkTags(content);
  const effectiveError = useMemo(() => normalizeReviewErrorMessage(error, errorCode, zh), [error, errorCode, zh]);
  const loadingSteps = useMemo(() => reviewStageSteps(stage, zh), [stage, zh]);
  const loadingHint = useMemo(() => reviewStageHint(stage, zh), [stage, zh]);
  const loadingSupportText = useMemo(() => reviewStageSupportText(stage, zh), [stage, zh]);
  const originalConclusion = useMemo(() => (
    sourceResponse?.trim() ? summarizeOriginalAnswer(sourceResponse, zh) : null
  ), [sourceResponse, zh]);
  const hanakoConcern = useMemo(() => (
    structured ? summarizeHanakoConcerns(structured, zh) : null
  ), [structured, zh]);
  const executionResolution = useMemo(() => (
    structured ? buildExecutionResolution(structured, sourceResponse, zh) : null
  ), [structured, sourceResponse, zh]);

  const createFollowUpTask = async () => {
    if (!structured || structured.findings.length === 0 || creatingTask || followUpTaskBusy) return;
    setCreatingTask(true);
    try {
      const res = await hanaFetch('/api/review/follow-up-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewId,
          reviewerName,
          sessionPath: currentSessionPath,
          structuredReview: structured,
          contextPack,
          followUpPrompt,
          sourceResponse,
          executionResolution,
        }),
      });
      const data = await res.json().catch(() => null) as {
        task?: {
          id?: string;
          taskId?: string;
          title?: string | null;
          status?: ReviewFollowUpTaskState['status'];
          resultSummary?: string | null;
          error?: string | null;
          updatedAt?: string | null;
        } | null;
      } | null;
      const createdTask = data?.task?.status && (data?.task?.taskId || data?.task?.id)
        ? {
            taskId: String(data.task.taskId || data.task.id),
            title: data.task.title || null,
            status: data.task.status,
            resultSummary: data.task.resultSummary || null,
            error: data.task.error || null,
            updatedAt: data.task.updatedAt || null,
          } satisfies ReviewFollowUpTaskState
        : null;
      if (currentSessionPath && createdTask) {
        const state = useStore.getState();
        const chatSession = state.chatSessions[currentSessionPath];
        if (chatSession?.items) {
          const updatedItems = (chatSession.items as ChatListItem[]).map((item) => {
            if (item.type !== 'message' || item.data.role !== 'assistant') return item;
            const blocks = (item.data.blocks || []) as ContentBlock[];
            if (!blocks.some((block) => isReviewBlock(block, reviewId))) return item;
            return {
              ...item,
              data: {
                ...item.data,
                blocks: blocks.map((block) =>
                  isReviewBlock(block, reviewId) ? { ...block, followUpTask: createdTask } : block,
                ),
              },
            };
          });
          useStore.setState({
            chatSessions: {
              ...state.chatSessions,
              [currentSessionPath]: { ...chatSession, items: updatedItems },
            },
          });
        }
      }
      const label = t('review.taskCreated') || data?.task?.title || (zh ? '后台执行任务已创建' : 'Follow-up task created');
      useStore.getState().addToast(label, 'success');
      onFollowUpTaskCreated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^hanaFetch\s+\S+:\s*/, '').trim() : String(err);
      useStore.getState().addToast(msg || (zh ? '创建执行任务失败' : 'Failed to create follow-up task'), 'error');
    } finally {
      setCreatingTask(false);
    }
  };

  const continueDiscussion = () => {
    if (!structured || !sourceResponse?.trim()) return;
    useStore.getState().applyComposerDraft({
      text: buildDiscussionDraft(sourceResponse, structured, zh),
    });
  };

  return (
    <div className={styles.reviewCard} data-review-yuan={reviewerYuan || 'hanako'}>
      <div className={styles.reviewCardHeader}>
        {!reviewerAvatarFailed ? (
          <img
            className={styles.reviewCardAvatar}
            src={reviewerAvatarSrc}
            alt={reviewerName}
            draggable={false}
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (img.src.endsWith(reviewerFallbackAvatar)) {
                img.onerror = null;
                setReviewerAvatarFailed(true);
                return;
              }
              img.onerror = null;
              img.src = reviewerFallbackAvatar;
            }}
          />
        ) : (
          <span className={styles.reviewCardAvatarFallback}>{reviewerName.charAt(0) || 'R'}</span>
        )}
        <div className={styles.reviewCardIdentity}>
          <span className={styles.reviewCardTitle}>{t('review.cardTitle') || 'Review'}</span>
          <span className={styles.reviewCardMeta}>
            {reviewerName}
            {reviewerAgentName && reviewerAgentName !== reviewerName ? ` · ${reviewerAgentName}` : ''}
          </span>
          {(status === 'loading' || verdictText || gateText || findingsText || packText || followUpPrompt || fallbackNote) && (
            <div className={styles.reviewCardSignals}>
              {status === 'loading' && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeStage}`}>
                  {stageLabel(stage, zh)}
                </span>
              )}
              {verdictText && verdict && (
                <span className={`${styles.reviewBadge} ${VERDICT_CLASS[verdict]}`}>
                  {verdictText}
                </span>
              )}
              {gateText && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeGate}`}>
                  {gateText}
                </span>
              )}
              {findingsText && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeCount}`}>
                  {findingsText}
                </span>
              )}
              {packText && status === 'done' && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeContext}`} title={packText}>
                  {zh ? '上下文包' : 'context pack'}
                </span>
              )}
              {followUpPrompt && status === 'done' && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeAction}`}>
                  {zh ? '已生成后续动作' : 'follow-up ready'}
                </span>
              )}
              {fallbackNote && status === 'done' && (
                <span className={`${styles.reviewBadge} ${styles.reviewBadgeContext}`} title={fallbackNote}>
                  {zh ? '已自动切换模型完成' : 'finished on fallback'}
                </span>
              )}
            </div>
          )}
        </div>
        {status === 'loading' && (
          <span className={styles.reviewCardLoading} aria-live="polite">
            <span className={styles.thinkingDots}><span /><span /><span /></span>
          </span>
        )}
      </div>
      {status === 'loading' && (
        <div className={styles.reviewLoadingPanel}>
          <div className={styles.reviewLoadingSteps} aria-hidden="true">
            {loadingSteps.map((step) => (
              <span
                key={step.label}
                className={`${styles.reviewLoadingStep} ${styles[`reviewLoadingStep${step.state[0].toUpperCase()}${step.state.slice(1)}`]}`}
              >
                {step.label}
              </span>
            ))}
          </div>
          <div className={styles.reviewLoadingHint}>
            <div className={styles.reviewLoadingHintText}>{loadingHint}</div>
            <div className={styles.reviewLoadingSupport}>{loadingSupportText}</div>
            {packText && (
              <div className={styles.reviewLoadingMeta}>
                {zh ? '已带上：' : 'Included: '}
                {packText}
              </div>
            )}
          </div>
        </div>
      )}
      {status === 'done' && (
        <div className={styles.reviewCardBody}>
          {effectiveError ? (
            <div className={styles.reviewCardError}>{effectiveError}</div>
          ) : structured ? (
            <>
              {fallbackNote && (
                <div className={styles.reviewNextStep}>{fallbackNote}</div>
              )}
              <div className={styles.reviewSummaryBlock}>
                <div className={styles.reviewSectionLabel}>{zh ? '结论' : 'Summary'}</div>
                <div className={styles.reviewSummaryText}>{structured.summary}</div>
                {structured.nextStep && (
                  <div className={styles.reviewNextStep}>{structured.nextStep}</div>
                )}
              </div>
              {originalConclusion && hanakoConcern && executionResolution && (
                <div className={styles.reviewComparePanel}>
                  <div className={styles.reviewCompareGrid}>
                    <div className={styles.reviewCompareColumn}>
                      <div className={styles.reviewCompareSpeaker}>
                        {!executorAvatarFailed ? (
                          <img
                            className={styles.reviewCompareAvatar}
                            src={resolvedExecutorAvatarSrc}
                            alt={executorName}
                            draggable={false}
                            onError={(e) => {
                              const img = e.target as HTMLImageElement;
                              if (img.src.endsWith(executorFallbackAvatar)) {
                                img.onerror = null;
                                setExecutorAvatarFailed(true);
                                return;
                              }
                              img.onerror = null;
                              img.src = executorFallbackAvatar;
                            }}
                          />
                        ) : (
                          <span className={styles.reviewCompareAvatarFallback}>{executorName.charAt(0) || 'A'}</span>
                        )}
                        <div className={styles.reviewCompareSpeakerMeta}>
                          <div className={styles.reviewCompareSpeakerName}>{executorName}</div>
                          {executorModelLabel ? (
                            <div className={styles.reviewCompareSpeakerModel}>{executorModelLabel}</div>
                          ) : null}
                          <div className={styles.reviewSectionLabel}>{zh ? '原答关键结论' : 'Original answer'}</div>
                        </div>
                      </div>
                      <CollapsibleReviewText
                        text={originalConclusion}
                        expanded={showOriginalFull}
                        onToggle={() => setShowOriginalFull((v) => !v)}
                        zh={zh}
                        clampClass={styles.reviewCompareTextClamp}
                        contentClass={styles.reviewCompareText}
                      />
                    </div>
                    <div className={styles.reviewCompareColumn}>
                      <div className={styles.reviewCompareSpeaker}>
                        {!reviewerAvatarFailed ? (
                          <img
                            className={styles.reviewCompareAvatar}
                            src={reviewerAvatarSrc}
                            alt={reviewerName}
                            draggable={false}
                            onError={(e) => {
                              const img = e.target as HTMLImageElement;
                              if (img.src.endsWith(reviewerFallbackAvatar)) {
                                img.onerror = null;
                                setReviewerAvatarFailed(true);
                                return;
                              }
                              img.onerror = null;
                              img.src = reviewerFallbackAvatar;
                            }}
                          />
                        ) : (
                          <span className={styles.reviewCompareAvatarFallback}>{reviewerName.charAt(0) || 'R'}</span>
                        )}
                        <div className={styles.reviewCompareSpeakerMeta}>
                          <div className={styles.reviewCompareSpeakerName}>{reviewerName}</div>
                          {reviewerModelLabel ? (
                            <div className={styles.reviewCompareSpeakerModel}>{reviewerModelLabel}</div>
                          ) : null}
                          <div className={styles.reviewSectionLabel}>{zh ? '复查质疑点' : 'Review concerns'}</div>
                        </div>
                      </div>
                      <CollapsibleReviewText
                        text={hanakoConcern}
                        expanded={showConcernFull}
                        onToggle={() => setShowConcernFull((v) => !v)}
                        zh={zh}
                        clampClass={styles.reviewCompareTextClamp}
                        contentClass={styles.reviewCompareText}
                      />
                    </div>
                  </div>
                  <div className={styles.reviewResolutionBlock}>
                    <div className={styles.reviewSectionLabel}>{zh ? '建议执行结论' : 'Suggested execution conclusion'}</div>
                    <CollapsibleReviewText
                      text={executionResolution}
                      expanded={showResolutionFull}
                      onToggle={() => setShowResolutionFull((v) => !v)}
                      zh={zh}
                      clampClass={styles.reviewResolutionTextClamp}
                      contentClass={styles.reviewResolutionText}
                    />
                  </div>
                </div>
              )}
              {structured.findings.length > 0 && (
                <div className={styles.reviewFindingActions}>
                  <div className={styles.reviewActionButtons}>
                    {sourceResponse?.trim() && (
                      <button
                        className={`${styles.reviewTaskBtn} ${styles.reviewTaskBtnSecondary}`}
                        onClick={continueDiscussion}
                      >
                        {zh ? '先继续讨论分歧' : 'Discuss before acting'}
                      </button>
                    )}
                    <button
                      className={styles.reviewTaskBtn}
                      onClick={createFollowUpTask}
                      disabled={creatingTask || followUpTaskBusy}
                    >
                      {creatingTask
                        ? (zh ? '创建中…' : 'Creating…')
                        : followUpTask?.status === 'pending'
                          ? (zh ? '准备执行…' : 'Queued…')
                          : followUpTask?.status === 'running'
                          ? (zh ? '已开始执行…' : 'Started…')
                          : followUpTask?.status === 'waiting_approval'
                            ? (zh ? '等待授权' : 'Waiting for approval')
                          : followUpTask?.status === 'completed'
                            ? (zh ? '▶ 再次执行' : '▶ Run again')
                            : (followUpTask?.status === 'failed' || followUpTask?.status === 'cancelled')
                              ? (zh ? '▶ 重新执行' : '▶ Retry')
                              : (zh ? '▶ 按此结论执行' : '▶ Execute this conclusion')}
                    </button>
                  </div>
                  {followUpTaskText && (
                    <div className={styles.reviewTaskMeta}>
                      <span className={`${styles.reviewBadge} ${followUpTaskBadgeClass(followUpTask)}`}>
                        {followUpTaskText}
                      </span>
                      {followUpTaskDetail && (
                        <div className={styles.reviewNextStep}>{followUpTaskDetail}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {structured.findings.length > 0 ? (
                <div className={styles.reviewFindingsSection}>
                  <button
                    type="button"
                    className={styles.reviewFindingsToggle}
                    onClick={() => setShowFindings((v) => !v)}
                  >
                    {showFindings
                      ? (zh ? '收起复查细节' : 'Hide review details')
                      : (zh ? `展开 ${structured.findings.length} 条复查细节` : `Show ${structured.findings.length} review details`)}
                  </button>
                  {showFindings && (
                    <div className={styles.reviewFindingsList}>
                      {structured.findings.map((finding, index) => (
                        <div key={`${finding.title}-${index}`} className={styles.reviewFindingItem}>
                          <div className={styles.reviewFindingHead}>
                            <span className={`${styles.reviewSeverity} ${styles[`reviewSeverity-${finding.severity}`]}`}>{finding.severity}</span>
                            <span className={styles.reviewFindingTitle}>{finding.title}</span>
                            {finding.filePath && <span className={styles.reviewFindingFile}>{finding.filePath}</span>}
                          </div>
                          {finding.detail && <div className={styles.reviewFindingDetail}>{finding.detail}</div>}
                          {finding.suggestion && <div className={styles.reviewFindingSuggestion}>{finding.suggestion}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.reviewNoFindings}>{zh ? '没有发现需要阻断的问题。' : 'No blocking findings.'}</div>
              )}
            </>
          ) : (
            <MarkdownContent html={renderMarkdown(effectiveSummary)} stateKey={`review:${reviewId}`} />
          )}
        </div>
      )}
    </div>
  );
});
