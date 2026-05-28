import type { ChatMessage } from './types.js';

export type ToolResultCompactionConfig = {
  capChars: number;
  keepLatest: number;
};

const COMPACTED_MARKER = '[brain-v2:tool-result-compacted]';
const DEFAULT_CAP_CHARS = 12_000;

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function readToolResultCompactionConfigFromEnv(): ToolResultCompactionConfig {
  return {
    capChars: positiveInt(process.env.BRAIN_V2_TOOL_RESULT_CAP, DEFAULT_CAP_CHARS),
    keepLatest: positiveInt(process.env.BRAIN_V2_TOOL_RESULT_KEEP_LATEST, 1),
  };
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function compactedContent(original: string, capChars: number): string {
  const head = original.slice(0, capChars);
  return [
    COMPACTED_MARKER,
    `[tool result compacted: original_chars=${original.length}, kept_chars=${head.length}]`,
    head,
    '',
    'Older tool output was truncated to keep the next provider turn responsive. Re-call the tool with refined arguments if exact omitted details are required.',
  ].join('\n');
}

export function compactToolResults(
  messages: ChatMessage[],
  config: ToolResultCompactionConfig = readToolResultCompactionConfigFromEnv(),
): ChatMessage[] {
  if (!Array.isArray(messages) || config.capChars <= 0) return messages;

  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message?.role === 'tool')
    .map(({ index }) => index);
  const latestToKeep = new Set(toolIndexes.slice(-config.keepLatest));
  let changed = false;

  const next = messages.map((message, index) => {
    if (message?.role !== 'tool') return message;
    if (latestToKeep.has(index)) return message;
    const text = contentToString(message.content);
    if (!text || text.includes(COMPACTED_MARKER) || text.length <= config.capChars) return message;
    changed = true;
    return {
      ...message,
      content: compactedContent(text, config.capChars),
    };
  });

  return changed ? next : messages;
}

export const __testing__ = {
  COMPACTED_MARKER,
  contentToString,
};
