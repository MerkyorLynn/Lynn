/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 用 dangerouslySetInnerHTML 设置内容，
 * useEffect 注入代码块复制按钮。
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import { postprocessMarkdown } from '../../utils/format';
import { openFilePreview, resolvePreviewTarget } from '../../utils/file-preview';

interface Props {
  html: string;
  className?: string;
  stateKey?: string;
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
