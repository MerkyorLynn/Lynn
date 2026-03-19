/**
 * artifacts-shim.ts — Artifact 预览管理
 *
 * DOM 渲染函数（appendArtifactCard / appendBrowserScreenshot）已删除，
 * 由 React ContentBlock 组件替代。
 * 保留：openPreview / closePreview / handleArtifact（store 操作）+ 编辑器事件。
 */

import { useStore } from '../stores';
import type { Artifact } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

let _artifactCounter = 0;

export function openPreview(artifact: Artifact): void {
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
  s.setCurrentArtifactId(artifact.id);
  s.setPreviewOpen(true);
  const mods = (window as any).HanaModules as Record<string, any> | undefined;
  const sidebarMod = mods?.sidebar as { updateLayout?: () => void } | undefined;
  sidebarMod?.updateLayout?.();
}

export function closePreview(): void {
  const s = useStore.getState();
  s.setPreviewOpen(false);
  s.setCurrentArtifactId(null);
  const mods = (window as any).HanaModules as Record<string, any> | undefined;
  const sidebarMod = mods?.sidebar as { updateLayout?: () => void } | undefined;
  sidebarMod?.updateLayout?.();
}

/** 注册 artifact 到全局 store（流式事件 + 点击卡片都走这里） */
function handleArtifact(data: Record<string, unknown>): void {
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

export function setupArtifactsShim(modules: Record<string, unknown>): void {
  modules.artifacts = {
    handleArtifact,
    renderBrowserCard: () => {},
    openPreview,
    closePreview,
    initArtifacts: () => {},
  };

  // 编辑器窗口 dock 回来时，重新在主窗口打开预览
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

  // 编辑器窗口关闭/隐藏时，同步状态
  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
  });
}
