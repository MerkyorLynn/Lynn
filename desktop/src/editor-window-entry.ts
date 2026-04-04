/**
 * editor-window-entry.ts — 独立编辑器窗口的 CM6 入口
 *
 * 与主面板共用同一套 CodeMirror 配置和文件监听桥接。
 */

import { EditorView, EditorState, createBaseEditorExtensions, SAVE_DELAY } from './editor/codemirror-presets';
import { ensureFileChangeBridge, subscribeFileChanges, syncExternalFileChange } from './editor/file-sync';

const hana = (window as any).hana;
const titleEl = document.getElementById('editorTitle')!;
const bodyEl = document.getElementById('editorBody')!;
const btnDock = document.getElementById('btnDock')!;
const btnClose = document.getElementById('btnClose')!;

let filePath: string | null = null;
let watchedFilePath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let selfSave = false;
let editorView: EditorView | null = null;
let unsubscribeFileChanges: (() => void) | null = null;

function mountEditor(content: string, isMarkdown: boolean) {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  bodyEl.innerHTML = '';

  const extensions = createBaseEditorExtensions({
    isMarkdown,
    onDocChange: (text) => {
      selfSave = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveContent(text), SAVE_DELAY);
    },
  });

  const state = EditorState.create({ doc: content, extensions });
  editorView = new EditorView({ state, parent: bodyEl });
}

async function saveContent(text: string) {
  if (!filePath) return;
  await hana?.writeFile(filePath, text);
  setTimeout(() => { selfSave = false; }, 300);
}

async function loadContent(data: { filePath: string; title: string; type: string }) {
  filePath = data.filePath;
  titleEl.textContent = data.title || filePath.split('/').pop() || 'Editor';

  const isMarkdown = data.type === 'markdown';
  if (isMarkdown) bodyEl.classList.add('mode-markdown');
  else bodyEl.classList.remove('mode-markdown');

  const content = await hana?.readFile(filePath);
  if (content == null) return;

  mountEditor(content, isMarkdown);

  ensureFileChangeBridge((callback) => hana?.onFileChanged?.(callback));
  if (watchedFilePath && watchedFilePath !== filePath) {
    hana?.unwatchFile?.(watchedFilePath);
  }
  watchedFilePath = filePath;
  hana?.watchFile(filePath);
  unsubscribeFileChanges?.();
  unsubscribeFileChanges = subscribeFileChanges((changedPath) => {
    void syncExternalFileChange({
      changedPath,
      filePath,
      readFile: (path) => hana?.readFile(path),
      getView: () => editorView,
      shouldIgnore: () => selfSave,
    });
  });
}

hana?.onEditorLoad((data: any) => loadContent(data));
btnDock.addEventListener('click', () => hana?.editorDock?.());
btnClose.addEventListener('click', () => hana?.editorClose?.());

window.addEventListener('beforeunload', () => {
  unsubscribeFileChanges?.();
  if (watchedFilePath) {
    hana?.unwatchFile?.(watchedFilePath);
  }
});

const saved = localStorage.getItem('hana-theme') || 'warm-paper';
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const theme = saved === 'auto' ? (isDark ? 'midnight' : 'warm-paper') : saved;
document.getElementById('themeSheet')!.setAttribute('href', `themes/${theme}.css`);

if (localStorage.getItem('hana-font-serif') === '0') {
  document.body.classList.add('font-sans');
}
