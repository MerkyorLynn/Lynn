import type { EditorView } from '@codemirror/view';

const fileChangeEmitter = new EventTarget();
let fileChangeListenerSetup = false;

export function ensureFileChangeBridge(register: (callback: (filePath: string) => void) => void): void {
  if (fileChangeListenerSetup) return;
  fileChangeListenerSetup = true;
  register((filePath: string) => {
    fileChangeEmitter.dispatchEvent(new CustomEvent('change', { detail: filePath }));
  });
}

export function subscribeFileChanges(listener: (filePath: string) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<string>).detail);
  };
  fileChangeEmitter.addEventListener('change', handler);
  return () => fileChangeEmitter.removeEventListener('change', handler);
}

export async function syncExternalFileChange(opts: {
  changedPath: string;
  filePath: string | null | undefined;
  readFile: (filePath: string) => Promise<string | null | undefined>;
  getView: () => EditorView | null;
  shouldIgnore?: () => boolean;
}): Promise<void> {
  const { changedPath, filePath, readFile, getView, shouldIgnore } = opts;
  if (!filePath || changedPath !== filePath) return;
  if (shouldIgnore?.()) return;
  const nextContent = await readFile(filePath);
  if (nextContent == null) return;
  const view = getView();
  if (!view) return;
  const current = view.state.doc.toString();
  if (current === nextContent) return;
  view.dispatch({ changes: { from: 0, to: current.length, insert: nextContent } });
}
