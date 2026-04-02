/**
 * JianEditor — jian.md 编辑器面板（支持拖拽文件插入链接）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { saveJianContent } from '../../stores/desk-actions';
import s from './Desk.module.css';

export function JianEditor() {
  const deskJianContent = useStore(s => s.deskJianContent);
  const [localValue, setLocalValue] = useState(deskJianContent || '');
  const [dragOver, setDragOver] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevContentRef = useRef(deskJianContent);

  useEffect(() => {
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(deskJianContent || '');
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent]);

  // ── 文本输入 ──

  const updateAndSave = useCallback((newValue: string) => {
    setLocalValue(newValue);
    useStore.setState({ deskJianContent: newValue });
    prevContentRef.current = newValue;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveJianContent(newValue);
    }, 800);
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateAndSave(e.target.value);
  }, [updateAndSave]);

  // ── 拖拽处理 ──

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer.files;
    const text = e.dataTransfer.getData('text/plain');
    let insertText = '';

    if (files && files.length > 0) {
      // 文件拖入 → 生成 Markdown 链接
      const links: string[] = [];
      for (const f of Array.from(files)) {
        const p = await window.platform?.getFilePath?.(f);
        if (p) {
          const name = p.split('/').pop() || p;
          links.push(`[${name}](${p})`);
        }
      }
      insertText = links.join('\n');
    } else if (text) {
      // 纯文本拖入 → 直接插入
      insertText = text;
    }

    if (!insertText) return;

    // 在 textarea 光标位置插入
    const ta = textareaRef.current;
    const pos = ta?.selectionStart ?? localValue.length;
    const before = localValue.slice(0, pos);
    const after = localValue.slice(pos);
    const needNewline = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const newValue = before + needNewline + insertText + '\n' + after;

    updateAndSave(newValue);

    // 将光标移到插入内容之后
    requestAnimationFrame(() => {
      if (ta) {
        const newPos = (before + needNewline + insertText + '\n').length;
        ta.selectionStart = newPos;
        ta.selectionEnd = newPos;
        ta.focus();
      }
    });
  }, [localValue, updateAndSave]);

  return (
    <div
      className={`${s.editor}${dragOver ? ` ${s.editorDragOver}` : ''}`}
      data-desk-editor=""
      data-desk-editor-drop=""
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={s.editorHeader}>
        <span className={s.editorLabel}>{(window.t ?? ((p: string) => p))('desk.jianLabel')}</span>
      </div>
      <span className={s.editorStatus} ref={statusRef}></span>
      <textarea
        ref={textareaRef}
        className={s.editorInput}
        placeholder={(window.t ?? ((p: string) => p))('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
    </div>
  );
}
