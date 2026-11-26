/**
 * AssistantMessage pure helpers — model-ref parsing, provider-route formatting,
 * tool-state summary, block text extraction, reviewer config, follow-up gating.
 * Extracted from AssistantMessage.tsx (GUI monolith decomposition). No React /
 * hooks / JSX — pure over shared chat types, so unit-testable in isolation.
 */

import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { resolveUiI18nText } from '../../utils/ui-i18n';
import { isChineseLocale } from '../../utils/locale';

export interface ReviewConfigAgent {
  id: string;
  name: string;
  yuan: string;
  hasAvatar?: boolean;
}

export interface ReviewConfigResponse {
  defaultReviewer: 'hanako' | 'butter';
  hanakoReviewerId?: string | null;
  butterReviewerId?: string | null;
  resolvedReviewer?: ReviewConfigAgent | null;
}

export const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  web_fetch: 'Reading a page',
  weather: 'Checking the weather',
  stock_market: 'Checking markets',
  stock_research: 'Researching stocks',
  create_pptx: 'Building slides',
  create_report: 'Writing a report',
  create_artifact: 'Creating a preview',
  browser: 'Driving the browser',
  read: 'Reading a file',
  write: 'Writing a file',
  edit: 'Editing a file',
  bash: 'Running a command',
  grep: 'Searching contents',
  find: 'Finding files',
  ls: 'Listing a directory',
  notify: 'Sending a notification',
  cron: 'Scheduling a task',
  todo: 'Managing todos',
};

/** Chinese labels for the same tools; used when the UI locale is Chinese. */
export const TOOL_LABELS_ZH: Record<string, string> = {
  web_search: '搜索中',
  web_fetch: '读取网页',
  weather: '查询天气',
  stock_market: '查询行情',
  stock_research: '股票研究',
  create_pptx: '生成 PPT',
  create_report: '生成报告',
  create_artifact: '创建预览',
  browser: '浏览器操作',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  grep: '搜索内容',
  find: '查找文件',
  ls: '列出目录',
  notify: '发送通知',
  cron: '定时任务',
  todo: '待办管理',
};

/** Resolve a tool's running label for the current UI locale. */
export function toolLabel(name: string, locale?: string | null): string {
  const table = isChineseLocale(locale) ? TOOL_LABELS_ZH : TOOL_LABELS;
  return table[name] || name;
}

export function parseMessageModelRef(raw?: string | null): { id: string; provider?: string } | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const spaced = value.split(/\s+\/\s+/);
  if (spaced.length >= 2 && spaced[0] && spaced.slice(1).join('/')) {
    return { provider: spaced[0], id: spaced.slice(1).join('/') };
  }
  const slashIndex = value.indexOf('/');
  if (slashIndex > 0 && slashIndex < value.length - 1) {
    return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
  }
  const lower = value.toLowerCase();
  if (lower === 'step-5-preview' || lower === 'lynn-brain-router') return { provider: 'brain', id: value };
  if (lower === 'qwen35-4b-q4km') {
    return { provider: 'local-qwen35-4b-q4km', id: value };
  }
  if (lower === 'qwen35-9b-q4km-imatrix') {
    return { provider: 'local-qwen35-9b-q4km-imatrix', id: value };
  }
  if (lower === 'qwen36-27b-dsv4pro-coding-q4-mtp'
    || lower === 'qwen36-27b-dsv4pro-distill-q5km-imatrix') {
    return { provider: 'local-qwen35-9b-q4km-imatrix', id: value };
  }
  return { id: value };
}

export function formatProviderRouteName(id?: string | null): string {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('deepseek') || /\bds\b/.test(lower)) {
    if (lower.includes('v4') && lower.includes('flash')) return 'DS V4 Flash';
    if (lower.includes('v4') && lower.includes('pro')) return 'DS V4 Pro';
    if (lower.includes('reasoner')) return 'DeepSeek Reasoner';
    if (lower.includes('chat')) return 'DeepSeek Chat';
    return 'DeepSeek';
  }
  if (lower.includes('glm')) {
    if (lower.includes('5') && lower.includes('turbo')) return 'GLM 5.0 Turbo';
    if (lower.includes('5')) return 'GLM 5';
    if (lower.includes('4') && lower.includes('flash')) return 'GLM 4 Flash';
    return 'GLM';
  }
  if (lower.includes('step')) {
    return 'StepFun';
  }
  if (lower.includes('spark') || lower.includes('apex')) return 'Spark';
  if (lower.includes('openai') || lower.includes('gpt')) return 'OpenAI';
  if (lower.includes('local')) return 'Local';
  return raw
    .replace(/^qwen\d+[-_]/i, 'Qwen ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
}

export function providerRouteLabel(route?: ChatMessage['providerRoute'] | null): string | null {
  if (!route?.activeProvider) return null;
  return formatProviderRouteName(route.activeProvider) || route.activeProvider;
}

export function providerRouteTitle(route?: ChatMessage['providerRoute'] | null): string | undefined {
  if (!route?.activeProvider) return undefined;
  const active = formatProviderRouteName(route.activeProvider) || route.activeProvider;
  const fallback = route.fallbackFrom || [];
  if (fallback.length === 0) {
    return resolveUiI18nText('chat.providerRouteCurrent', { model: active });
  }
  const fullChain = Array.from(new Set([
    ...fallback.map((hop) => formatProviderRouteName(hop.id) || hop.id).filter(Boolean),
    active,
  ])).join(' -> ');
  const details = fallback
    .map((hop) => {
      const name = formatProviderRouteName(hop.id) || hop.id;
      return hop.reason ? `${name}: ${hop.reason}` : name;
    })
    .join('；');
  return resolveUiI18nText('chat.providerRouteFallback', {
    model: active,
    chain: fullChain,
    count: fallback.length,
    details,
  });
}

export function summarizeToolState(blocks: ContentBlock[], locale?: string | null): { running: number; total: number; activeLabel: string } {
  let running = 0;
  let total = 0;
  let activeLabel = '';
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    total += block.tools.length;
    for (const tool of block.tools) {
      if (!tool.done) {
        running++;
        if (!activeLabel) activeLabel = toolLabel(tool.name, locale);
      }
    }
  }
  return { running, total, activeLabel };
}

export function extractPlainTextFromBlocks(blocks: ContentBlock[]): string {
  const textBlocks = blocks.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
  if (textBlocks.length === 0) return '';
  const parser = new DOMParser();
  return textBlocks
    .map((block) => {
      if (typeof block.plainText === 'string') return block.plainText.trim();
      const doc = parser.parseFromString(block.html, 'text/html');
      return (doc.body.innerText || doc.body.textContent || '').trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function reviewerKindFromConfig(config: ReviewConfigResponse | null): 'hanako' | 'butter' {
  return config?.defaultReviewer === 'butter' ? 'butter' : 'hanako';
}

export function reviewerNameFromKind(kind: 'hanako' | 'butter'): string {
  return kind === 'butter' ? 'Butter' : 'Hanako';
}

export const TRANSLATION_TARGETS = ['英文', '中文', '日文', '韩文', '繁体中文'];
export const MAX_TRANSLATE_CHARS = 3_000;

/**
 * Display label for a translation target.
 *
 * The server route keys translation targets off the Chinese label
 * (server/chat/translation-intent.ts), so TRANSLATION_TARGETS must keep the
 * Chinese values for the API call. Only the visible menu text is localized.
 */
const TRANSLATION_TARGET_DISPLAY: Record<string, { zh: string; en: string }> = {
  英文: { zh: '英文', en: 'English' },
  中文: { zh: '中文', en: 'Chinese' },
  日文: { zh: '日文', en: 'Japanese' },
  韩文: { zh: '韩文', en: 'Korean' },
  繁体中文: { zh: '繁体中文', en: 'Traditional Chinese' },
};

export function translationTargetLabel(target: string, locale?: string | null): string {
  const entry = TRANSLATION_TARGET_DISPLAY[target];
  if (!entry) return target;
  return isChineseLocale(locale) ? entry.zh : entry.en;
}

export function findLatestReviewBlock(blocks: ContentBlock[]): Extract<ContentBlock, { type: 'review' }> | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'review') return block;
  }
  return null;
}

export function shouldShowFollowUpAction(reviewBlock: Extract<ContentBlock, { type: 'review' }> | null): boolean {
  if (!reviewBlock || reviewBlock.status !== 'done') return false;
  if (!reviewBlock.followUpPrompt) return false;
  return reviewBlock.workflowGate === 'follow_up' || reviewBlock.workflowGate === 'hold';
}

export function fallbackI18n(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(trimmed)) return fallback;
  return trimmed;
}
