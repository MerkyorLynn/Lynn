/**
 * file-preview.ts — 文件预览工具函数
 *
 * 从 file-cards-shim.ts 提取，供 React 组件直接 import。
 */

import { useStore } from '../stores';
import type { Artifact } from '../types';
import { openPreview } from '../stores/artifact-actions';


// ── 可在 Artifacts 面板中预览的文件类型 ──

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code', svg: 'svg',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['image', 'pdf']);

export function resolvePreviewTarget(rawHref: string | null | undefined): { filePath: string; ext: string } | null {
  const value = rawHref?.trim();
  if (!value) return null;

  let normalized = value;
  if (normalized.startsWith('file://')) {
    try {
      normalized = new URL(normalized).pathname;
    } catch {
      normalized = normalized.replace(/^file:\/\//, '');
    }
  }

  if (/^[a-z]+:\/\//i.test(normalized) && !normalized.startsWith('/')) {
    return null;
  }

  if (!normalized.startsWith('/')) return null;

  normalized = normalized.split('?')[0] || normalized;
  normalized = normalized.split('#')[0] || normalized;
  normalized = normalized.replace(/:\d+(?::\d+)?$/, '');

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // keep original path if decode fails
  }

  const fileName = normalized.split('/').pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return { filePath: normalized, ext };
}

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  const previewType = PREVIEWABLE_EXTS[ext];
  if (!previewType) return null;
  const p = window.platform;
  if (!p) return null;
  if (previewType === 'docx') return p.readDocxHtml?.(filePath) ?? null;
  if (previewType === 'xlsx') return p.readXlsxHtml?.(filePath) ?? null;
  if (BINARY_PREVIEW_TYPES.has(previewType)) return p.readFileBase64?.(filePath) ?? null;
  return p.readFile?.(filePath) ?? null;
}

/**
 * 打开文件预览：读取文件内容 → 创建 Artifact → 打开预览面板
 */
export async function openFilePreview(filePath: string, label: string, ext: string): Promise<void> {
  const fileName = label || filePath.split('/').pop() || filePath;
  const previewOnly = ext === 'md' || ext === 'markdown';
  const placeholderArtifact: Artifact = {
    id: `file-${filePath}`,
    type: 'file-info',
    title: fileName,
    content: '',
    filePath,
    ext,
    previewOnly,
  };

  if (ext === 'skill') {
    // .skill 文件可能是纯文本也可能是 zip，先尝试读取内容在预览面板展示
    const name = fileName.replace(/\.skill$/, '');
    const content = await window.platform?.readFile?.(filePath);
    if (content != null) {
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
      const artifact: Artifact = {
        id: `skill-${name}`,
        type: 'markdown',
        title: name,
        content: body,
      };
      upsertArtifact(artifact);
      openPreview(artifact);
      return;
    }
    // 读取失败（可能是 zip 格式），尝试 skill viewer
    window.platform?.openSkillViewer?.({ skillPath: filePath });
    return;
  }

  // 先立即打开一个占位预览，避免读取慢时用户体感为“点了没反应”。
  upsertArtifact(placeholderArtifact);
  openPreview(placeholderArtifact);

  const canPreview = ext in PREVIEWABLE_EXTS;
  if (canPreview) {
    try {
      const content = await readFileForPreview(filePath, ext);
      if (content != null) {
        const previewType = PREVIEWABLE_EXTS[ext];
        const artifact: Artifact = {
          id: `file-${filePath}`,
          type: previewType,
          title: fileName,
          content,
          filePath,
          ext,
          language: previewType === 'code' ? ext : undefined,
          previewOnly,
        };
        upsertArtifact(artifact);
        openPreview(artifact);
        return;
      }
    } catch (err) {
      console.error('[file-preview] read failed:', err);
    }
  }

  // 无法预览的文件类型
  const artifact: Artifact = {
    ...placeholderArtifact,
  };
  upsertArtifact(artifact);
  openPreview(artifact);
}

/**
 * 打开 Skill 预览：读取 skill 文件 → 创建 markdown Artifact → 打开预览面板
 */
export async function openSkillPreview(skillName: string, skillFilePath: string): Promise<void> {
  const content = await window.platform?.readFile?.(skillFilePath);
  if (content != null) {
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const artifact: Artifact = {
      id: `skill-${skillName}`,
      type: 'markdown',
      title: skillName,
      content: body,
    };
    upsertArtifact(artifact);
    openPreview(artifact);
  }
}

/** 插入或更新 artifacts store */
function upsertArtifact(artifact: Artifact): void {
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
}
