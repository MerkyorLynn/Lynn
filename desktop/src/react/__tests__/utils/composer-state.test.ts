import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import {
  PENDING_COMPOSER_KEY,
  buildQuotedSelectionSummary,
  buildRetryDraftFromMessage,
  fileToWorkingSet,
  formatQuotedSelectionPrompt,
  getComposerSessionKey,
  mergeWorkingSetFiles,
  resolveDocContextToggle,
  toggleComposerAttachment,
} from '../../utils/composer-state';

describe('composer-state', () => {
  it('getComposerSessionKey 在 pending/new session 时返回保留 key', () => {
    expect(getComposerSessionKey(null, false)).toBe(PENDING_COMPOSER_KEY);
    expect(getComposerSessionKey('/sessions/a', true)).toBe(PENDING_COMPOSER_KEY);
    expect(getComposerSessionKey('/sessions/a', false)).toBe('/sessions/a');
  });

  it('buildQuotedSelectionSummary 输出文件范围摘要', () => {
    const summary = buildQuotedSelectionSummary({
      text: 'const value = 1;',
      sourceTitle: 'app.ts',
      sourceFilePath: '/repo/src/app.ts',
      lineStart: 8,
      lineEnd: 12,
      charCount: 16,
    });

    expect(summary).toBe('/repo/src/app.ts · L8-12 · 16 chars');
  });

  it('formatQuotedSelectionPrompt 输出可发送的引用片段提示', () => {
    const prompt = formatQuotedSelectionPrompt({
      text: 'const value = 1;',
      sourceTitle: 'app.ts',
      sourceFilePath: '/repo/src/app.ts',
      lineStart: 8,
      lineEnd: 12,
      charCount: 16,
    });

    expect(prompt).toBe('[引用片段] /repo/src/app.ts · 行 8-12 · 16 字符\nconst value = 1;');
  });

  it('buildRetryDraftFromMessage 优先使用 retryDraft 并深拷贝', () => {
    const message: ChatMessage = {
      id: 'u1',
      role: 'user',
      text: 'retry this',
      retryDraft: {
        text: 'draft text',
        attachedFiles: [{ path: '/tmp/a.txt', name: 'a.txt' }],
        quotedSelection: { text: 'quoted', sourceTitle: 'a.txt', charCount: 6 },
        docContextFile: { path: '/docs/spec.md', name: 'spec.md' },
        workingSet: [{ path: '/tmp/a.txt', name: 'a.txt', source: 'recent' }],
      },
      attachments: [{ path: '/tmp/ignored.txt', name: 'ignored.txt', isDir: false }],
    };

    const draft = buildRetryDraftFromMessage(message);

    expect(draft).toEqual({
      ...message.retryDraft,
      docContextFile: null,
    });
    message.retryDraft!.attachedFiles[0].name = 'changed.txt';
    expect(draft.attachedFiles[0].name).toBe('a.txt');
  });

  it('buildRetryDraftFromMessage 回退到 quotedSelection 和附件', () => {
    const message: ChatMessage = {
      id: 'u2',
      role: 'user',
      text: 'look here',
      quotedSelection: {
        text: 'line one',
        sourceTitle: 'src.ts',
        sourceFilePath: '/repo/src.ts',
        lineStart: 2,
        lineEnd: 2,
        charCount: 8,
      },
      attachments: [
        { path: '/repo/src.ts', name: 'src.ts', isDir: false },
        { path: '/repo/docs', name: 'docs', isDir: true },
      ],
    };

    const draft = buildRetryDraftFromMessage(message);

    expect(draft.text).toBe('look here');
    expect(draft.quotedSelection).toEqual(message.quotedSelection);
    expect(draft.attachedFiles).toEqual([
      { path: '/repo/src.ts', name: 'src.ts', isDirectory: false, base64Data: undefined, mimeType: undefined },
      { path: '/repo/docs', name: 'docs', isDirectory: true, base64Data: undefined, mimeType: undefined },
    ]);
    expect(draft.workingSet).toEqual([
      { path: '/repo/src.ts', name: 'src.ts', source: 'recent', isDirectory: false },
      { path: '/repo/docs', name: 'docs', source: 'desk', isDirectory: true },
    ]);
  });

  it('buildRetryDraftFromMessage 在只有 quotedText 时构造回退引用', () => {
    const message: ChatMessage = {
      id: 'u3',
      role: 'user',
      text: 'Summarize this selection',
      quotedText: 'const answer = 42',
    };

    const draft = buildRetryDraftFromMessage(message);

    expect(draft.quotedSelection).toEqual({
      text: 'const answer = 42',
      sourceTitle: 'Summarize this selection',
      charCount: 'const answer = 42'.length,
    });
  });

  it('mergeWorkingSetFiles 按首次出现顺序去重', () => {
    const merged = mergeWorkingSetFiles(
      [
        { path: '/a', name: 'a', source: 'recent' },
        { path: '/b', name: 'b', source: 'recent' },
      ],
      [
        { path: '/b', name: 'b2', source: 'desk', isDirectory: true },
        { path: '/c', name: 'c', source: 'current' },
      ],
      null,
      undefined,
    );

    expect(merged).toEqual([
      { path: '/a', name: 'a', source: 'recent' },
      { path: '/b', name: 'b', source: 'recent' },
      { path: '/c', name: 'c', source: 'current' },
    ]);
  });

  it('toggleComposerAttachment 可二次取消附件', () => {
    const file = { path: '/repo/spec.md', name: 'spec.md' };
    const attached = toggleComposerAttachment([], file);
    expect(attached).toEqual([{ path: '/repo/spec.md', name: 'spec.md' }]);
    expect(toggleComposerAttachment(attached, file)).toEqual([]);
  });

  it('resolveDocContextToggle 同一路径二次点击时会取消文档上下文', () => {
    expect(resolveDocContextToggle('/repo/doc.md', { path: '/repo/doc.md', name: 'doc.md' })).toEqual({
      attached: false,
      file: null,
    });
    expect(resolveDocContextToggle('/repo/other.md', { path: '/repo/doc.md', name: 'doc.md' })).toEqual({
      attached: true,
      file: { path: '/repo/doc.md', name: 'doc.md' },
    });
  });

  it('fileToWorkingSet 保留目录标记', () => {
    expect(fileToWorkingSet({ path: '/repo/docs', name: 'docs' }, 'desk', true)).toEqual({
      path: '/repo/docs',
      name: 'docs',
      source: 'desk',
      isDirectory: true,
    });
  });
});
