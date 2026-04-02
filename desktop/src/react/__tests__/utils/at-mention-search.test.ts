import { describe, expect, it } from 'vitest';
import { buildAtMentionResults, type AtMentionFileResult } from '../../utils/at-mention-search';
import type { WorkingSetFile } from '../../stores/input-slice';

function makeSearchResult(overrides: Partial<AtMentionFileResult> & Pick<AtMentionFileResult, 'path' | 'name'>): AtMentionFileResult {
  return {
    path: overrides.path,
    name: overrides.name,
    rel: overrides.rel ?? overrides.name,
    isDir: overrides.isDir ?? false,
  };
}

function makeRecentFile(overrides: Partial<WorkingSetFile> & Pick<WorkingSetFile, 'path' | 'name'>): WorkingSetFile {
  return {
    path: overrides.path,
    name: overrides.name,
    source: overrides.source ?? 'recent',
    isDirectory: overrides.isDirectory,
  };
}

describe('at-mention-search', () => {
  it('将 recent 与搜索结果合并，按 relevance 再按 recent 排序', () => {
    const results = buildAtMentionResults({
      query: 'app',
      recentFiles: [
        makeRecentFile({ path: '/repo/src/z-app.ts', name: 'z-app.ts' }),
        makeRecentFile({ path: '/repo/src/app-header.ts', name: 'app-header.ts' }),
      ],
      searchResults: [
        makeSearchResult({ path: '/repo/src/app.ts', name: 'app.ts', rel: 'src/app.ts' }),
        makeSearchResult({ path: '/repo/docs/app-notes.md', name: 'app-notes.md', rel: 'docs/app-notes.md' }),
      ],
      basePath: '/repo',
    });

    expect(results.map((file) => file.path)).toEqual([
      '/repo/src/app-header.ts',
      '/repo/src/app.ts',
      '/repo/docs/app-notes.md',
      '/repo/src/z-app.ts',
    ]);
  });

  it('按 path 去重，并优先保留搜索结果的 rel 与目录标记', () => {
    const results = buildAtMentionResults({
      query: 'docs',
      recentFiles: [
        makeRecentFile({ path: '/repo/docs', name: 'docs', isDirectory: true, source: 'desk' }),
      ],
      searchResults: [
        makeSearchResult({ path: '/repo/docs', name: 'docs', rel: 'docs', isDir: true }),
      ],
      basePath: '/repo',
    });

    expect(results).toEqual([
      { path: '/repo/docs', name: 'docs', rel: 'docs', isDir: true },
    ]);
  });

  it('允许仅 recent 命中时也展示结果，并生成相对路径', () => {
    const results = buildAtMentionResults({
      query: 'read',
      recentFiles: [
        makeRecentFile({ path: '/repo/docs/README.md', name: 'README.md' }),
        makeRecentFile({ path: '/outside/README.md', name: 'README.md' }),
      ],
      searchResults: [],
      basePath: '/repo',
    });

    expect(results).toEqual([
      { path: '/repo/docs/README.md', name: 'README.md', rel: 'docs/README.md', isDir: false },
      { path: '/outside/README.md', name: 'README.md', rel: '/outside/README.md', isDir: false },
    ]);
  });

  it('忽略 recent 与搜索都不匹配 query 的文件', () => {
    const results = buildAtMentionResults({
      query: 'spec',
      recentFiles: [makeRecentFile({ path: '/repo/src/app.ts', name: 'app.ts' })],
      searchResults: [makeSearchResult({ path: '/repo/docs/readme.md', name: 'readme.md', rel: 'docs/readme.md' })],
      basePath: '/repo',
    });

    expect(results).toEqual([]);
  });
});
