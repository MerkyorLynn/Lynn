import { memo, useEffect, useState } from 'react';
import { loadRenderMarkdown } from '../../utils/markdown-loader';
import { MarkdownContent } from './MarkdownContent';

interface Props {
  markdown: string;
  className?: string;
  stateKey?: string;
}

export const AsyncMarkdownContent = memo(function AsyncMarkdownContent({ markdown, className, stateKey }: Props) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    setHtml('');
    loadRenderMarkdown()
      .then((renderMarkdown) => {
        if (!cancelled) setHtml(renderMarkdown(markdown));
      })
      .catch((err) => {
        console.warn('[markdown] render failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  return <MarkdownContent html={html} className={className} stateKey={stateKey} />;
});
