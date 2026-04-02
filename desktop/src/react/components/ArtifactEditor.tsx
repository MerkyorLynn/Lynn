/**
 * ArtifactEditor — CodeMirror 6 编辑器组件
 *
 * 文件系统是 source of truth，直接对接文件读写。
 * 主面板和独立窗口共用同一套 CodeMirror 配置与文件监听桥接。
 */

import { forwardRef, useEffect, useRef, useCallback, useImperativeHandle } from 'react';
import {
  EditorView,
  EditorState,
  createBaseEditorExtensions,
  SAVE_DELAY,
} from '../../editor/codemirror-presets';
import { ensureFileChangeBridge, subscribeFileChanges, syncExternalFileChange } from '../../editor/file-sync';

export interface ArtifactEditorHandle {
  getView(): EditorView | null;
  focus(): void;
}

export interface ArtifactEditorProps {
  content: string;
  filePath?: string;
  mode: 'markdown' | 'code' | 'text';
  language?: string | null;
  onSelectionChange?: (view: EditorView) => void;
}

export const ArtifactEditor = forwardRef<ArtifactEditorHandle, ArtifactEditorProps>(
  function ArtifactEditor({ content, filePath, mode, onSelectionChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selfSaveRef = useRef(false);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const selectionCbRef = useRef(onSelectionChange);
    selectionCbRef.current = onSelectionChange;

    useImperativeHandle(ref, () => ({
      getView: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
    }));

    const saveToFile = useCallback((text: string) => {
      const fp = filePathRef.current;
      if (!fp) return;
      window.platform?.writeFile(fp, text).finally(() => {
        setTimeout(() => {
          if (!saveTimerRef.current) selfSaveRef.current = false;
        }, 300);
      });
    }, []);

    useEffect(() => {
      if (!containerRef.current) return;
      const isMarkdown = mode === 'markdown';
      const extensions = createBaseEditorExtensions({
        isMarkdown,
        onDocChange: (text) => {
          selfSaveRef.current = true;
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            saveToFile(text);
          }, SAVE_DELAY);
        },
        onSelectionChange: (view) => selectionCbRef.current?.(view),
      });

      const state = EditorState.create({ doc: content, extensions });
      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        view.destroy();
        viewRef.current = null;
      };
    }, [mode, saveToFile]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || selfSaveRef.current) return;
      const current = view.state.doc.toString();
      if (current !== content) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
      }
    }, [content]);

    useEffect(() => {
      if (!filePath) return;
      ensureFileChangeBridge((callback) => window.platform?.onFileChanged?.(callback));
      window.platform?.watchFile(filePath);
      const unsubscribe = subscribeFileChanges((changedPath) => {
        void syncExternalFileChange({
          changedPath,
          filePath,
          readFile: (path) => window.platform?.readFile(path),
          getView: () => viewRef.current,
          shouldIgnore: () => selfSaveRef.current,
        });
      });

      return () => {
        unsubscribe();
        window.platform?.unwatchFile(filePath);
      };
    }, [filePath]);

    return <div className={`artifact-editor mode-${mode}`} ref={containerRef} />;
  },
);
