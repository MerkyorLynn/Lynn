import { sanitizeQuotedSelection } from '../utils/composer-state';

export interface AttachedFile {
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceFilePath?: string;
  lineStart?: number;
  lineEnd?: number;
  charCount: number;
}

export interface WorkingSetFile {
  path: string;
  name: string;
  source: 'current' | 'recent' | 'desk';
  isDirectory?: boolean;
}

export interface ComposerDraft {
  text: string;
  attachedFiles: AttachedFile[];
  quotedSelection: QuotedSelection | null;
  docContextFile: DocContextFile | null;
  workingSet: WorkingSetFile[];
}

export interface InputSlice {
  composerText: string;
  attachedFiles: AttachedFile[];
  deskContextAttached: boolean;
  docContextAttached: boolean;
  docContextFile: DocContextFile | null;
  inputFocusTrigger: number;
  quotedSelection: QuotedSelection | null;
  composerDrafts: Record<string, ComposerDraft>;
  lastSubmittedDrafts: Record<string, ComposerDraft>;
  workingSetRecentFiles: WorkingSetFile[];
  setComposerText: (text: string) => void;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean, file?: DocContextFile | null) => void;
  toggleDocContext: (file?: DocContextFile | null) => void;
  setDocContextFile: (file: DocContextFile | null) => void;
  requestInputFocus: () => void;
  setQuotedSelection: (sel: QuotedSelection) => void;
  updateQuotedSelection: (patch: Partial<QuotedSelection>) => void;
  clearQuotedSelection: () => void;
  saveComposerDraft: (sessionKey: string) => void;
  restoreComposerDraft: (sessionKey: string) => void;
  clearComposerState: () => void;
  applyComposerDraft: (draft: Partial<ComposerDraft> & { text?: string }) => void;
  setLastSubmittedDraft: (sessionKey: string, draft: ComposerDraft) => void;
  restoreLastSubmittedDraft: (sessionKey: string) => void;
  clearLastSubmittedDraft: (sessionKey: string) => void;
  rememberWorkingSetFile: (file: WorkingSetFile) => void;
}

function emptyDraft(): ComposerDraft {
  return {
    text: '',
    attachedFiles: [],
    quotedSelection: null,
    docContextFile: null,
    workingSet: [],
  };
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void,
  get?: () => InputSlice,
): InputSlice => ({
  composerText: '',
  attachedFiles: [],
  deskContextAttached: false,
  docContextAttached: false,
  docContextFile: null,
  inputFocusTrigger: 0,
  quotedSelection: null,
  composerDrafts: {},
  lastSubmittedDrafts: {},
  workingSetRecentFiles: [],
  setComposerText: (text) => set({ composerText: text }),
  addAttachedFile: (file) =>
    set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
  removeAttachedFile: (index) =>
    set((s) => ({ attachedFiles: s.attachedFiles.filter((_, i) => i !== index) })),
  setAttachedFiles: (files) => set({ attachedFiles: files }),
  clearAttachedFiles: () => set({ attachedFiles: [] }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: () => set({ docContextAttached: false, docContextFile: null }),
  toggleDocContext: () => set({ docContextAttached: false, docContextFile: null }),
  setDocContextFile: () => set({ docContextFile: null, docContextAttached: false }),
  requestInputFocus: () =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1 })),
  setQuotedSelection: (sel) => set({ quotedSelection: sanitizeQuotedSelection(sel) }),
  updateQuotedSelection: (patch) => set((s) => ({
    quotedSelection: s.quotedSelection ? sanitizeQuotedSelection({ ...s.quotedSelection, ...patch }) : s.quotedSelection,
  })),
  clearQuotedSelection: () => set({ quotedSelection: null }),
  saveComposerDraft: (sessionKey) => set((s) => ({
    composerDrafts: {
      ...s.composerDrafts,
      [sessionKey]: {
        text: s.composerText,
        attachedFiles: s.attachedFiles.map((file) => ({ ...file })),
        quotedSelection: sanitizeQuotedSelection(s.quotedSelection),
        docContextFile: null,
        workingSet: s.workingSetRecentFiles.map((file) => ({ ...file })),
      },
    },
  })),
  restoreComposerDraft: (sessionKey) => set((s) => {
    const draft = s.composerDrafts[sessionKey] || emptyDraft();
    return {
      composerText: draft.text,
      attachedFiles: draft.attachedFiles.map((file) => ({ ...file })),
      quotedSelection: sanitizeQuotedSelection(draft.quotedSelection),
      docContextFile: null,
      docContextAttached: false,
      workingSetRecentFiles: draft.workingSet.map((file) => ({ ...file })),
    };
  }),
  clearComposerState: () => set({
    composerText: '',
    attachedFiles: [],
    quotedSelection: null,
    docContextFile: null,
    docContextAttached: false,
  }),
  applyComposerDraft: (draft) => set((s) => ({
    composerText: draft.text ?? s.composerText,
    attachedFiles: draft.attachedFiles ? draft.attachedFiles.map((file) => ({ ...file })) : s.attachedFiles,
    quotedSelection: draft.quotedSelection === undefined
      ? sanitizeQuotedSelection(s.quotedSelection)
      : sanitizeQuotedSelection(draft.quotedSelection),
    docContextFile: null,
    docContextAttached: false,
    workingSetRecentFiles: draft.workingSet ? draft.workingSet.map((file) => ({ ...file })) : s.workingSetRecentFiles,
  })),
  setLastSubmittedDraft: (sessionKey, draft) => set((s) => ({
    lastSubmittedDrafts: {
      ...s.lastSubmittedDrafts,
      [sessionKey]: {
        text: draft.text,
        attachedFiles: draft.attachedFiles.map((file) => ({ ...file })),
        quotedSelection: sanitizeQuotedSelection(draft.quotedSelection),
        docContextFile: null,
        workingSet: draft.workingSet.map((file) => ({ ...file })),
      },
    },
  })),
  restoreLastSubmittedDraft: (sessionKey) => set((s) => {
    const draft = s.lastSubmittedDrafts[sessionKey];
    if (!draft) return {};
    return {
      composerText: draft.text,
      attachedFiles: draft.attachedFiles.map((file) => ({ ...file })),
      quotedSelection: sanitizeQuotedSelection(draft.quotedSelection),
      docContextFile: null,
      docContextAttached: false,
      workingSetRecentFiles: draft.workingSet.map((file) => ({ ...file })),
    };
  }),
  clearLastSubmittedDraft: (sessionKey) => set((s) => {
    const { [sessionKey]: _, ...rest } = s.lastSubmittedDrafts;
    return { lastSubmittedDrafts: rest };
  }),
  rememberWorkingSetFile: (file) => set((s) => {
    const next = [file, ...s.workingSetRecentFiles.filter((entry) => entry.path !== file.path)];
    return { workingSetRecentFiles: next.slice(0, 12) };
  }),
});
