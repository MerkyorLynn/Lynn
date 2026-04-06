import { describe, expect, it } from 'vitest';
import { resolvePreviewTarget } from '../../utils/file-preview';

describe('file-preview', () => {
  it('解析本地绝对路径和行号锚点', () => {
    expect(resolvePreviewTarget('/Users/lynn/openhanako/README.md#L12')).toEqual({
      filePath: '/Users/lynn/openhanako/README.md',
      ext: 'md',
    });
    expect(resolvePreviewTarget('/Users/lynn/openhanako/src/app.ts:18:3')).toEqual({
      filePath: '/Users/lynn/openhanako/src/app.ts',
      ext: 'ts',
    });
  });

  it('忽略远程链接', () => {
    expect(resolvePreviewTarget('https://example.com/doc.md')).toBeNull();
    expect(resolvePreviewTarget('mailto:test@example.com')).toBeNull();
  });

  it('支持 file URL', () => {
    expect(resolvePreviewTarget('file:///Users/lynn/openhanako/jian.md')).toEqual({
      filePath: '/Users/lynn/openhanako/jian.md',
      ext: 'md',
    });
  });
});
