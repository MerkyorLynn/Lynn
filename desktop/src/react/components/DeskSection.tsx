/**
 * DeskSection — 右侧工作区 / 技能侧栏
 */

import { useCallback, useState } from 'react';
import { useStore } from '../stores';
import { ContextMenu } from './ContextMenu';
import { DESK_SORT_KEY, type SortMode, type CtxMenuState } from './desk/desk-types';
import { DeskWorkspaceButton, DeskBreadcrumb, DeskSortButton } from './desk/DeskToolbar';
import { DeskFileList } from './desk/DeskFileList';
import { JianEditor } from './desk/DeskEditor';
import { DeskDropZone } from './desk/DeskDropZone';
import { DeskEmptyOverlay } from './desk/DeskEmptyOverlay';
import { DeskCwdSkillsButton, DeskCwdSkillsPanel } from './desk/DeskCwdSkills';
import { DeskSkillsSection } from './desk/DeskSkillsSection';
import styles from './desk/Desk.module.css';

export function DeskSection() {
  const deskFiles = useStore(state => state.deskFiles);
  const deskBasePath = useStore(state => state.deskBasePath);
  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(DESK_SORT_KEY) as SortMode) || 'mtime-desc',
  );
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const handleShowMenu = useCallback((state: CtxMenuState) => {
    setCtxMenu(state);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const t = window.t ?? ((key: string) => key);
  const hasWorkspace = !!deskBasePath;
  const showFileSurface = hasWorkspace && deskFiles.length > 0;

  return (
    <>
      <DeskDropZone onShowMenu={handleShowMenu}>
        <div className={styles.header}>
          <div className={`jian-section-title ${styles.sectionTitle}`}>{t('desk.title')}</div>
          {hasWorkspace && <DeskCwdSkillsButton />}
        </div>
        <DeskWorkspaceButton />
        <DeskCwdSkillsPanel />
        <DeskSkillsSection />
        {showFileSurface && (
          <>
            <div className={styles.toolbar}>
              <DeskBreadcrumb />
              <DeskSortButton sortMode={sortMode} onSort={setSortMode} onShowMenu={handleShowMenu} />
            </div>
            <div className={styles.fileSection}>
              <div className={styles.fileSectionHeader}>{t('desk.workspace') || t('input.workspace')}</div>
              <DeskFileList sortMode={sortMode} onShowMenu={handleShowMenu} />
            </div>
          </>
        )}
        <JianEditor />
        <DeskEmptyOverlay />
      </DeskDropZone>
      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          position={ctxMenu.position}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
