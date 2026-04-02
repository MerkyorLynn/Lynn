import { beforeEach, describe, expect, it } from 'vitest';
import { createInputSlice, type InputSlice } from '../../stores/input-slice';

function makeSlice(): InputSlice {
  let state: InputSlice;
  const get = () => state;
  const set = (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createInputSlice(set, get);
  return new Proxy({} as InputSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('input-slice', () => {
  let slice: InputSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态 quotedSelection 为 null', () => {
    expect(slice.quotedSelection).toBeNull();
  });

  it('setQuotedSelection 设置引用', () => {
    const sel = {
      text: '玻色子',
      sourceTitle: '百科全书',
      sourceFilePath: '/path/to/file.md',
      lineStart: 12,
      lineEnd: 15,
      charCount: 128,
    };
    slice.setQuotedSelection(sel);
    expect(slice.quotedSelection).toEqual(sel);
  });

  it('clearQuotedSelection 清除引用', () => {
    slice.setQuotedSelection({ text: 'test', sourceTitle: 'title', charCount: 4 });
    slice.clearQuotedSelection();
    expect(slice.quotedSelection).toBeNull();
  });

  it('setQuotedSelection 覆盖旧值', () => {
    slice.setQuotedSelection({ text: 'old', sourceTitle: 'A', charCount: 3 });
    slice.setQuotedSelection({ text: 'new', sourceTitle: 'B', charCount: 3 });
    expect(slice.quotedSelection!.text).toBe('new');
    expect(slice.quotedSelection!.sourceTitle).toBe('B');
  });

  it('save/restore composer draft 保留完整草稿和 working set', () => {
    slice.setComposerText('draft text');
    slice.setAttachedFiles([{ path: '/repo/spec.md', name: 'spec.md' }]);
    slice.setQuotedSelection({ text: 'quoted', sourceTitle: 'spec.md', charCount: 6 });
    slice.setDocContextFile({ path: '/repo/doc.md', name: 'doc.md' });
    slice.rememberWorkingSetFile({ path: '/repo/spec.md', name: 'spec.md', source: 'recent' });
    slice.saveComposerDraft('session-a');

    slice.clearComposerState();
    slice.clearQuotedSelection();
    slice.setAttachedFiles([]);
    slice.applyComposerDraft({ workingSet: [] });

    slice.restoreComposerDraft('session-a');

    expect(slice.composerText).toBe('draft text');
    expect(slice.attachedFiles).toEqual([{ path: '/repo/spec.md', name: 'spec.md' }]);
    expect(slice.quotedSelection).toEqual({ text: 'quoted', sourceTitle: 'spec.md', charCount: 6 });
    expect(slice.docContextFile).toEqual({ path: '/repo/doc.md', name: 'doc.md' });
    expect(slice.docContextAttached).toBe(true);
    expect(slice.workingSetRecentFiles).toEqual([{ path: '/repo/spec.md', name: 'spec.md', source: 'recent' }]);
  });

  it('applyComposerDraft 支持部分更新并同步 docContextAttached', () => {
    slice.setComposerText('before');
    slice.setAttachedFiles([{ path: '/repo/a.ts', name: 'a.ts' }]);
    slice.setDocContextFile({ path: '/repo/doc.md', name: 'doc.md' });

    slice.applyComposerDraft({
      text: 'after',
      quotedSelection: { text: 'quoted', sourceTitle: 'doc.md', charCount: 6 },
      docContextFile: null,
      workingSet: [{ path: '/repo/b.ts', name: 'b.ts', source: 'recent' }],
    });

    expect(slice.composerText).toBe('after');
    expect(slice.attachedFiles).toEqual([{ path: '/repo/a.ts', name: 'a.ts' }]);
    expect(slice.quotedSelection).toEqual({ text: 'quoted', sourceTitle: 'doc.md', charCount: 6 });
    expect(slice.docContextFile).toBeNull();
    expect(slice.docContextAttached).toBe(false);
    expect(slice.workingSetRecentFiles).toEqual([{ path: '/repo/b.ts', name: 'b.ts', source: 'recent' }]);
  });

  it('last submitted draft 可设置恢复和清理', () => {
    const draft = {
      text: 'last prompt',
      attachedFiles: [{ path: '/repo/a.ts', name: 'a.ts' }],
      quotedSelection: { text: 'quoted', sourceTitle: 'a.ts', charCount: 6 },
      docContextFile: { path: '/repo/doc.md', name: 'doc.md' },
      workingSet: [{ path: '/repo/a.ts', name: 'a.ts', source: 'recent' as const }],
    };

    slice.setLastSubmittedDraft('session-a', draft);
    slice.restoreLastSubmittedDraft('session-a');

    expect(slice.composerText).toBe('last prompt');
    expect(slice.docContextAttached).toBe(true);
    expect(slice.lastSubmittedDrafts['session-a']).toEqual(draft);

    slice.clearLastSubmittedDraft('session-a');
    expect(slice.lastSubmittedDrafts['session-a']).toBeUndefined();
  });

  it('rememberWorkingSetFile 按 path 去重并限制 12 条', () => {
    for (let i = 0; i < 13; i += 1) {
      slice.rememberWorkingSetFile({ path: `/repo/${i}.ts`, name: `${i}.ts`, source: 'recent' });
    }
    slice.rememberWorkingSetFile({ path: '/repo/5.ts', name: '5.ts', source: 'recent' });

    expect(slice.workingSetRecentFiles).toHaveLength(12);
    expect(slice.workingSetRecentFiles[0]).toEqual({ path: '/repo/5.ts', name: '5.ts', source: 'recent' });
    expect(slice.workingSetRecentFiles.some((file) => file.path === '/repo/0.ts')).toBe(false);
  });

  it('doc context setters 和 toggle 保持一致', () => {
    slice.setDocContextAttached(true, { path: '/repo/a.md', name: 'a.md' });
    expect(slice.docContextAttached).toBe(true);
    expect(slice.docContextFile).toEqual({ path: '/repo/a.md', name: 'a.md' });

    slice.toggleDocContext();
    expect(slice.docContextAttached).toBe(false);
    expect(slice.docContextFile).toBeNull();

    slice.toggleDocContext({ path: '/repo/b.md', name: 'b.md' });
    expect(slice.docContextAttached).toBe(true);
    expect(slice.docContextFile).toEqual({ path: '/repo/b.md', name: 'b.md' });
  });
});
