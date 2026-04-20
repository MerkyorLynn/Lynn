import { describe, expect, it } from 'vitest';
import { applyReviewToFullContent, type ParagraphPair } from '../../utils/diff-utils';

describe('applyReviewToFullContent', () => {
  it('applies partial review decisions without truncating unrelated content', () => {
    const current = [
      'Intro paragraph',
      '',
      'Unchanged middle that is outside the diff hunk',
      '',
      'New evidence paragraph',
      '',
      'Tail paragraph',
    ].join('\n');
    const pairs: ParagraphPair[] = [
      { type: 'modified', oldText: 'Old evidence paragraph', newText: 'New evidence paragraph', index: 0 },
    ];
    const decisions = new Map<number, 'accept' | 'reject'>([[0, 'reject']]);

    expect(applyReviewToFullContent(current, pairs, decisions)).toBe([
      'Intro paragraph',
      '',
      'Unchanged middle that is outside the diff hunk',
      '',
      'Old evidence paragraph',
      '',
      'Tail paragraph',
    ].join('\n'));
  });

  it('fails safely instead of rebuilding the whole file from unmatched diff hunks', () => {
    const pairs: ParagraphPair[] = [
      { type: 'modified', oldText: 'Old paragraph', newText: 'New paragraph', index: 0 },
    ];
    const decisions = new Map<number, 'accept' | 'reject'>([[0, 'reject']]);

    expect(() => applyReviewToFullContent('Different current file', pairs, decisions)).toThrow(
      /Cannot safely apply review/,
    );
  });
});
