import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import {
  closeDeskDocument,
  loadDeskAutomationStatus,
  openDeskDocument,
  saveDeskDocument,
  shouldOpenDeskInline,
} from '../../stores/desk-actions';

describe('desk-actions document mode', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('window', {
      t: (key: string) => key,
    });
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({
      deskBasePath: '/Users/lynn/Desktop/Lynn',
      deskCurrentPath: '',
      deskOpenDoc: null,
      jianOpen: false,
      toasts: [],
      serverPort: '8787',
      serverToken: 'test-token',
    });
  });

  afterEach(() => {
    closeDeskDocument();
    vi.unstubAllGlobals();
  });

  it('识别应在右侧书桌内打开的 Markdown 文档', () => {
    expect(shouldOpenDeskInline('note.md')).toBe(true);
    expect(shouldOpenDeskInline('README.markdown')).toBe(true);
    expect(shouldOpenDeskInline('data.txt')).toBe(true);
    expect(shouldOpenDeskInline('screenshot.png')).toBe(false);
  });

  it('打开 Markdown 文档时写入右侧书桌文档状态', async () => {
    fetchMock.mockResolvedValue(
      new Response('# hello', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const ok = await openDeskDocument('note.md');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/fs/read?path=%2FUsers%2Flynn%2FDesktop%2FLynn%2Fnote.md',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(useStore.getState().jianOpen).toBe(true);
    expect(useStore.getState().deskOpenDoc).toEqual({
      path: '/Users/lynn/Desktop/Lynn/note.md',
      name: 'note.md',
      content: '# hello',
    });
  });

  it('保存右侧书桌文档时直接写回原文件', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('# hello', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    await openDeskDocument('note.md');

    const ok = await saveDeskDocument('# updated');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8787/api/fs/apply',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          filePath: '/Users/lynn/Desktop/Lynn/note.md',
          content: '# updated',
        }),
      }),
    );
    expect(useStore.getState().deskOpenDoc?.content).toBe('# updated');
  });

  it('按当前工作区过滤自动任务并更新书桌状态', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        jobs: [
          {
            id: 'job_1',
            label: '晨间扫描',
            enabled: true,
            workspace: '/Users/lynn/Desktop/Lynn',
            schedule: '0 9 * * 1,2,3,4,5',
            nextRunAt: '2026-04-06T09:00:00.000Z',
          },
          {
            id: 'job_2',
            label: '别的项目',
            enabled: true,
            workspace: '/Users/lynn/Desktop/Other',
            schedule: '0 10 * * *',
            nextRunAt: '2026-04-06T10:00:00.000Z',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await loadDeskAutomationStatus();

    expect(useStore.getState().automationCount).toBe(2);
    expect(useStore.getState().deskAutomationJobs).toHaveLength(1);
    expect(useStore.getState().deskAutomationJobs[0]?.label).toBe('晨间扫描');
    expect(useStore.getState().deskAutomationStatus?.count).toBe(1);
    expect(String(useStore.getState().deskAutomationStatus?.text || '')).toContain('自动任务');
  });
});
