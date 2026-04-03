import { describe, it, expect } from 'vitest';
import {
  parseMoodFromContent,
  parseXingFromContent,
  parseUserAttachments,
  cleanMoodText,
  truncatePath,
  extractHostname,
  truncateHead,
  extractToolDetail,
  moodLabel,
} from '../../utils/message-parser';

describe('parseMoodFromContent', () => {
  it('无 mood 标签返回原文', () => {
    const result = parseMoodFromContent('hello world');
    expect(result.mood).toBeNull();
    expect(result.yuan).toBeNull();
    expect(result.text).toBe('hello world');
  });

  it('空内容返回空', () => {
    const result = parseMoodFromContent('');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('');
  });

  it('解析 <mood> 标签', () => {
    const input = '<mood>feeling good</mood>\n\nSome text here.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('feeling good');
    expect(result.yuan).toBe('hanako');
    expect(result.text).toBe('Some text here.');
  });

  it('解析 <pulse> 标签映射到 butter', () => {
    const input = '<pulse>energetic</pulse>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('energetic');
    expect(result.yuan).toBe('butter');
  });

  it('解析 <reflect> 标签映射到 lynn', () => {
    const input = '<reflect>pondering</reflect>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('pondering');
    expect(result.yuan).toBe('lynn');
  });

  it('mood 内容去除代码块包裹', () => {
    const input = '<mood>```\nline1\nline2\n```</mood>\nText.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('line1\nline2');
  });
});

describe('cleanMoodText', () => {
  it('去除代码块标记和首尾空行', () => {
    expect(cleanMoodText('```markdown\ncontent\n```')).toBe('content');
  });

  it('纯文本不变', () => {
    expect(cleanMoodText('just text')).toBe('just text');
  });
});

describe('parseXingFromContent', () => {
  it('无 xing 标签返回原文', () => {
    const result = parseXingFromContent('no xing here');
    expect(result.xingBlocks).toEqual([]);
    expect(result.text).toBe('no xing here');
  });

  it('解析单个 xing 块', () => {
    const input = 'Before.\n<xing title="Test">xing content</xing>\nAfter.';
    const result = parseXingFromContent(input);
    expect(result.xingBlocks).toHaveLength(1);
    expect(result.xingBlocks[0].title).toBe('Test');
    expect(result.xingBlocks[0].content).toBe('xing content');
    expect(result.text).toContain('Before.');
    expect(result.text).toContain('After.');
  });

  it('解析多个 xing 块', () => {
    const input = '<xing title="A">aaa</xing>\n<xing title="B">bbb</xing>';
    const result = parseXingFromContent(input);
    expect(result.xingBlocks).toHaveLength(2);
    expect(result.xingBlocks[0].title).toBe('A');
    expect(result.xingBlocks[1].title).toBe('B');
  });
});

describe('parseUserAttachments', () => {
  it('纯文本无附件', () => {
    const result = parseUserAttachments('hello');
    expect(result.text).toBe('hello');
    expect(result.files).toEqual([]);
    expect(result.deskContext).toBeNull();
    expect(result.gitContext).toBeNull();
  });

  it('空内容', () => {
    const result = parseUserAttachments('');
    expect(result.text).toBe('');
    expect(result.files).toEqual([]);
  });

  it('解析文件附件', () => {
    const input = 'Some text\n[附件] /path/to/file.txt';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('Some text');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('/path/to/file.txt');
    expect(result.files[0].name).toBe('file.txt');
    expect(result.files[0].isDirectory).toBe(false);
  });

  it('解析目录附件', () => {
    const input = '[目录] /path/to/dir';
    const result = parseUserAttachments(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].isDirectory).toBe(true);
  });

  it('解析参考文档附件', () => {
    const input = '这个\n\n[参考文档] /Users/test/docs/note.md';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('这个');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('/Users/test/docs/note.md');
    expect(result.files[0].name).toBe('note.md');
    expect(result.files[0].isDirectory).toBe(false);
  });

  it('解析书桌上下文', () => {
    const input = '[当前书桌目录] /home/user/desk\n  file1.txt\n  file2.txt\nSome text';
    const result = parseUserAttachments(input);
    expect(result.deskContext).not.toBeNull();
    expect(result.deskContext!.dir).toBe('/home/user/desk');
    expect(result.deskContext!.fileCount).toBe(2);
    expect(result.text).toBe('Some text');
  });

  it('解析 Git 上下文并从正文里剥离结构化行', () => {
    const input = '帮我看一下这次改动\n\n[Git 上下文] repo=openhanako; branch=main; changed=4; staged=2; unstaged=1; untracked=3; ahead=1; behind=0\n[Git 根目录] /repo\n[Git 变更] src/app.ts\n[Git 提交] abc123 feat: test';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('帮我看一下这次改动');
    expect(result.gitContext).toEqual({
      repoName: 'openhanako',
      branch: 'main',
      changedCount: 4,
    });
  });
});

describe('truncatePath', () => {
  it('短路径不截断', () => {
    expect(truncatePath('/short')).toBe('/short');
  });

  it('长路径截断带省略号', () => {
    const long = '/very/long/path/that/exceeds/thirty/five/chars/file.txt';
    const result = truncatePath(long);
    expect(result.startsWith('…')).toBe(true);
    expect(result.length).toBe(35);
  });

  it('空字符串返回空', () => {
    expect(truncatePath('')).toBe('');
  });
});

describe('extractHostname', () => {
  it('提取域名', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com');
  });

  it('无效 URL 返回原文', () => {
    expect(extractHostname('not-a-url')).toBe('not-a-url');
  });

  it('空字符串返回空', () => {
    expect(extractHostname('')).toBe('');
  });
});

describe('truncateHead', () => {
  it('短文本不截断', () => {
    expect(truncateHead('short', 10)).toBe('short');
  });

  it('长文本截断带省略号', () => {
    expect(truncateHead('this is long text', 10)).toBe('this is l…');
  });
});

describe('extractToolDetail', () => {
  it('read 工具提取文件路径', () => {
    expect(extractToolDetail('read', { file_path: '/a/b.txt' })).toContain('b.txt');
  });

  it('bash 工具提取命令', () => {
    expect(extractToolDetail('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('web_search 提取查询', () => {
    expect(extractToolDetail('web_search', { query: 'test query' })).toBe('test query');
  });

  it('未知工具返回空', () => {
    expect(extractToolDetail('unknown_tool', { foo: 'bar' })).toBe('');
  });

  it('无 args 返回空', () => {
    expect(extractToolDetail('read', undefined)).toBe('');
  });
});

describe('moodLabel', () => {
  it('hanako 返回 MOOD', () => {
    expect(moodLabel('hanako')).toContain('MOOD');
  });

  it('butter 返回 PULSE', () => {
    expect(moodLabel('butter')).toContain('PULSE');
  });

  it('未知 yuan 降级为 MOOD', () => {
    expect(moodLabel('unknown')).toContain('MOOD');
  });
});
