import { describe, expect, it } from 'vitest';
import { formatVisualBox, groupVisualFiles } from '../visual-format';

describe('formatVisualBox', () => {
  it('formats a normalized box: label, position, size, confidence as percents', () => {
    expect(
      formatVisualBox({ label: 'Submit', x: 0.42, y: 0.18, width: 0.3, height: 0.1, confidence: 0.87 }, 0),
    ).toBe('Submit @ 42%,18% · 30%×10% · 87% conf');
  });

  it('falls back to "box N" and omits optional size / confidence', () => {
    expect(formatVisualBox({ x: 0.5, y: 0.5 }, 2)).toBe('box 3 @ 50%,50%');
  });
});

describe('groupVisualFiles', () => {
  it('groups paths by kind, preserving order', () => {
    expect(
      groupVisualFiles([
        { path: 'a.tsx', kind: 'created' },
        { path: 'b.ts', kind: 'modified' },
        { path: 'c.tsx', kind: 'created' },
        { path: 'd.md', kind: 'suggested' },
      ]),
    ).toEqual({ created: ['a.tsx', 'c.tsx'], modified: ['b.ts'], suggested: ['d.md'] });
  });

  it('returns empty groups for no files', () => {
    expect(groupVisualFiles([])).toEqual({ created: [], modified: [], suggested: [] });
  });
});
