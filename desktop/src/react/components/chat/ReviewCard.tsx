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
  content: string;
  error?: string;
  status: 'loading' | 'done';
  stage?: 'packing_context' | 'reviewing' | 'structuring' | 'done';
  findingsCount?: number;
  verdict?: StructuredReview['verdict'];
  workflowGate?: StructuredReview['workflowGate'];
  structured?: StructuredReview | null;
  contextPack?: ReviewContextPack | null;
  followUpPrompt?: string | null;
  followUpTask?: ReviewFollowUpTaskState | null;
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
    if (task.status === 'pending') return '已创建，等待执行';
    if (task.status === 'running') return '执行中';
    if (task.status === 'waiting_approval') return '等待授权';
    if (task.status === 'completed') return '执行完成';
    if (task.status === 'failed') return '执行失败';
    return '已取消';
  }
  if (task.status === 'pending') return 'Queued';
  if (task.status === 'running') return 'Running';
  if (task.status === 'waiting_approval') return 'Waiting for approval';
  if (task.status === 'completed') return 'Completed';
  if (task.status === 'failed') return 'Failed';
  return 'Cancelled';
}

function followUpTaskBadgeClass(task: ReviewFollowUpTaskState | null | undefined): string {
  if (!task) return styles.reviewBadgeAction;
  if (task.status === 'completed') return styles.reviewVerdictPass;
  if (task.status === 'failed' || task.status === 'cancelled') return styles.reviewVerdictBlocker;
  if (task.status === 'waiting_approval') return styles.reviewVerdictConcerns;
  return styles.reviewBadgeStage;
}

export const ReviewCard = memo(function ReviewCard({
  reviewId,
  reviewerName,
  reviewerAgent,
  reviewerAgentName,
  reviewerYuan,
  reviewerHasAvatar,
  content,
  error,
  status,
  stage,
  findingsCount,
  verdict,
  workflowGate,
  structured,
  contextPack,
  followUpPrompt,
  followUpTask,
  onFollowUpTaskCreated,
}: Props) {
  const t = window.t ?? ((key: string) => key);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const zh = String(document?.documentElement?.lang || '').startsWith('zh') || !!t('review.button')?.includes('复');

  const fallbackAvatar = useMemo(() => yuanFallbackAvatar(reviewerYuan), [reviewerYuan]);
  const avatarSrc = useMemo(() => {
    if (reviewerAgent && reviewerHasAvatar) {
      return hanaUrl(`/api/agents/${reviewerAgent}/avatar?t=${Date.now()}`);
    }
    return fallbackAvatar;
  }, [fallbackAvatar, reviewerAgent, reviewerHasAvatar]);

  const verdictText = verdictLabel(verdict, zh);
  const gateText = gateLabel(workflowGate, zh);
  const findingsText = findingsSummary(findingsCount, zh);
  const packText = contextPackSummary(contextPack, zh);
  const followUpTaskText = followUpTaskLabel(followUpTask, zh);
  const followUpTaskBusy = isFollowUpTaskActive(followUpTask);
  const followUpTaskDetail = followUpTask?.error || followUpTask?.resultSummary || followUpTask?.title || null;
  const effectiveSummary = structured?.summary || content;

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

  return (
    <div className={styles.reviewCard} data-review-yuan={reviewerYuan || 'hanako'}>
      <div className={styles.reviewCardHeader}>
        {!avatarFailed ? (
          <img
            className={styles.reviewCardAvatar}
            src={avatarSrc}
            alt={reviewerName}
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
          <span className={styles.reviewCardAvatarFallback}>{reviewerName.charAt(0) || 'R'}</span>
        )}
        <div className={styles.reviewCardIdentity}>
          <span className={styles.reviewCardTitle}>{t('review.cardTitle') || 'Review'}</span>
          <span className={styles.reviewCardMeta}>
            {reviewerName}
            {reviewerAgentName && reviewerAgentName !== reviewerName ? ` · ${reviewerAgentName}` : ''}
          </span>
          {(status === 'loading' || verdictText || gateText || findingsText || packText || followUpPrompt) && (
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
            </div>
          )}
        </div>
        {status === 'loading' && (
          <span className={styles.reviewCardLoading} aria-live="polite">
            <span className={styles.thinkingDots}><span /><span /><span /></span>
          </span>
        )}
      </div>
      {status === 'done' && (
        <div className={styles.reviewCardBody}>
          {error ? (
            <div className={styles.reviewCardError}>{error}</div>
          ) : structured ? (
            <>
              <div className={styles.reviewSummaryBlock}>
                <div className={styles.reviewSectionLabel}>{zh ? '结论' : 'Summary'}</div>
                <div className={styles.reviewSummaryText}>{structured.summary}</div>
                {structured.nextStep && (
                  <div className={styles.reviewNextStep}>{structured.nextStep}</div>
                )}
              </div>
              {structured.findings.length > 0 && (
                <div className={styles.reviewFindingActions}>
                  <button
                    className={styles.reviewTaskBtn}
                    onClick={createFollowUpTask}
                    disabled={creatingTask || followUpTaskBusy}
                  >
                    {creatingTask
                      ? (zh ? '创建中…' : 'Creating…')
                      : followUpTaskBusy
                        ? (zh ? '执行中…' : 'Running…')
                        : followUpTask?.status === 'completed'
                          ? (zh ? '再次创建执行任务' : 'Create execution task again')
                          : (followUpTask?.status === 'failed' || followUpTask?.status === 'cancelled')
                            ? (zh ? '重新创建执行任务' : 'Retry execution task')
                            : (zh ? '转为执行任务' : 'Create execution task')}
                  </button>
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
              ) : (
                <div className={styles.reviewNoFindings}>{zh ? '没有发现需要阻断的问题。' : 'No blocking findings.'}</div>
              )}
            </>
          ) : (
            <MarkdownContent html={renderMarkdown(effectiveSummary)} />
          )}
        </div>
      )}
    </div>
  );
});
