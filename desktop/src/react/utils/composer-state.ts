import type { ChatMessage, UserAttachment } from '../stores/chat-types';
import type { AttachedFile, DocContextFile, QuotedSelection, WorkingSetFile, ComposerDraft } from '../stores/input-slice';

export const PENDING_COMPOSER_KEY = '__pending__';

export function getComposerSessionKey(sessionPath: string | null, pendingNewSession = false): string {
  if (pendingNewSession || !sessionPath) return PENDING_COMPOSER_KEY;
  return sessionPath;
}

export function attachmentToDraftFile(file: UserAttachment): AttachedFile {
  return {
    path: file.path,
    name: file.name,
    isDirectory: file.isDir,
    base64Data: file.base64Data,
    mimeType: file.mimeType,
  };
}

export function buildQuotedSelectionSummary(selection: QuotedSelection): string {
  const range = selection.lineStart != null && selection.lineEnd != null
    ? `L${selection.lineStart}-${selection.lineEnd}`
    : null;
  const path = selection.sourceFilePath || selection.sourceTitle;
  const meta = [path, range, `${selection.charCount} chars`].filter(Boolean).join(' · ');
  return meta;
}

export function formatQuotedSelectionPrompt(selection: QuotedSelection): string {
  const path = selection.sourceFilePath || selection.sourceTitle;
  const range = selection.lineStart != null && selection.lineEnd != null
    ? `行 ${selection.lineStart}-${selection.lineEnd}`
    : null;
  const meta = [path, range, `${selection.charCount} 字符`].filter(Boolean).join(' · ');
  return `[引用片段] ${meta}\n${selection.text}`;
}

export function cloneQuotedSelection(selection: QuotedSelection | null | undefined): QuotedSelection | null {
  if (!selection) return null;
  return { ...selection };
}

export function buildRetryDraftFromMessage(message: ChatMessage): ComposerDraft {
  const retryDraft = message.retryDraft;
  if (retryDraft) {
    return {
      text: retryDraft.text || '',
      attachedFiles: (retryDraft.attachedFiles || []).map((file) => ({ ...file })),
      quotedSelection: cloneQuotedSelection(retryDraft.quotedSelection),
      docContextFile: retryDraft.docContextFile ? { ...retryDraft.docContextFile } : null,
      workingSet: (retryDraft.workingSet || []).map((file) => ({ ...file })),
    };
  }

  const fallbackQuoted = message.quotedSelection
    ? cloneQuotedSelection(message.quotedSelection)
    : message.quotedText
      ? {
          text: message.quotedText,
          sourceTitle: message.text?.slice(0, 24) || 'Quoted selection',
          charCount: message.quotedText.length,
        }
      : null;

  const attachedFiles = (message.attachments || []).map(attachmentToDraftFile);
  const workingSet: WorkingSetFile[] = attachedFiles.map((file) => ({
    path: file.path,
    name: file.name,
    source: file.isDirectory ? 'desk' : 'recent',
    isDirectory: !!file.isDirectory,
  }));

  return {
    text: message.text || '',
    attachedFiles,
    quotedSelection: fallbackQuoted,
    docContextFile: null,
    workingSet,
  };
}

export function mergeWorkingSetFiles(...groups: Array<WorkingSetFile[] | null | undefined>): WorkingSetFile[] {
  const seen = new Set<string>();
  const merged: WorkingSetFile[] = [];
  for (const group of groups) {
    for (const file of group || []) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      merged.push(file);
    }
  }
  return merged;
}

export function fileToWorkingSet(file: { path: string; name: string }, source: WorkingSetFile['source'], isDirectory = false): WorkingSetFile {
  return { path: file.path, name: file.name, source, isDirectory };
}

export function cloneDocContextFile(file: DocContextFile | null | undefined): DocContextFile | null {
  return file ? { ...file } : null;
}
