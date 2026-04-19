/**
 * use-writing-preview.ts — 写作模式自动预览
 *
 * 监听聊天消息中的 file_output / file_diff 事件，
 * 当检测到 .md 文件操作时自动在 PreviewPanel 打开预览。
 * 配合 writingMode 状态使用。
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { openPreview } from '../stores/artifact-actions';
import { updateLayout } from '../components/SidebarLayout';
import type { Artifact } from '../types';

const MD_EXTS = new Set(['md', 'markdown']);

function isMdPath(filePath: string): boolean {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return MD_EXTS.has(ext);
}

/**
 * 在写作模式下，自动监听消息流中的 MD 文件操作并打开预览。
 * 应在 ChatArea 或 App 层挂载。
 */
export function useWritingPreview(): void {
  const writingMode = useStore(s => s.writingMode);
  const lastFilePath = useRef<string | null>(null);

  useEffect(() => {
    if (!writingMode) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath || !isMdPath(detail.filePath)) return;

      // 避免同一文件重复打开
      if (detail.filePath === lastFilePath.current) {
        // 但如果是 file_diff/file_output，内容可能变了，刷新预览
        refreshPreview(detail.filePath);
        return;
      }

      lastFilePath.current = detail.filePath;
      openWritingPreview(detail.filePath);
    };

    window.addEventListener('hana-writing-file', handler);
    return () => window.removeEventListener('hana-writing-file', handler);
  }, [writingMode]);
}

async function openWritingPreview(filePath: string): Promise<void> {
  const content = await window.platform?.readFile?.(filePath);
  if (!content) return;

  const title = filePath.split('/').pop() || filePath;
  const artifact: Artifact = {
    id: `writing-${filePath}`,
    type: 'markdown',
    title,
    content,
    filePath,
  };

  openPreview(artifact);
}

async function refreshPreview(filePath: string): Promise<void> {
  const s = useStore.getState();
  const existingId = `writing-${filePath}`;
  const existing = s.artifacts.find(a => a.id === existingId);
  if (!existing) {
    openWritingPreview(filePath);
    return;
  }

  // 重新读取文件内容并更新 artifact
  const content = await window.platform?.readFile?.(filePath);
  if (!content) return;

  const updated: Artifact = { ...existing, content };
  const arts = s.artifacts.map(a => a.id === existingId ? updated : a);
  s.setArtifacts(arts);
}

/**
 * 进入写作模式：收起 Jian sidebar，开启写作布局。
 */
export function enterWritingMode(): void {
  const s = useStore.getState();
  s.setWritingMode(true);
  if (s.jianOpen) {
    s.setJianOpen(false);
  }
  updateLayout();
}

/**
 * 退出写作模式：恢复正常布局。
 */
export function exitWritingMode(): void {
  const s = useStore.getState();
  s.setWritingMode(false);
  updateLayout();
}
