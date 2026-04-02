import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>\n`,
}));

import { buildItemsFromHistory, type HistoryApiResponse } from '../../utils/history-builder';

describe('history-builder', () => {
  it('重建用户消息的 requestText、requestImages，并去掉 steer 前缀', () => {
    const history: HistoryApiResponse = {
      messages: [{
        id: 'u1',
        role: 'user',
        content: '（插话，无需 MOOD）\n请接着做\n\n[附件] /repo/spec.md\n[引用片段] /repo/src/app.ts · 行 4-5 · 12 字符\nconst x = 1',
        images: [{ data: 'base64-image', mimeType: 'image/png' }],
      }],
    };

    const items = buildItemsFromHistory(history);
    const message = items[0];
    if (message.type !== 'message' || message.data.role !== 'user') throw new Error('expected user message');

    expect(message.data.text).toContain('请接着做');
    expect(message.data.requestText).toContain('请接着做');
    expect(message.data.requestText).not.toContain('（插话，无需 MOOD）');
    expect(message.data.attachments).toEqual([
      { path: '/repo/spec.md', name: 'spec.md', isDir: false },
      { path: 'image-0', name: 'image-0.png', isDir: false, base64Data: 'base64-image', mimeType: 'image/png' },
    ]);
    expect(message.data.requestImages).toEqual([
      { type: 'image', data: 'base64-image', mimeType: 'image/png' },
    ]);
    expect(message.data.quotedText).toBe('/repo/src/app.ts · 行 4-5 · 12 字符');
  });

  it('把文件输出和 artifact 追加到对应 assistant 消息后', () => {
    const history: HistoryApiResponse = {
      messages: [
        { id: 'a0', role: 'assistant', content: '第一条回复' },
        { id: 'a1', role: 'assistant', content: '第二条回复' },
      ],
      fileOutputs: [{
        afterIndex: 1,
        files: [{ filePath: '/repo/out.txt', label: 'out.txt', ext: 'txt' }],
      }],
      artifacts: [{
        afterIndex: 1,
        artifactId: 'art-1',
        artifactType: 'markdown',
        title: 'Spec',
        content: '# spec',
      }],
    };

    const items = buildItemsFromHistory(history);
    const second = items[1];
    if (second.type !== 'message' || second.data.role !== 'assistant') throw new Error('expected assistant message');

    expect(second.data.blocks).toEqual([
      { type: 'text', html: '<p>第二条回复</p>\n' },
      { type: 'file_output', filePath: '/repo/out.txt', label: 'out.txt', ext: 'txt' },
      { type: 'artifact', artifactId: 'art-1', artifactType: 'markdown', title: 'Spec', content: '# spec', language: undefined },
    ]);
  });

  it('重建 settings confirm、cron confirm 和普通工具组', () => {
    const history: HistoryApiResponse = {
      messages: [{
        id: 'a2',
        role: 'assistant',
        content: '已处理',
        toolCalls: [
          { name: 'update_settings', args: { action: 'apply', key: 'sandbox', value: 'workspace-write' } },
          { name: 'cron', args: { action: 'add', type: 'daily', schedule: '0 9 * * *', prompt: '总结', label: '每日总结' } },
          { name: 'read', args: { file_path: '/repo/src/app.ts' } },
        ],
      }],
    };

    const items = buildItemsFromHistory(history);
    const message = items[0];
    if (message.type !== 'message' || message.data.role !== 'assistant') throw new Error('expected assistant message');

    expect(message.data.blocks).toEqual([
      {
        type: 'settings_confirm',
        confirmId: '',
        settingKey: 'sandbox',
        cardType: 'toggle',
        currentValue: '',
        proposedValue: 'workspace-write',
        label: 'sandbox',
        status: 'confirmed',
      },
      {
        type: 'cron_confirm',
        jobData: { type: 'daily', schedule: '0 9 * * *', prompt: '总结', label: '每日总结' },
        status: 'approved',
      },
      {
        type: 'tool_group',
        tools: [{ name: 'read', args: { file_path: '/repo/src/app.ts' }, done: true, success: true }],
        collapsed: false,
      },
      { type: 'text', html: '<p>已处理</p>\n' },
    ]);
  });
});
