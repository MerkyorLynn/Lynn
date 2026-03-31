/**
 * DeskToolbar — 工作区入口、面包屑导航、排序按钮
 */

import { useCallback } from 'react';
import { useStore } from '../../stores';
import { applyFolder, loadDeskFiles } from '../../stores/desk-actions';
import {
  ICONS,
  getSortOptions,
  getSortShort,
  type SortMode,
  type CtxMenuState,
} from './desk-types';
import { showSidebarToast } from '../../stores/session-actions';
import s from './Desk.module.css';

function folderLabel(folderPath: string | null): string {
  if (!folderPath) return '';
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

export function DeskWorkspaceButton() {
  const deskBasePath = useStore(state => state.deskBasePath || state.selectedFolder || state.homeFolder || null);
  const t = window.t ?? ((key: string) => key);

  const handlePick = useCallback(async () => {
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    applyFolder(folder);
  }, []);

  const handleReveal = useCallback(() => {
    if (!deskBasePath) {
      showSidebarToast(t('desk.noDeskRoot'));
      return;
    }
    window.platform?.showInFinder?.(deskBasePath);
  }, [deskBasePath, t]);

  return (
    <div className={s.workspaceBar}>
      <button className={s.openBtn} onClick={handlePick} title={deskBasePath || t('input.selectFolder')}>
        <span className={s.workspaceBtnIcon} dangerouslySetInnerHTML={{ __html: ICONS.folder }} />
        <span className={s.workspaceBtnCopy}>
          <span className={s.workspaceBtnTitle}>
            {deskBasePath ? folderLabel(deskBasePath) : t('input.selectWorkspace')}
          </span>
          {deskBasePath && <span className={s.workspaceBtnMeta}>{deskBasePath}</span>}
        </span>
      </button>
      {deskBasePath && (
        <button
          className={s.workspaceRevealBtn}
          onClick={handleReveal}
          title={t('desk.openInFinder')}
          aria-label={t('desk.openInFinder')}
        >
          <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
        </button>
      )}
    </div>
  );
}

export function DeskBreadcrumb() {
  const deskCurrentPath = useStore(state => state.deskCurrentPath);

  const handleBack = useCallback(() => {
    const state = useStore.getState();
    const currentPath = state.deskCurrentPath;
    if (!currentPath) return;
    const parent = currentPath.includes('/')
      ? currentPath.substring(0, currentPath.lastIndexOf('/'))
      : '';
    loadDeskFiles(parent);
  }, []);

  if (!deskCurrentPath) return null;

  return (
    <div className={s.nav}>
      <button className={s.backBtn} onClick={handleBack}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.back }} />
        <span>{deskCurrentPath}</span>
      </button>
    </div>
  );
}

export function DeskSortButton({ sortMode, onSort, onShowMenu }: {
  sortMode: SortMode;
  onSort: (mode: SortMode) => void;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const handleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onShowMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items: getSortOptions().map(option => ({
        label: (option.key === sortMode ? '. ' : '  ') + option.label,
        action: () => {
          localStorage.setItem('hana-desk-sort', option.key);
          onSort(option.key);
        },
      })),
    });
  }, [sortMode, onSort, onShowMenu]);

  return (
    <button className={s.sortBtn} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.sort }} />
      <span>{getSortShort(sortMode)}</span>
    </button>
  );
}
