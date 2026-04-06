import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { collectSessionDiffs, type SessionDiffEntry } from '../utils/change-review';
import { DiffViewer } from './chat/DiffViewer';
import fp from './FloatingPanels.module.css';

interface GitContextResponse {
  available?: boolean;
  repoName?: string | null;
  branch?: string | null;
  totalChanged?: number;
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  linesAdded?: number;
  linesRemoved?: number;
  changedFiles?: string[];
}

interface GitDiffResponse {
  available?: boolean;
  filePath?: string;
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

interface ChangeReviewFile {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  rollbackId?: string | null;
  source: 'session' | 'git';
  diff?: string;
}

function baseName(filePath: string): string {
  const bits = filePath.split('/');
  return bits[bits.length - 1] || filePath;
}

export function ChangesPanel() {
  const activePanel = useStore((s) => s.activePanel);
  const setActivePanel = useStore((s) => s.setActivePanel);
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const chatSessions = useStore((s) => s.chatSessions);
  const sessions = useStore((s) => s.sessions);
  const taskSnapshot = useStore((s) => s.taskSnapshot);
  const deskBasePath = useStore((s) => s.deskBasePath || s.selectedFolder || s.homeFolder || null);
  const [gitContext, setGitContext] = useState<GitContextResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [gitDiffCache, setGitDiffCache] = useState<Record<string, GitDiffResponse>>({});
  const [revertingAll, setRevertingAll] = useState(false);
  const zh = String(document?.documentElement?.lang || '').startsWith('zh');

  const sessionItems = currentSessionPath ? chatSessions[currentSessionPath]?.items || [] : [];
  const diffSummary = useMemo(() => collectSessionDiffs(sessionItems), [sessionItems]);
  const currentSession = useMemo(
    () => sessions.find((session) => session.path === currentSessionPath) || null,
    [sessions, currentSessionPath],
  );
  const fallbackSession = useMemo(() => {
    const sorted = [...sessions].sort((left, right) => {
      return new Date(right.modified).getTime() - new Date(left.modified).getTime();
    });
    return sorted.find((session) => !!session.cwd) || null;
  }, [sessions]);
  const chipSession = currentSession?.cwd ? currentSession : fallbackSession;
  const taskLead = taskSnapshot?.recent?.[0] || null;
  const taskLeadCwd = typeof taskLead?.snapshot?.cwd === 'string' ? taskLead.snapshot.cwd : null;
  const workspacePath = chipSession?.cwd || taskLeadCwd || deskBasePath || null;

  const changeFiles = useMemo<ChangeReviewFile[]>(() => {
    if (diffSummary.files.length > 0) {
      return diffSummary.files.map((file) => ({
        filePath: file.filePath,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
        rollbackId: file.rollbackId || null,
        source: 'session',
        diff: file.diff,
      }));
    }
    return (gitContext?.changedFiles || []).map((filePath) => {
      const cached = gitDiffCache[filePath];
      return {
        filePath,
        linesAdded: cached?.linesAdded || 0,
        linesRemoved: cached?.linesRemoved || 0,
        rollbackId: null,
        source: 'git',
        diff: cached?.diff,
      };
    });
  }, [diffSummary.files, gitContext?.changedFiles, gitDiffCache]);

  const filteredFiles = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return changeFiles;
    return changeFiles.filter((file) => file.filePath.toLowerCase().includes(keyword));
  }, [changeFiles, filter]);
  const selectedDiff = useMemo(
    () => filteredFiles.find((file) => file.filePath === selectedPath) || filteredFiles[0] || null,
    [filteredFiles, selectedPath],
  );

  useEffect(() => {
    if (!selectedDiff) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath !== selectedDiff.filePath) {
      setSelectedPath(selectedDiff.filePath);
    }
  }, [selectedDiff, selectedPath]);

  useEffect(() => {
    let cancelled = false;
    async function loadGitContext() {
      if (activePanel !== 'changes' || !workspacePath) {
        if (!cancelled) setGitContext(null);
        return;
      }
      try {
        const res = await hanaFetch(`/api/desk/git-context?dir=${encodeURIComponent(workspacePath)}`, { timeout: 8000 });
        const data = await res.json();
        if (!cancelled) setGitContext(data || null);
      } catch {
        if (!cancelled) setGitContext(null);
      }
    }
    loadGitContext();
    return () => {
      cancelled = true;
    };
  }, [activePanel, workspacePath, currentSessionPath, sessionItems.length]);

  useEffect(() => {
    let cancelled = false;
    async function loadSelectedGitDiff() {
      if (activePanel !== 'changes' || !workspacePath || !selectedDiff || selectedDiff.source !== 'git') return;
      if (gitDiffCache[selectedDiff.filePath]?.available) return;
      try {
        const res = await hanaFetch(
          `/api/desk/git-diff?dir=${encodeURIComponent(workspacePath)}&file=${encodeURIComponent(selectedDiff.filePath)}`,
          { timeout: 8000 },
        );
        const data = await res.json();
        if (cancelled) return;
        setGitDiffCache((prev) => ({
          ...prev,
          [selectedDiff.filePath]: data || { available: false, filePath: selectedDiff.filePath },
        }));
      } catch {
        if (!cancelled) {
          setGitDiffCache((prev) => ({
            ...prev,
            [selectedDiff.filePath]: { available: false, filePath: selectedDiff.filePath },
          }));
        }
      }
    }
    void loadSelectedGitDiff();
    return () => {
      cancelled = true;
    };
  }, [activePanel, workspacePath, selectedDiff, gitDiffCache]);

  // 收集所有可回滚的 rollbackId
  const rollbackIds = useMemo(() => {
    return diffSummary.files
      .filter((f: SessionDiffEntry) => f.rollbackId)
      .map((f: SessionDiffEntry) => f.rollbackId!);
  }, [diffSummary.files]);

  const handleRevertAll = useCallback(async () => {
    if (revertingAll || rollbackIds.length === 0) return;
    setRevertingAll(true);
    let success = 0;
    for (const rollbackId of rollbackIds) {
      try {
        await hanaFetch('/api/fs/revert-edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rollbackId }),
        });
        success++;
      } catch {}
    }
    setRevertingAll(false);
  }, [revertingAll, rollbackIds]);

  if (activePanel !== 'changes') return null;

  return (
    <div className={`${fp.floatingPanel}${maximized ? ` ${fp.changesPanelMaximized}` : ''}`}>
      <div className={`${fp.floatingPanelInner} ${fp.changesPanelInner}${maximized ? ` ${fp.changesPanelInnerMax}` : ''}`}>
        <div className={fp.floatingPanelHeader}>
          <div className={fp.changesHeaderInfo}>
            <h2 className={fp.floatingPanelTitle}>{zh ? '本轮改动' : 'Changes'}</h2>
            <div className={fp.changesHeaderMeta}>
              {gitContext?.repoName || (zh ? '当前工作区' : 'workspace')}
              {gitContext?.branch ? ` · ${gitContext.branch}` : ''}
            </div>
          </div>
          <div className={fp.changesHeaderActions}>
            <button
              className={fp.changesMaxBtn}
              onClick={() => setMaximized((v) => !v)}
              title={maximized ? (zh ? '退出全屏' : 'Exit fullscreen') : (zh ? '最大化审查' : 'Maximize')}
            >
              {maximized ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
            <button className={fp.floatingPanelClose} onClick={() => setActivePanel(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className={fp.changesSummaryBar}>
          <span className={`${fp.changesSummaryChip} ${fp.changesSummaryAdd}`}>+{diffSummary.linesAdded}</span>
          <span className={`${fp.changesSummaryChip} ${fp.changesSummaryRemove}`}>-{diffSummary.linesRemoved}</span>
          {diffSummary.linesAdded === 0 && diffSummary.linesRemoved === 0 && ((gitContext?.linesAdded || 0) > 0 || (gitContext?.linesRemoved || 0) > 0) && (
            <>
              <span className={`${fp.changesSummaryChip} ${fp.changesSummaryAdd}`}>+{gitContext?.linesAdded || 0}</span>
              <span className={`${fp.changesSummaryChip} ${fp.changesSummaryRemove}`}>-{gitContext?.linesRemoved || 0}</span>
            </>
          )}
          {typeof gitContext?.totalChanged === 'number' && (
            <span className={fp.changesSummaryChip}>
              {zh ? `${gitContext.totalChanged} 个改动文件` : `${gitContext.totalChanged} changed files`}
            </span>
          )}
          {typeof gitContext?.stagedCount === 'number' && gitContext.stagedCount > 0 && (
            <span className={fp.changesSummaryChip}>
              {zh ? `已暂存 ${gitContext.stagedCount}` : `staged ${gitContext.stagedCount}`}
            </span>
          )}
          {typeof gitContext?.untrackedCount === 'number' && gitContext.untrackedCount > 0 && (
            <span className={fp.changesSummaryChip}>
              {zh ? `未跟踪 ${gitContext.untrackedCount}` : `untracked ${gitContext.untrackedCount}`}
            </span>
          )}
          {rollbackIds.length > 0 && (
            <button
              className={fp.changesRevertAllBtn}
              onClick={handleRevertAll}
              disabled={revertingAll}
              title={zh ? '撤回本轮所有可回滚的改动' : 'Revert all rollbackable changes'}
            >
              {revertingAll
                ? (zh ? '撤回中…' : 'Reverting…')
                : (zh ? `↩ 一键撤回 (${rollbackIds.length})` : `↩ Revert all (${rollbackIds.length})`)}
            </button>
          )}
        </div>

        <div className={fp.changesBody}>
          <div className={fp.changesMain}>
            {selectedDiff ? (
              <DiffViewer
                filePath={selectedDiff.filePath}
                diff={selectedDiff.source === 'git' ? (gitDiffCache[selectedDiff.filePath]?.diff || '') : (selectedDiff.diff || '')}
                linesAdded={selectedDiff.linesAdded}
                linesRemoved={selectedDiff.linesRemoved}
                rollbackId={selectedDiff.rollbackId || undefined}
                maximized={maximized}
              />
            ) : (
              <div className={fp.changesEmpty}>
                {gitContext?.available
                  ? (zh
                      ? '已经检测到当前工作区有改动。这里会优先展示本轮变更；如果这轮没有内联 diff，就回退到 Git 改动明细。'
                      : 'Changes were detected in the current workspace. Session diffs show up here first, with Git changes as a fallback.')
                  : (zh
                      ? '这一轮还没有产生可审查的文件改动。'
                      : 'No file changes to inspect in this session yet.')}
              </div>
            )}
          </div>

          <aside className={fp.changesSidebar}>
            <input
              className={fp.changesFilterInput}
              placeholder={zh ? '筛选文件…' : 'Filter files…'}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className={fp.changesFileList}>
              {filteredFiles.length > 0 ? (
                filteredFiles.map((file) => (
                  <ChangeFileButton
                    key={file.filePath}
                    file={file}
                    active={selectedDiff?.filePath === file.filePath}
                    onClick={() => setSelectedPath(file.filePath)}
                  />
                ))
              ) : (
                <div className={fp.changesSidebarEmpty}>
                  {zh ? '没有匹配的文件' : 'No matching files'}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ChangeFileButton({
  file,
  active,
  onClick,
}: {
  file: ChangeReviewFile;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`${fp.changesFileItem}${active ? ` ${fp.changesFileItemActive}` : ''}`} onClick={onClick}>
      <div className={fp.changesFileName}>{baseName(file.filePath)}</div>
      <div className={fp.changesFileMeta}>
        {file.linesAdded > 0 && <span className={fp.changesFileAdd}>+{file.linesAdded}</span>}
        {file.linesRemoved > 0 && <span className={fp.changesFileRemove}>-{file.linesRemoved}</span>}
      </div>
    </button>
  );
}
