/**
 * AssistantMessage pure helpers — model-ref parsing, provider-route formatting,
 * tool-state summary, block text extraction, reviewer config, follow-up gating.
 * Extracted from AssistantMessage.tsx (GUI monolith decomposition). No React /
 * hooks / JSX — pure over shared chat types, so unit-testable in isolation.
 */

import type { ChatMessage, ContentBlock } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  if (lower === 'lynn-brain-router') return { provider: 'brain', id: value };
  if (lower === 'qwen35-4b-q4km') {
    return { provider: 'local-qwen35-4b-q4km', id: value };
  }
  if (lower === 'qwen35-9b-q4km-imatrix') {
    return { provider: 'local-qwen35-9b-q4km-imatrix', id: value };
  }
  return { id: value };
}

export function formatProviderRouteName(id?: string | null): string {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('mimo')) return 'MiMo';
  if (lower.includes('spark') || lower.includes('apex')) return 'Spark';
  if (lower.includes('deepseek')) return 'DeepSeek';
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
  const fallback = (route.fallbackFrom || []).map((hop) => formatProviderRouteName(hop.id)).filter(Boolean);
  if (fallback.length === 0) return null;
  const chain = [...fallback, formatProviderRouteName(route.activeProvider)].filter(Boolean);
  return Array.from(new Set(chain)).join(' -> ');
}

export function providerRouteTitle(route?: ChatMessage['providerRoute'] | null): string | undefined {
  if (!route?.activeProvider) return undefined;
  const active = formatProviderRouteName(route.activeProvider) || route.activeProvider;
  const fallback = route.fallbackFrom || [];
  if (fallback.length === 0) return `当前回答模型：${active}`;
  const details = fallback
    .map((hop) => {
      const name = formatProviderRouteName(hop.id) || hop.id;
      return hop.reason ? `${name}: ${hop.reason}` : name;
    })
    .join('；');
  return `备用链路已切换到 ${active}。跳过：${details}`;
}

export function summarizeToolState(blocks: ContentBlock[]): { running: number; total: number; activeLabel: string } {
  let running = 0;
  let total = 0;
  let activeLabel = '';
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    total += block.tools.length;
    for (const tool of block.tools) {
      if (!tool.done) {
        running++;
        if (!activeLabel) activeLabel = TOOL_LABELS[tool.name] || tool.name;
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
