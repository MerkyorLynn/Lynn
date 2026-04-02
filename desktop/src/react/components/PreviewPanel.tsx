/**
 * PreviewPanel — Artifact 预览/编辑面板
 *
 * 从 Zustand store 读取 artifacts / activeTabId / previewOpen 状态。
 * 可编辑类型（有 filePath 的 markdown/code/csv）使用 CodeMirror 编辑器。
 *
 * 架构原则：
 * - 文件系统是 source of truth，编辑器直接对接文件
 * - 文件型 artifact 的 content 不回写 store（避免双源）
 * - ArtifactEditor 不依赖 PreviewPanel，可脱离到独立窗口
 */

import { useCallback, useEffect, lazy, Suspense } from 'react';
import { useStore } from '../stores';
import { ArtifactRenderer } from './preview/ArtifactRenderer';
import { TabBar } from './preview/TabBar';
import { FloatingActions } from './preview/FloatingActions';
import { captureSelection, clearSelection } from '../stores/selection-actions';
import type { Artifact } from '../types';
import previewStyles from './Preview.module.css';

const ArtifactEditor = lazy(() => import('./ArtifactEditor').then((m) => ({ default: m.ArtifactEditor })));

const EDITABLE_TYPES = new Set(['markdown', 'code', 'csv']);

function isEditable(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  return !!artifact.filePath && EDITABLE_TYPES.has(artifact.type);
}

function getEditorMode(artifact: Artifact): 'markdown' | 'code' | 'text' {
  if (artifact.type === 'markdown') return 'markdown';
  return 'code';
}

function artifactExt(artifact: Artifact | null): string {
  if (!artifact) return 'txt';
  if (artifact.ext) return artifact.ext;
  if (artifact.type === 'markdown') return 'md';
  if (artifact.type === 'html') return 'html';
  if (artifact.type === 'csv') return 'csv';
  if (artifact.type === 'svg') return 'svg';
  if (artifact.type === 'pdf') return 'pdf';
  if (artifact.type === 'docx') return 'docx';
  if (artifact.type === 'xlsx') return 'xlsx';
  if (artifact.type === 'image') return 'png';
  return artifact.language || 'txt';
}

export function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const activeTabId = useStore(s => s.activeTabId);
  const artifacts = useStore(s => s.artifacts);
  const editorDetached = useStore(s => s.editorDetached);
  const setPreviewOpen = useStore(s => s.setPreviewOpen);
  const setEditorDetached = useStore(s => s.setEditorDetached);

  const artifact = artifacts.find(a => a.id === activeTabId) ?? null;
  const editable = isEditable(artifact);

  // 拆分到独立窗口
  const handleDetach = useCallback(() => {
    if (!artifact?.filePath) return;
    setEditorDetached(true);
    setPreviewOpen(false);
    // 通过 IPC 打开编辑器窗口
    window.platform?.openEditorWindow?.({
      filePath: artifact.filePath,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
    });
  }, [artifact, setEditorDetached, setPreviewOpen]);

  const handleExport = useCallback(async () => {
    if (!artifact) return;
    if (artifact.filePath) {
      window.platform?.showInFinder?.(artifact.filePath);
      return;
    }

    const ext = artifactExt(artifact);
    const safeTitle = (artifact.title || 'lynn-export').replace(/[\\/:*?"<>|]/g, '-');
    const defaultPath = `${safeTitle}.${ext}`;
    const targetPath = await window.platform?.saveFileDialog?.({
      title: window.t?.('common.save') || 'Save',
      defaultPath,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!targetPath) return;

    const ok = await window.platform?.writeFile?.(targetPath, artifact.content);
    if (ok) {
      window.platform?.showInFinder?.(targetPath);
    }
  }, [artifact]);

  // DOM 模式选区捕获（非编辑模式下 mouseup 时检测选中文本）
  const handleMouseUp = useCallback(() => {
    if (!artifact || editable) return;
    captureSelection(artifact);
  }, [artifact, editable]);

  // 切换 tab 时清除选区
  useEffect(() => {
    clearSelection();
  }, [activeTabId]);

  return (
    <div className={`${previewStyles.previewPanel}${previewOpen ? '' : ` ${previewStyles.previewPanelCollapsed}`}`} id="previewPanel">
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <div className={previewStyles.previewPanelInner}>
        <TabBar />
        <div className={previewStyles.previewPanelBody} id="previewBody" onMouseUp={handleMouseUp}>
          {previewOpen && artifact && (
            <FloatingActions
              artifact={artifact}
              content={artifact.content}
              editable={editable}
              onDetach={handleDetach}
              onExport={handleExport}
            />
          )}
          {previewOpen && artifact && !editable && (
            <ArtifactRenderer artifact={artifact} />
          )}
          {previewOpen && artifact && editable && (
            <Suspense fallback={null}>
              <ArtifactEditor
                content={artifact.content}
                filePath={artifact.filePath}
                mode={getEditorMode(artifact)}
                language={artifact.language}
                onSelectionChange={(view) => {
                  if (artifact) captureSelection(artifact, view);
                }}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
