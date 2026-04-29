/**
 * JianEditor — jian.md 编辑器面板（支持拖拽文件插入链接）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import {
  closeDeskDocument,
  loadDeskAutomationStatus,
  loadJianContent,
  loadDeskPatrolStatus,
  saveDeskDocument,
  saveJianContent,
  triggerDeskHeartbeat,
} from '../../stores/desk-actions';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Desk.module.css';

const JIAN_PREFILL_KEY = 'hana-jian-prefill-used';
const PATROL_TRIGGERED_KEYS = new Set<string>();

function getJianPrefill(): string {
  const t = window.t ?? ((key: string) => key);
  const isZh = String(window.i18n?.locale || '').startsWith('zh');
  if (isZh) {
    return `# 今天的计划

- [ ] 把 README 翻译成中文
- [ ] 检查上周的 PR 有没有遗漏
- [ ] 整理项目文档

> 💡 写在这里的内容，Lynn 巡检时会自动读取并执行。
> 改掉这段示例，写上你今天要做的事试试看。`;
  }
  return `# Today's Plan

- [ ] Translate README to Chinese
- [ ] Review last week's PRs
- [ ] Organize project docs

> 💡 Lynn will automatically read and act on what you write here.
> Replace this example with your actual tasks and see what happens.`;
}

export function JianEditor() {
  const deskJianContent = useStore(s => s.deskJianContent);
  const deskOpenDoc = useStore(s => s.deskOpenDoc);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);
  const deskPatrolStatus = useStore(s => s.deskPatrolStatus);
  const deskAutomationStatus = useStore(s => s.deskAutomationStatus);
  const deskAutomationJobs = useStore(s => s.deskAutomationJobs);
  const [localValue, setLocalValue] = useState(deskOpenDoc?.content || deskJianContent || '');
  const [dragOver, setDragOver] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevContentRef = useRef(deskJianContent);
  const prevDocPathRef = useRef<string | null>(deskOpenDoc?.path || null);
  const t = window.t ?? ((p: string) => p);

  // 首次预填：jian 为空且从未使用过预填内容
  useEffect(() => {
    if (deskOpenDoc) return;
    if (deskJianContent === null || deskJianContent === '') {
      try {
        if (!localStorage.getItem(JIAN_PREFILL_KEY)) {
          const prefill = getJianPrefill();
          setLocalValue(prefill);
          // 不自动保存——等用户编辑时再保存，避免覆盖服务端空文件
        }
      } catch {
        // localStorage is only used to suppress the prefill hint.
      }
    }
  }, [deskJianContent, deskOpenDoc]);

  useEffect(() => {
    if (deskOpenDoc) {
      if (prevDocPathRef.current !== deskOpenDoc.path || localValue !== deskOpenDoc.content) {
        setLocalValue(deskOpenDoc.content || '');
        prevDocPathRef.current = deskOpenDoc.path;
      }
      return;
    }
    prevDocPathRef.current = null;
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(deskJianContent || '');
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent, deskOpenDoc, localValue]);

  useEffect(() => {
    if (deskOpenDoc) return;
    const workspaceKey = [deskBasePath, deskCurrentPath || ''].filter(Boolean).join('::');
    if (!workspaceKey) return;
    void loadDeskPatrolStatus();
    void loadDeskAutomationStatus();
    if (PATROL_TRIGGERED_KEYS.has(workspaceKey)) return;
    PATROL_TRIGGERED_KEYS.add(workspaceKey);
    void triggerDeskHeartbeat();
  }, [deskBasePath, deskCurrentPath, deskOpenDoc]);

  useEffect(() => {
    if (deskOpenDoc) return;
    if (deskPatrolStatus?.state !== 'running') return;
    const timer = window.setInterval(() => {
      void loadDeskPatrolStatus();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [deskOpenDoc, deskPatrolStatus?.state]);

  useEffect(() => {
    if (deskOpenDoc) return undefined;
    const refresh = () => {
      void loadJianContent();
      void loadDeskPatrolStatus();
      void loadDeskAutomationStatus();
    };
    window.addEventListener('hana-task-updated', refresh);
    window.addEventListener('hana-activity-updated', refresh);
    return () => {
      window.removeEventListener('hana-task-updated', refresh);
      window.removeEventListener('hana-activity-updated', refresh);
    };
  }, [deskOpenDoc]);

  // ── 文本输入 ──

  const updateAndSave = useCallback((newValue: string) => {
    setLocalValue(newValue);
    if (deskOpenDoc) {
      const targetDoc = { path: deskOpenDoc.path, name: deskOpenDoc.name };
      useStore.getState().setDeskOpenDoc({ ...deskOpenDoc, content: newValue });
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void saveDeskDocument(newValue, targetDoc);
      }, 800);
      return;
    }
    useStore.setState({ deskJianContent: newValue });
    prevContentRef.current = newValue;
    // 标记预填已使用（用户开始编辑后不再显示预填）
    try { localStorage.setItem(JIAN_PREFILL_KEY, '1'); } catch { /* localStorage may be unavailable */ }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveJianContent(newValue);
    }, 800);
  }, [deskOpenDoc]);

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

  const isDocMode = !!deskOpenDoc;
  const editorTitle = isDocMode ? deskOpenDoc.name : t('desk.jianLabel');
  const editorFooter = isDocMode
    ? (t('desk.openDocFooter') || '正在编辑这个文档 · 自动保存到原文件')
    : (t('desk.jianFooter') || 'Lynn 巡检时会自动读取这里的内容 · 支持 Markdown · ⌘J 切换');
  const patrolText = !isDocMode ? (
    deskPatrolStatus?.text
    || t('desk.patrolIdle')
    || '打开笺后会自动巡检一次'
  ) : '';
  const patrolStateClass = !isDocMode ? (
    deskPatrolStatus?.state === 'running'
      ? s.editorPatrolRunning
      : deskPatrolStatus?.state === 'error'
        ? s.editorPatrolError
        : deskPatrolStatus?.state === 'done'
          ? s.editorPatrolDone
          : ''
  ) : '';
  const automationText = !isDocMode
    ? (deskAutomationStatus?.text
      || t('desk.automationIdle')
      || '笺里的重复待办会自动变成自动任务')
    : '';
  const automationPreview = !isDocMode
    ? deskAutomationJobs.slice(0, 2).map((job) => ({
      id: job.id,
      label: job.label,
      next: job.nextRunAt
        ? new Date(job.nextRunAt).toLocaleTimeString(String(window.i18n?.locale || 'zh-CN'), {
          hour: '2-digit',
          minute: '2-digit',
        })
        : '',
    }))
    : [];

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
        <span className={s.editorLabel}>{editorTitle}</span>
        {isDocMode && (
          <div className={s.editorActions}>
            <button
              type="button"
              className={s.editorActionBtn}
              onClick={() => closeDeskDocument()}
            >
              {t('desk.openDocBack') || '返回笺'}
            </button>
          </div>
        )}
      </div>
      <span className={s.editorStatus} ref={statusRef}></span>
      {isDocMode && deskOpenDoc?.path && (
        <div className={s.editorMeta}>{deskOpenDoc.path}</div>
      )}
      <textarea
        ref={textareaRef}
        className={s.editorInput}
        placeholder={isDocMode ? '' : t('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
      <div className={s.editorFooter}>
        {editorFooter}
      </div>
      {!isDocMode && (
        <div className={`${s.editorPatrolBar} ${patrolStateClass}`.trim()}>
          <span className={s.editorPatrolDot} />
          <span>{patrolText}</span>
          <span className={s.editorPatrolFreq}>
            {[5, 15, 30].map((min) => (
              <button
                key={min}
                type="button"
                className={s.editorPatrolFreqBtn}
                title={`${min} ${t('desk.minutes') || '分钟'}`}
                onClick={() => {
                  hanaFetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ desk: { heartbeat_interval: min } }),
                  }).then(() => loadDeskPatrolStatus()).catch(() => {});
                }}
              >
                {min}m
              </button>
            ))}
          </span>
        </div>
      )}
      {!isDocMode && (
        <div className={s.editorAutomationBar}>
          <div className={s.editorAutomationSummary}>
            <span className={s.editorAutomationDot} />
            <span>{automationText}</span>
          </div>
          <button
            type="button"
            className={s.editorAutomationBtn}
            onClick={() => {
              useStore.setState({
                welcomeVisible: false,
                activePanel: 'automation',
              });
            }}
          >
            {t('automation.title') || '自动任务'}
          </button>
        </div>
      )}
      {!isDocMode && automationPreview.length > 0 && (
        <div className={s.editorAutomationList}>
          {automationPreview.map((job) => (
            <button
              key={job.id}
              type="button"
              className={s.editorAutomationChip}
              onClick={() => {
                useStore.setState({
                  welcomeVisible: false,
                  activePanel: 'automation',
                });
              }}
            >
              <span className={s.editorAutomationChipLabel}>{job.label}</span>
              {job.next ? <span className={s.editorAutomationChipMeta}>{job.next}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
