/**
 * MainContent.tsx — 主内容区域：拖拽处理 + 布局编排
 *
 * 从 App.tsx 提取。包含：
 * - handleDrop() 拖拽附件处理
 * - MainContent（原 MainContentDrag）组件
 * - DropText 子组件
 */

import { useState, useRef, useCallback } from 'react';
import { useStore } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import { toSlash, baseName } from './utils/format';
import { sendPrompt } from './stores/prompt-actions';

declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- deskFiles item typing */

// 可直接分析的文件扩展名
const ANALYZABLE_EXTS = new Set([
  'xlsx', 'xls', 'csv', 'tsv', 'pdf', 'doc', 'docx',
  'json', 'xml', 'yaml', 'yml', 'txt', 'md', 'log',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
]);

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// ── 拖拽附件 drop handler（从 bridge.ts appInput shim 迁移） ──

async function handleDrop(e: React.DragEvent): Promise<void> {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const store = useStore.getState();
  if (store.attachedFiles.length >= 9) return;

  let srcPaths: string[] = [];
  const nameMap: Record<string, string> = {};
  for (const file of Array.from(files)) {
    const filePath = await window.platform?.getFilePath?.(file);
    if (filePath) {
      srcPaths.push(filePath);
      nameMap[filePath] = file.name;
    }
  }
  if (srcPaths.length === 0) return;

  // Desk 文件直接附加（保留原始路径，不走 upload）
  const s = useStore.getState();
  const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
  if (deskBase) {
    const prefix = deskBase + '/';
    const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
    const isDeskPath = (p: string) => toSlash(p).startsWith(prefix);
    const deskPaths = srcPaths.filter(isDeskPath);
    srcPaths = srcPaths.filter((p) => !isDeskPath(p));
    for (const p of deskPaths) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      const name = baseName(p);
      const knownFile = deskFileMap.get(name);
      useStore.getState().addAttachedFile({
        path: p,
        name,
        isDirectory: knownFile?.isDir ?? false,
      });
    }
  }
  if (srcPaths.length === 0) {
    // 所有文件都是 desk 路径，检查是否应自动分析
    tryAutoAnalyze();
    return;
  }

  try {
    const res = await hanaFetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: srcPaths }),
    });
    const data = await res.json();
    for (const item of data.uploads || []) {
      if (item.dest) {
        useStore.getState().addAttachedFile({
          path: item.dest,
          name: item.name,
          isDirectory: item.isDirectory || false,
        });
      }
    }
  } catch (err) {
    console.error('[upload]', err);
    for (const p of srcPaths) {
      useStore.getState().addAttachedFile({
        path: p,
        name: nameMap[p] || p.split('/').pop() || p,
      });
    }
  }

  tryAutoAnalyze();
}

/**
 * 拖拽即分析：如果只拖入了一个可分析的文件且当前无对话，自动发送分析请求
 */
function tryAutoAnalyze() {
  const store = useStore.getState();
  const attached = store.attachedFiles;
  // 只有拖入单个文件 + 当前没有进行中对话 + 输入框为空时才自动分析
  if (attached.length !== 1) return;
  if (store.composerText.trim()) return;
  if (!store.welcomeVisible && store.currentSessionPath) return;

  const file = attached[0];
  const ext = getExt(file.name);
  if (!ANALYZABLE_EXTS.has(ext) && !file.isDirectory) return;

  const isZh = String((window as any).i18n?.locale || '').startsWith('zh');
  const prompt = isZh
    ? `请分析这个文件：${file.name}`
    : `Please analyze this file: ${file.name}`;

  // 延迟一帧确保附件已渲染
  requestAnimationFrame(() => {
    void sendPrompt({ text: prompt, displayText: prompt });
  });
}

// ── DropText ──

function DropText() {
  const agentName = useStore(s => s.agentName);
  const mainText = t('drop.mainHint') || 'Drop to analyze';
  const subText = (t('drop.subHint') || '{name} supports Excel, PDF, CSV, images and more').replace('{name}', agentName);
  return (
    <span className="drop-text">
      <span className="drop-text-main">{mainText}</span>
      <span className="drop-text-sub">{subText}</span>
    </span>
  );
}

// ── MainContent（拖拽区域 + children） ──

export function MainContent({ children }: { children: React.ReactNode }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragActive(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    handleDrop(e);
  }, []);

  return (
    <div
      className="main-content"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className={`drop-overlay${dragActive ? ' visible' : ''}`}>
        <div className="drop-overlay-inner">
          <span className="drop-icon">📂</span>
          <DropText />
        </div>
      </div>
      {children}
    </div>
  );
}
