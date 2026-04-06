import type { ChatListItem, ContentBlock } from '../stores/chat-types';

export interface SessionDiffEntry {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  rollbackId?: string;
}

export interface SessionDiffSummary {
  files: SessionDiffEntry[];
  linesAdded: number;
  linesRemoved: number;
}

export function collectSessionDiffs(items: ChatListItem[] | undefined | null): SessionDiffSummary {
  const byFile = new Map<string, SessionDiffEntry>();
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const item of items || []) {
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    for (const block of (item.data.blocks || []) as ContentBlock[]) {
      if (block.type !== 'file_diff') continue;
      totalAdded += Number(block.linesAdded || 0);
      totalRemoved += Number(block.linesRemoved || 0);
      byFile.set(block.filePath, {
        filePath: block.filePath,
        diff: block.diff,
        linesAdded: block.linesAdded,
        linesRemoved: block.linesRemoved,
        rollbackId: block.rollbackId,
      });
    }
  }

  return {
    files: [...byFile.values()],
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
  };
}
