/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 用 dangerouslySetInnerHTML 设置内容，
 * useEffect 注入代码块复制按钮 + Mermaid 图表渲染。
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import { postprocessMarkdown } from '../../utils/format';
import { openFilePreview, resolvePreviewTarget } from '../../utils/file-preview';

interface Props {
  html: string;
  className?: string;
  stateKey?: string;
}

// 懒加载 mermaid（首次使用时才 import，约 200KB）
let _mermaidReady: Promise<typeof import('mermaid') | null> | null = null;
function getMermaid() {
  if (!_mermaidReady) {
    _mermaidReady = import('mermaid').then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: document.documentElement.dataset.theme?.includes('dark') ? 'dark' : 'default',
        securityLevel: 'strict',
      });
      return mod;
    }).catch(() => null);
  }
  return _mermaidReady;
}

async function renderMermaidBlocks(container: HTMLElement) {
  // 找到所有 language-mermaid 代码块
  const codeBlocks = container.querySelectorAll('pre > code.language-mermaid, pre > code.hljs.language-mermaid');
  if (codeBlocks.length === 0) return;

  const mermaidMod = await getMermaid();
  if (!mermaidMod) return;
  const mermaid = mermaidMod.default;

  for (const codeEl of Array.from(codeBlocks)) {
    const pre = codeEl.parentElement;
    if (!pre || pre.dataset.mermaidRendered) continue;
    pre.dataset.mermaidRendered = '1';

    const source = codeEl.textContent || '';
    if (!source.trim()) continue;

    try {
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const { svg } = await mermaid.render(id, source);
      // eslint-disable-next-line no-restricted-syntax -- Mermaid returns SVG that needs a controlled replacement mount.
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-rendered';
      wrapper.style.cssText = 'overflow-x: auto; margin: 8px 0; text-align: center;';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch {
      // 渲染失败保留原始代码块
    }
  }
}

export const MarkdownContent = memo(function MarkdownContent({ html, className, stateKey }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a');
    if (!anchor) return;

    const previewTarget = resolvePreviewTarget(anchor.getAttribute('href'));
    if (!previewTarget) return;

    event.preventDefault();
    event.stopPropagation();
    void openFilePreview(previewTarget.filePath, anchor.textContent?.trim() || '', previewTarget.ext);
  }, []);

  useEffect(() => {
    if (ref.current) {
      postprocessMarkdown(ref.current, { stateKey });
      void renderMermaidBlocks(ref.current);
    }
  }, [html, stateKey]);

  return (
    <div
      ref={ref}
      className={className || 'md-content'}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
