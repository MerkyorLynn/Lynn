/**
 * ReviewCard pure helpers — findings/context summaries, follow-up task labels &
 * detail normalization, discussion-draft + execution-resolution builders, and
 * inline-text cleanup. Extracted from ReviewCard.tsx (GUI monolith decomposition).
 * No React/hooks/JSX/CSS — pure over shared review types, unit-testable.
 * (followUpTaskBadgeClass stays in the component — it maps to CSS-module classes.)
 */

import type { ReviewContextPack, ReviewFollowUpTaskState, StructuredReview } from '../../stores/chat-types';

export function findingsSummary(count: number | undefined, zh: boolean): string | null {
  if (typeof count !== 'number') return null;
  return zh ? `${count} 条发现` : `${count} findings`;
}

export function contextPackSummary(contextPack: ReviewContextPack | null | undefined, zh: boolean): string | null {
  if (!contextPack) return null;
  const bits: string[] = [];
  if (contextPack.gitContext?.sessionFile) bits.push(zh ? `会话 ${contextPack.gitContext.sessionFile}` : `session ${contextPack.gitContext.sessionFile}`);
  if (contextPack.workspacePath) bits.push(zh ? '工作目录' : 'workspace');
  if (contextPack.sessionContext?.toolUses?.length) bits.push(zh ? `${contextPack.sessionContext.toolUses.length} 个工具轨迹` : `${contextPack.sessionContext.toolUses.length} tool notes`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

export function isFollowUpTaskActive(task: ReviewFollowUpTaskState | null | undefined): boolean {
  return task?.status === 'pending' || task?.status === 'running' || task?.status === 'waiting_approval';
}

export function followUpTaskLabel(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
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

export function followUpTaskDefaultDetail(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
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

export function normalizeFollowUpTaskDetail(task: ReviewFollowUpTaskState | null | undefined, zh: boolean): string | null {
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

export function buildDiscussionDraft(sourceResponse: string, structured: StructuredReview, zh: boolean): string {
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

export function cleanInlineText(value: string, maxLength?: number): string {
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

export function normalizeReviewErrorMessage(error: string | undefined, errorCode: string | null | undefined, zh: boolean): string | null {
  const raw = String(error || '').trim();
  if (!raw) return null;
  if (errorCode === 'review_timeout' || /aborted due to timeout/i.test(raw) || /AbortError/i.test(raw)) {
    return zh
      ? '这次复查超时了。我已经尝试自动切换到更稳的模型，但仍然没能在时限内完成。你可以稍后重试，或先继续讨论原回答。'
      : 'This review timed out. Lynn already tried a more stable fallback model, but it still did not finish in time. You can retry later or continue discussing the original answer.';
  }
  return raw;
}

export function summarizeOriginalAnswer(sourceResponse: string, zh: boolean): string {
  const summary = cleanInlineText(sourceResponse);
  if (summary) return summary;
  return zh ? '原回答里没有可提炼的明确结论。' : 'No clear conclusion was found in the original answer.';
}

export function summarizeHanakoConcerns(structured: StructuredReview, zh: boolean): string {
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

export function buildExecutionResolution(structured: StructuredReview, sourceResponse: string | undefined, zh: boolean): string {
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

export function shouldCollapseText(value: string | null | undefined): boolean {
  return (value || '').trim().length > 220;
}

export function stripReviewThinkTags(raw: string | null | undefined): string {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>\n*/gi, '')
    .trim();
}
