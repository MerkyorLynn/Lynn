type RenderMarkdown = (src: string) => string;

let renderMarkdownPromise: Promise<RenderMarkdown> | null = null;
let renderMarkdownCached: RenderMarkdown | null = null;

export function getCachedRenderMarkdown(): RenderMarkdown | null {
  return renderMarkdownCached;
}

export function loadRenderMarkdown(): Promise<RenderMarkdown> {
  if (!renderMarkdownPromise) {
    renderMarkdownPromise = import('./markdown').then((module) => {
      renderMarkdownCached = module.renderMarkdown;
      return module.renderMarkdown;
    });
  }
  return renderMarkdownPromise;
}
