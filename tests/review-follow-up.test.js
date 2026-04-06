import { describe, expect, it } from 'vitest';
import { buildReviewFollowUpTaskPrompt, buildReviewFollowUpTaskTitle } from '../server/review-follow-up.js';

describe('review follow-up task builders', () => {
  it('builds a focused zh task title and prompt from findings', () => {
    const title = buildReviewFollowUpTaskTitle({
      findings: [{ title: 'Missing edge case' }],
    }, { zh: true });
    const prompt = buildReviewFollowUpTaskPrompt({
      reviewerName: 'Hanako',
      structuredReview: {
        summary: 'One issue found.',
        verdict: 'concerns',
        workflowGate: 'follow_up',
        findings: [{
          severity: 'medium',
          title: 'Missing edge case',
          detail: 'Nil value path is not covered.',
          suggestion: 'Add a guard branch.',
          filePath: 'src/review.ts',
        }],
        nextStep: 'Patch and rerun tests.',
      },
      contextPack: {
        request: 'Please review this patch.',
        workspacePath: '/Users/lynn/openhanako',
        sessionContext: {
          userText: 'Fix this flow.',
          assistantText: 'Patched the flow.',
        },
      },
      followUpPrompt: 'Review verdict: concerns',
      sourceResponse: 'Original answer said to keep the same flow and just add a null guard.',
      executionResolution: "Keep Lynn's main direction, but merge Hanako's correction before executing.",
    }, { zh: true });

    expect(title).toContain('处理复查发现');
    expect(prompt).toContain('Missing edge case');
    expect(prompt).toContain('最近一次用户请求');
    expect(prompt).toContain('/Users/lynn/openhanako');
    expect(prompt).toContain('建议执行结论');
    expect(prompt).toContain('Lynn 原回答摘要');
  });

  it('falls back to generic english title when findings are empty', () => {
    const title = buildReviewFollowUpTaskTitle({ findings: [] }, { zh: false });
    expect(title).toBe('Address review findings');
  });
});
