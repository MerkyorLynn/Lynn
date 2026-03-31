/**
 * Markdown 渲染器
 *
 * 通过 npm import 使用 markdown-it，不依赖全局 window.markdownit。
 */

import markdownit from 'markdown-it';
import mk from '@traptitech/markdown-it-katex';
import 'katex/dist/katex.min.css';
import { sanitizeHtml } from './sanitize';

type MarkdownIt = ReturnType<typeof markdownit>;

let _md: MarkdownIt | null = null;

/** 获取默认 md 实例（html: false, katex 插件） */
export function getMd(): MarkdownIt {
  if (_md) return _md;
  _md = markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  _md.use(mk);
  return _md;
}

const _cache = new Map<string, MarkdownIt>();

/** 获取自定义选项的 md 实例（缓存复用，强制 html: false） */
export function getMdWithOpts(opts: Parameters<typeof markdownit>[0]): MarkdownIt {
  // 安全：强制禁用 HTML 解析，防止 XSS
  const safeOpts = typeof opts === 'object' ? { ...opts, html: false } : opts;
  const key = JSON.stringify(safeOpts);
  let inst = _cache.get(key);
  if (!inst) {
    inst = markdownit(safeOpts);
    _cache.set(key, inst);
  }
  return inst;
}

/**
 * 自动补全未闭合的代码围栏，让流式输出时代码块也能被 markdown-it 正确高亮。
 * 检测 ``` 开头但未闭合的围栏，在末尾追加 ``` 使 markdown 引擎正常解析。
 */
function closeOpenCodeFences(src: string): string {
  const lines = src.split('\n');
  let openFence: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (openFence === null) {
      // 检测开启围栏：```lang 或 ~~~lang
      const match = trimmed.match(/^(`{3,}|~{3,})/);
      if (match) {
        openFence = match[1][0]; // 记录围栏字符类型
      }
    } else {
      // 检测闭合围栏
      const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === openFence) {
        openFence = null;
      }
    }
  }

  if (openFence !== null) {
    // 围栏未闭合，追加闭合标记
    const closeMark = openFence === '~' ? '~~~' : '```';
    return src + '\n' + closeMark;
  }
  return src;
}

export function renderMarkdown(src: string): string {
  return sanitizeHtml(getMd().render(closeOpenCodeFences(src)));
}
