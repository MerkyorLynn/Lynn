/**
 * desk-actions.ts — 书桌文件操作（纯函数，不依赖 DOM）
 *
 * 从 desk-shim.ts 提取，供 React 组件直接调用。
 */

import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { clearChat } from './agent-actions';
import type { DeskAutomationJob } from './desk-slice';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调及 IPC callback data */

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;
const tt = (key: string, fallback: string, vars?: Record<string, string | number>) => {
  const value = t(key, vars);
  return !value || value === key ? fallback : value;
};
const INLINE_DESK_DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt']);

function formatPatrolTime(ts?: number | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString(String(window.i18n?.locale || 'zh-CN'), {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatAutomationTime(ts?: string | number | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString(String(window.i18n?.locale || 'zh-CN'), {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function deriveDeskPatrolStatus(activities: Array<any>) {
  const latest = [...(activities || [])]
    .filter((item) => item?.type === 'heartbeat')
    .sort((left, right) => Number(right?.startedAt || 0) - Number(left?.startedAt || 0))[0];

  if (!latest) {
    return {
      state: 'idle' as const,
      text: tt('desk.patrolIdle', '打开笺后会自动巡检一次'),
      updatedAt: null,
    };
  }

  if (!latest.finishedAt && latest.status !== 'error') {
    return {
      state: 'running' as const,
      text: tt('desk.patrolRunning', 'Lynn 正在阅读当前工作区与笺里的安排'),
      updatedAt: Number(latest.startedAt || Date.now()),
    };
  }

  if (latest.status === 'error') {
    return {
      state: 'error' as const,
      text: tt('desk.patrolError', '这次巡检没跑完，稍后会再试一次'),
      updatedAt: Number(latest.finishedAt || latest.startedAt || Date.now()),
    };
  }

  const patrolTime = formatPatrolTime(latest.finishedAt || latest.startedAt);
  return {
    state: 'done' as const,
    text: patrolTime
      ? tt('desk.patrolDoneAt', `上次巡检完成于 ${patrolTime}`, { time: patrolTime })
      : tt('desk.patrolDone', '刚刚完成一次巡检'),
    updatedAt: Number(latest.finishedAt || latest.startedAt || Date.now()),
  };
}

function deriveDeskAutomationStatus(jobs: DeskAutomationJob[]) {
  const enabledJobs = jobs.filter((job) => job.enabled);
  const pausedCount = jobs.length - enabledJobs.length;
  const nextJob = [...enabledJobs]
    .filter((job) => job.nextRunAt)
    .sort((left, right) => (
      Number(new Date(left.nextRunAt || 0).getTime()) - Number(new Date(right.nextRunAt || 0).getTime())
    ))[0];
  const nextTime = formatAutomationTime(nextJob?.nextRunAt);

  if (jobs.length === 0) {
    return {
      count: 0,
      enabledCount: 0,
      pausedCount: 0,
      nextRunAt: null,
      text: tt('desk.automationIdle', '笺里的重复待办会自动变成自动任务'),
    };
  }

  if (!nextTime) {
    return {
      count: jobs.length,
      enabledCount: enabledJobs.length,
      pausedCount,
      nextRunAt: nextJob?.nextRunAt || null,
      text: pausedCount > 0
        ? tt('desk.automationPausedSummary', `已设 ${jobs.length} 个自动任务 · ${pausedCount} 个暂停中`, { count: jobs.length, paused: pausedCount })
        : tt('desk.automationReady', `已设 ${jobs.length} 个自动任务`, { count: jobs.length }),
    };
  }

  return {
    count: jobs.length,
    enabledCount: enabledJobs.length,
    pausedCount,
    nextRunAt: nextJob?.nextRunAt || null,
    text: pausedCount > 0
      ? tt('desk.automationNextWithPause', `已设 ${jobs.length} 个自动任务 · 下次 ${nextTime} · ${pausedCount} 个暂停中`, { count: jobs.length, time: nextTime, paused: pausedCount })
      : tt('desk.automationNext', `已设 ${jobs.length} 个自动任务 · 下次 ${nextTime}`, { count: jobs.length, time: nextTime }),
  };
}

// ── 路径工具 ──

export function deskFullPath(name: string): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath + '/' + name
    : s.deskBasePath + '/' + name;
}

export function deskCurrentDir(): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath
    : s.deskBasePath;
}

export function shouldOpenDeskInline(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return INLINE_DESK_DOC_EXTS.has(ext);
}

export async function openDeskDocument(name: string): Promise<boolean> {
  const fullPath = deskFullPath(name);
  if (!fullPath) return false;

  try {
    const res = await hanaFetch(`/api/fs/read?path=${encodeURIComponent(fullPath)}`);
    const content = await res.text();
    if (content == null) {
      useStore.getState().addToast(tt('desk.openDocReadFailed', '没能读到这个文档'), 'error');
      return false;
    }
    const s = useStore.getState();
    s.setJianOpen(true);
    s.setDeskOpenDoc({ path: fullPath, name, content });
    return true;
  } catch (err) {
    console.error('[desk] open document failed:', err);
    useStore.getState().addToast(tt('desk.openDocReadFailed', '没能读到这个文档'), 'error');
    return false;
  }
}

export async function saveDeskDocument(
  content?: string,
  targetDoc?: { path: string; name?: string | null },
): Promise<boolean> {
  const s = useStore.getState();
  const doc = targetDoc ?? s.deskOpenDoc;
  if (!doc?.path) return false;
  const currentOpenDoc = s.deskOpenDoc;
  const nextContent = content ?? currentOpenDoc?.content ?? '';
  try {
    await hanaFetch('/api/fs/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: doc.path, content: nextContent }),
    });
    if (currentOpenDoc?.path === doc.path) {
      s.setDeskOpenDoc({ ...currentOpenDoc, content: nextContent });
    }
    return true;
  } catch (err) {
    console.error('[desk] save document failed:', err);
    s.addToast(tt('desk.openDocSaveFailed', '保存文档失败'), 'error');
    return false;
  }
}

export function closeDeskDocument(): void {
  useStore.getState().setDeskOpenDoc(null);
}

// ── 文件操作 ──

export async function loadDeskFiles(subdir?: string, overrideDir?: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  const prevPath = s.deskCurrentPath;
  const prevBasePath = s.deskBasePath;
  if (subdir !== undefined) s.setDeskCurrentPath(subdir);
  if ((subdir !== undefined && subdir !== prevPath) || (overrideDir && overrideDir !== prevBasePath)) {
    s.setDeskOpenDoc(null);
  }
  try {
    const params = new URLSearchParams();
    // 优先用 overrideDir，其次用 store 中已有的 deskBasePath 兜底。
    // 避免 pendingNewSession 期间后端 engine.deskCwd 仍指向旧 session 的问题。
    const dir = overrideDir || s.deskBasePath || undefined;
    if (dir) params.set('dir', dir);
    const curPath = subdir !== undefined ? subdir : s.deskCurrentPath;
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    if (data.basePath) st.setDeskBasePath(data.basePath);
    loadJianContent();
    void loadDeskPatrolStatus();
    void loadDeskAutomationStatus();
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
  }
}

export async function loadJianContent(): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const params = new URLSearchParams();
    if (s.deskBasePath) params.set('dir', s.deskBasePath);
    if (s.deskCurrentPath) params.set('subdir', s.deskCurrentPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/jian${qs}`);
    const data = await res.json();
    useStore.getState().setDeskJianContent(data.content || null);
  } catch (err) {
    console.error('[jian] load jian.md failed:', err);
    useStore.getState().setDeskJianContent(null);
  }
}

export async function loadDeskPatrolStatus(): Promise<void> {
  try {
    const res = await hanaFetch('/api/desk/activities');
    const data = await res.json();
    useStore.getState().setDeskPatrolStatus(deriveDeskPatrolStatus(data.activities || []));
  } catch (err) {
    console.error('[desk] load patrol status failed:', err);
    useStore.getState().setDeskPatrolStatus({
      state: 'idle',
      text: tt('desk.patrolIdle', '打开笺后会自动巡检一次'),
      updatedAt: null,
    });
  }
}

export async function loadDeskAutomationStatus(): Promise<void> {
  try {
    const res = await hanaFetch('/api/desk/cron');
    const data = await res.json();
    const currentDir = deskCurrentDir();
    const allJobs: Array<Record<string, any>> = Array.isArray(data.jobs) ? data.jobs : [];
    const jobs = currentDir
      ? allJobs.filter((job: Record<string, any>) => String(job?.workspace || '').trim() === currentDir)
      : [];
    const normalizedJobs: DeskAutomationJob[] = jobs.map((job: Record<string, any>) => ({
      id: String(job.id || ''),
      label: String(job.label || job.prompt || '').trim() || tt('sidebar.capability.automation', '自动任务'),
      enabled: job.enabled !== false,
      schedule: job.schedule,
      nextRunAt: job.nextRunAt || null,
      workspace: String(job.workspace || '').trim(),
      model: job.model || null,
    }));
    useStore.setState({
      automationCount: allJobs.length,
      deskAutomationJobs: normalizedJobs,
      deskAutomationStatus: deriveDeskAutomationStatus(normalizedJobs),
    });
  } catch (err) {
    console.error('[desk] load automation status failed:', err);
    useStore.setState({
      deskAutomationJobs: [],
      deskAutomationStatus: {
        count: 0,
        enabledCount: 0,
        pausedCount: 0,
        nextRunAt: null,
        text: tt('desk.automationIdle', '笺里的重复待办会自动变成自动任务'),
      },
    });
  }
}

export async function triggerDeskHeartbeat(): Promise<void> {
  useStore.getState().setDeskPatrolStatus({
    state: 'running',
    text: tt('desk.patrolRunning', 'Lynn 正在阅读当前工作区与笺里的安排'),
    updatedAt: Date.now(),
  });
  try {
    await hanaFetch('/api/desk/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    await loadDeskPatrolStatus();
    await loadDeskAutomationStatus();
  } catch (err) {
    console.error('[desk] trigger heartbeat failed:', err);
    useStore.getState().setDeskPatrolStatus({
      state: 'error',
      text: tt('desk.patrolError', '这次巡检没跑完，稍后会再试一次'),
      updatedAt: Date.now(),
    });
  }
}

export async function saveJianContent(content?: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  const text = content ?? s.deskJianContent ?? '';
  try {
    await hanaFetch('/api/desk/jian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', content: text }),
    });
    useStore.getState().setDeskJianContent(text || null);
    const st2 = useStore.getState();
    const params = new URLSearchParams();
    if (st2.deskBasePath) params.set('dir', st2.deskBasePath);
    if (st2.deskCurrentPath) params.set('subdir', st2.deskCurrentPath);
    const qs = params.toString() ? `?${params}` : '';
    const res2 = await hanaFetch(`/api/desk/files${qs}`);
    const data2 = await res2.json();
    useStore.getState().setDeskFiles(data2.files || []);
    void loadDeskPatrolStatus();
    void loadDeskAutomationStatus();
  } catch (err) {
    console.error('[jian] save jian.md failed:', err);
  }
}

export async function deskUploadFiles(paths: string[]): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', paths }),
    });
    const data = await res.json();
    if (data.files) useStore.getState().setDeskFiles(data.files);
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskCreateFile(text: string): Promise<void> {
  const s = useStore.getState();
  const ts = new Date().toISOString().slice(5, 16).replace(/[T:]/g, '-');
  const locale = window.i18n?.locale || 'zh';
  const prefix = locale.startsWith('zh') ? '备注' : locale.startsWith('ja') ? 'メモ' : locale.startsWith('ko') ? '메모' : 'note';
  const name = `${prefix}_${ts}.md`;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name, content: text }),
    });
    const data = await res.json();
    if (data.files) useStore.getState().setDeskFiles(data.files);
  } catch (err) {
    console.error('[jian-desk] create failed:', err);
  }
}

export async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', names, destFolder }),
    });
    const data = await res.json();
    if (data.files) useStore.getState().setDeskFiles(data.files);
  } catch (err) {
    console.error('[jian-desk] move failed:', err);
  }
}

export async function deskRemoveFile(name: string): Promise<boolean> {
  const s = useStore.getState();
  const fullPath = deskFullPath(name);
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[jian-desk] remove error:', data.error);
      return false;
    }
    if (data.files) useStore.getState().setDeskFiles(data.files);
    if (fullPath && useStore.getState().deskOpenDoc?.path === fullPath) {
      useStore.getState().setDeskOpenDoc(null);
    }
    return true;
  } catch (err) {
    console.error('[jian-desk] remove failed:', err);
    return false;
  }
}

/**
 * deskMkdir — 新建文件夹，并返回新文件夹名（供调用者触发 rename）。
 */
export async function deskMkdir(): Promise<string | null> {
  const s = useStore.getState();
  let name = t('desk.newFolder');
  const existing = new Set(s.deskFiles.map((f: { name: string }) => f.name));
  if (existing.has(name)) {
    let i = 2;
    while (existing.has(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mkdir', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name }),
    });
    const data = await res.json();
    if (data.files) {
      useStore.getState().setDeskFiles(data.files);
      return name;
    }
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
  }
  return null;
}

export async function deskRenameFile(oldName: string, newName: string): Promise<boolean> {
  const oldPath = deskFullPath(oldName);
  const newPath = deskFullPath(newName);
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', dir: useStore.getState().deskBasePath || undefined, subdir: useStore.getState().deskCurrentPath || '', oldName, newName }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] rename error:', data.error); return false; }
    if (data.files) useStore.getState().setDeskFiles(data.files);
    const openDoc = useStore.getState().deskOpenDoc;
    if (openDoc && oldPath && openDoc.path === oldPath && newPath) {
      useStore.getState().setDeskOpenDoc({ ...openDoc, path: newPath, name: newName });
    }
    return true;
  } catch (err) { console.error('[desk] rename failed:', err); return false; }
}

// ── 状态工具 ──

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export function applyFolder(folder: string): void {
  useStore.setState({ selectedFolder: folder });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  loadDeskFiles('', folder);
}

export function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

export function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  const tab = s.currentTab || 'chat';
  localStorage.setItem(`hana-jian-${tab}`, newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
}

export function initJian(): void {
  const legacy = localStorage.getItem('hana-jian');
  if (legacy && !localStorage.getItem('hana-jian-chat')) localStorage.setItem('hana-jian-chat', legacy);
  useStore.getState().setJianOpen(false);
  const s = useStore.getState();
  loadDeskFiles('', s.selectedFolder || s.homeFolder || undefined);
}
