import { describe, expect, it } from 'vitest';
import { classifyDiffLine } from '../diff-format';

describe('classifyDiffLine', () => {
  it('classifies added / removed / context lines', () => {
    expect(classifyDiffLine('+const x = 1;')).toBe('add');
    expect(classifyDiffLine('-const x = 0;')).toBe('del');
    expect(classifyDiffLine(' unchanged')).toBe('context');
    expect(classifyDiffLine('')).toBe('context');
  });

  it('classifies hunk headers and file metadata (not as add/del)', () => {
    expect(classifyDiffLine('@@ -1,4 +1,5 @@')).toBe('hunk');
    expect(classifyDiffLine('+++ b/src/a.ts')).toBe('meta');
    expect(classifyDiffLine('--- a/src/a.ts')).toBe('meta');
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta');
    expect(classifyDiffLine('index 1234..5678 100644')).toBe('meta');
    expect(classifyDiffLine('new file mode 100644')).toBe('meta');
  });
});
