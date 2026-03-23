/**
 * artifact-actions.ts — Artifact 预览管理
 *
 * 从 artifacts-shim.ts 迁移。纯 Zustand store 操作 + updateLayout。
 */

import { useStore } from './index';
import { updateLayout } from '../components/SidebarLayout';
import type { Artifact } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any -- IPC callback data */

let _artifactCounter = 0;

/** 注册 artifact 并打开为 tab */
export function openPreview(artifact: Artifact): void {
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
  s.openTab(artifact.id);
  s.setPreviewOpen(true);
  updateLayout();
}

/** 关闭面板（保留 openTabs 状态，下次 openTab 时恢复） */
export function closePreview(): void {
  const s = useStore.getState();
  s.setPreviewOpen(false);
  useStore.setState({ activeTabId: null });
  updateLayout();
}

/** 注册 artifact 到全局 store（流式事件用） */
export function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
  };
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
}

/** Save/restore tab state helpers (used by session-actions) */
export function saveTabState(sessionPath: string): void {
  useStore.getState().saveTabState(sessionPath);
}

export function restoreTabState(sessionPath: string): void {
  const s = useStore.getState();
  s.restoreTabState(sessionPath);
  const after = useStore.getState();
  if (after.openTabs.length > 0) {
    s.setPreviewOpen(true);
    updateLayout();
  }
}

/**
 * 注册编辑器 dock/detach 事件监听
 * 在 App mount 时调用一次
 */
export function initEditorEvents(): void {
  window.platform?.onEditorDockFile?.((data: any) => {
    const s = useStore.getState();
    const existing = s.artifacts.find(a => a.filePath === data.filePath);
    if (existing) {
      openPreview(existing);
    } else {
      window.platform?.readFile(data.filePath).then((content: string | null) => {
        if (content == null) return;
        const artifact: Artifact = {
          id: `file-${data.filePath}`,
          type: data.type,
          title: data.title,
          content,
          filePath: data.filePath,
          language: data.language,
        };
        openPreview(artifact);
      });
    }
    useStore.getState().setEditorDetached(false);
  });

  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
    if (detached) {
      const s = useStore.getState();
      if (s.activeTabId) {
        s.closeTab(s.activeTabId);
        if (useStore.getState().openTabs.length === 0) {
          closePreview();
        }
      }
    }
  });
}
