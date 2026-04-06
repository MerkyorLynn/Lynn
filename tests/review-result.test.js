import { describe, expect, it } from 'vitest';
import { buildReviewFollowUp, computeReviewWorkflowGate, normalizeStructuredReview, parseStructuredReview } from '../server/review-result.js';

describe('review result helpers', () => {
  it('maps blocker verdicts and high-severity findings to hold gate', () => {
    expect(computeReviewWorkflowGate({ verdict: 'blocker', findings: [] })).toBe('hold');
    expect(computeReviewWorkflowGate({ verdict: 'concerns', findings: [{ severity: 'high', title: 'Broken path' }] })).toBe('hold');
  });

  it('normalizes structured reviews and infers verdict when missing', () => {
    const structured = normalizeStructuredReview({
      summary: 'Found an issue',
      findings: [
        {
          severity: 'low',
          title: 'Minor issue',
          detail: 'A detail',
          suggestion: 'Fix it',
          filePath: 'src/file.ts',
        },
      ],
    });

    expect(structured).toEqual(expect.objectContaining({
      verdict: 'concerns',
      workflowGate: 'follow_up',
      findings: [expect.objectContaining({
        title: 'Minor issue',
        suggestion: 'Fix it',
        filePath: 'src/file.ts',
      })],
    }));
  });

  it('extracts structured review json from markdown fences', () => {
    const parsed = parseStructuredReview('Review text\n```json\n{"summary":"Looks good.","verdict":"pass","findings":[]}\n```');

    expect(parsed).toEqual(expect.objectContaining({
      summary: 'Looks good.',
      verdict: 'pass',
      workflowGate: 'clear',
      findings: [],
    }));
  });

  it('builds a concise follow-up prompt when findings exist', () => {
    const prompt = buildReviewFollowUp({
      summary: 'One issue found.',
      verdict: 'concerns',
      workflowGate: 'follow_up',
      findings: [
        {
          severity: 'medium',
          title: 'Missing edge case',
          detail: 'Nil value path is not covered.',
          suggestion: 'Add a guard branch.',
          filePath: 'src/review.ts',
        },
      ],
      nextStep: 'Patch and rerun tests.',
    });

    expect(prompt).toContain('Review verdict: concerns');
    expect(prompt).toContain('[medium] Missing edge case (src/review.ts)');
    expect(prompt).toContain('Next step: Patch and rerun tests.');
  });

  it('returns null follow-up when gate is clear and there are no findings', () => {
    expect(buildReviewFollowUp({
      summary: 'No issues.',
      verdict: 'pass',
      workflowGate: 'clear',
      findings: [],
    })).toBeNull();
  });
});
