import { describe, expect, it, vi } from 'vitest';
import {
  buildAttachmentMeta,
  formatGitContextPrompt,
  prepareComposerTask,
  summarizeGitContext,
} from '../../utils/prompt-task';

const gitContext = {
  available: true,
  root: '/repo',
  repoName: 'openhanako',
  branch: 'main',
  ahead: 1,
  behind: 0,
  stagedCount: 2,
  unstagedCount: 1,
  untrackedCount: 3,
  totalChanged: 4,
  changedFiles: ['src/app.ts', 'README.md'],
  recentCommits: ['abc123 feat: test', 'def456 fix: bug'],
} as const;

describe('prompt-task', () => {
  it('buildAttachmentMeta 过滤图片并生成 working set', () => {
    const result = buildAttachmentMeta([
      { path: '/repo/spec.md', name: 'spec.md' },
      { path: '/repo/assets/logo.png', name: 'logo.png' },
      { path: '/repo/docs', name: 'docs', isDirectory: true },
    ]);

    expect(result.otherFiles).toEqual([
      { path: '/repo/spec.md', name: 'spec.md' },
      { path: '/repo/docs', name: 'docs', isDirectory: true },
    ]);
    expect(result.workingSet).toEqual([
      { path: '/repo/spec.md', name: 'spec.md', source: 'recent', isDirectory: false },
      { path: '/repo/docs', name: 'docs', source: 'desk', isDirectory: true },
    ]);
  });

  it('formatGitContextPrompt 和 summarizeGitContext 生成稳定摘要', () => {
    expect(summarizeGitContext(gitContext)).toBe('openhanako · main · 4 changed · ↑1');
    expect(formatGitContextPrompt(gitContext)).toContain('[Git 上下文] repo=openhanako; branch=main; changed=4; staged=2; unstaged=1; untracked=3; ahead=1; behind=0');
    expect(formatGitContextPrompt(gitContext)).toContain('[Git 根目录] /repo');
    expect(formatGitContextPrompt(gitContext)).toContain('[Git 变更] src/app.ts');
    expect(formatGitContextPrompt(gitContext)).toContain('[Git 提交] abc123 feat: test');
  });

  it('prepareComposerTask 为 prompt 组装 requestText、附件、图片与 working set', async () => {
    const readFileBase64 = vi.fn().mockResolvedValue('ZmFrZS1pbWFnZQ==');

    const prepared = await prepareComposerTask({
      mode: 'prompt',
      composerText: '请检查这些输入',
      attachedFiles: [
        { path: '/repo/notes/spec.md', name: 'spec.md' },
        { path: '/repo/assets/screen.png', name: 'screen.png' },
        { path: '/repo/docs', name: 'docs', isDirectory: true },
      ],
      docContextAttached: true,
      currentDoc: { path: '/repo/current.md', name: 'current.md' },
      quotedSelection: {
        text: 'const x = 1',
        sourceTitle: 'current.ts',
        sourceFilePath: '/repo/current.ts',
        lineStart: 4,
        lineEnd: 6,
        charCount: 11,
      },
      workingSetRecentFiles: [{ path: '/repo/seen.ts', name: 'seen.ts', source: 'recent' }],
      supportsVision: true,
      gitContext,
      readFileBase64,
    });

    expect(prepared.submission.mode).toBe('prompt');
    expect(prepared.submission.requestText).toContain('请检查这些输入');
    expect(prepared.submission.requestText).toContain('[附件] /repo/notes/spec.md');
    expect(prepared.submission.requestText).toContain('[目录] /repo/docs');
    expect(prepared.submission.requestText).toContain('[参考文档] /repo/current.md');
    expect(prepared.submission.requestText).toContain('[Git 上下文] repo=openhanako; branch=main; changed=4; staged=2; unstaged=1; untracked=3; ahead=1; behind=0');
    expect(prepared.submission.requestText).toContain('[Git 变更] src/app.ts');
    expect(prepared.submission.requestText).toContain('[引用片段] /repo/current.ts · 行 4-6 · 11 字符');
    expect(prepared.submission.quotedText).toBe('/repo/current.ts · L4-6 · 11 chars');
    expect(prepared.submission.images).toEqual([
      { type: 'image', data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
    ]);
    expect(prepared.submission.attachments).toEqual([
      { path: '/repo/notes/spec.md', name: 'spec.md', isDir: false, base64Data: undefined, mimeType: undefined },
      { path: '/repo/assets/screen.png', name: 'screen.png', isDir: false, base64Data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
      { path: '/repo/docs', name: 'docs', isDir: true, base64Data: undefined, mimeType: undefined },
      { path: '/repo/current.md', name: 'current.md', isDir: false, base64Data: undefined, mimeType: undefined },
    ]);
    expect(prepared.otherFiles).toEqual([
      { path: '/repo/notes/spec.md', name: 'spec.md' },
      { path: '/repo/docs', name: 'docs', isDirectory: true },
    ]);
    expect(prepared.docForRender).toEqual({ path: '/repo/current.md', name: 'current.md' });
    expect(prepared.draft.workingSet).toEqual([
      { path: '/repo/seen.ts', name: 'seen.ts', source: 'recent' },
      { path: '/repo/notes/spec.md', name: 'spec.md', source: 'recent', isDirectory: false },
      { path: '/repo/docs', name: 'docs', source: 'desk', isDirectory: true },
      { path: '/repo/current.md', name: 'current.md', source: 'current', isDirectory: false },
    ]);
    expect(readFileBase64).toHaveBeenCalledWith('/repo/assets/screen.png');
  });

  it('prepareComposerTask 在图片读取失败时降级为文本附件提示', async () => {
    const prepared = await prepareComposerTask({
      mode: 'prompt',
      composerText: '看下这张图',
      attachedFiles: [{ path: '/repo/screen.png', name: 'screen.png' }],
      docContextAttached: false,
      currentDoc: null,
      quotedSelection: null,
      workingSetRecentFiles: [],
      supportsVision: true,
      readFileBase64: vi.fn().mockRejectedValue(new Error('boom')),
    });

    expect(prepared.submission.requestText).toContain('[附件] /repo/screen.png');
    expect(prepared.submission.images).toBeUndefined();
    expect(prepared.submission.attachments).toEqual([
      { path: '/repo/screen.png', name: 'screen.png', isDir: false, base64Data: undefined, mimeType: undefined },
    ]);
  });

  it('prepareComposerTask 在 steer 模式只发送纯文本并保留 draft', async () => {
    const prepared = await prepareComposerTask({
      mode: 'steer',
      composerText: '继续执行第二步',
      attachedFiles: [{ path: '/repo/spec.md', name: 'spec.md' }],
      docContextAttached: true,
      currentDoc: { path: '/repo/current.md', name: 'current.md' },
      quotedSelection: { text: 'const y = 2', sourceTitle: 'current.ts', charCount: 11 },
      workingSetRecentFiles: [{ path: '/repo/existing.ts', name: 'existing.ts', source: 'recent' }],
      supportsVision: true,
      gitContext,
      readFileBase64: vi.fn(),
    });

    expect(prepared.submission).toEqual({
      mode: 'steer',
      text: '继续执行第二步',
      displayText: '继续执行第二步',
      requestText: '继续执行第二步',
      retryDraft: {
        text: '继续执行第二步',
        attachedFiles: [{ path: '/repo/spec.md', name: 'spec.md' }],
        quotedSelection: { text: 'const y = 2', sourceTitle: 'current.ts', charCount: 11 },
        docContextFile: null,
        workingSet: [
          { path: '/repo/existing.ts', name: 'existing.ts', source: 'recent' },
          { path: '/repo/spec.md', name: 'spec.md', source: 'recent', isDirectory: false },
        ],
      },
    });
    expect(prepared.docForRender).toBeNull();
    expect(prepared.otherFiles).toEqual([]);
  });

  it('prepareComposerTask 在只提到文件名但未附内容时，附加 @ 文件引导提示', async () => {
    const prepared = await prepareComposerTask({
      mode: 'prompt',
      composerText: 'App.tsx 第 45 行报错了，帮我看看',
      attachedFiles: [],
      docContextAttached: false,
      currentDoc: null,
      quotedSelection: null,
      workingSetRecentFiles: [],
      supportsVision: true,
    });

    expect(prepared.submission.requestText).toContain('App.tsx 第 45 行报错了，帮我看看');
    expect(prepared.submission.requestText).toContain('可以输入 @App.tsx 让我直接看这个文件');
  });

  it('prepareComposerTask 在用户提到当前工作区时，明确绑定到首选书桌工作区', async () => {
    const prepared = await prepareComposerTask({
      mode: 'prompt',
      composerText: '先快速读一下当前工作区，告诉我你会从哪里开始。',
      preferredWorkspace: '/Users/me/Desktop/Lynn',
      attachedFiles: [],
      docContextAttached: false,
      currentDoc: null,
      quotedSelection: null,
      workingSetRecentFiles: [],
      supportsVision: true,
    });

    expect(prepared.submission.requestText).toContain('/Users/me/Desktop/Lynn');
    expect(prepared.submission.requestText).toContain('不要擅自切去源码仓库、安装目录或别的 cwd');
  });

  it('prepareComposerTask 在用户明确提到源码仓库时，不注入书桌工作区提示', async () => {
    const prepared = await prepareComposerTask({
      mode: 'prompt',
      composerText: '先读一下当前源码仓库，告诉我从哪个目录开始。',
      preferredWorkspace: '/Users/me/Desktop/Lynn',
      attachedFiles: [],
      docContextAttached: false,
      currentDoc: null,
      quotedSelection: null,
      workingSetRecentFiles: [],
      supportsVision: true,
    });

    expect(prepared.submission.requestText).not.toContain('/Users/me/Desktop/Lynn');
    expect(prepared.submission.requestText).not.toContain('不要擅自切去源码仓库、安装目录或别的 cwd');
  });
});
