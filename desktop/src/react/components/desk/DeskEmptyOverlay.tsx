/**
 * DeskEmptyOverlay — 未设置工作区时的空状态提示
 */

import { useStore } from '../../stores';
import { ICONS } from './desk-types';
import { applyFolder } from '../../stores/desk-actions';
import styles from './Desk.module.css';

export function DeskEmptyOverlay() {
  const deskBasePath = useStore(state => state.deskBasePath);
  const t = window.t ?? ((key: string) => key);

  const handleSelect = async () => {
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    applyFolder(folder);
  };

  if (deskBasePath) return null;

  return (
    <div className={styles.emptyOverlay}>
      <p className={styles.emptyText}>{t('desk.emptyTitle')}</p>
      <p className={styles.emptyHint}>{t('desk.emptyHint')}</p>
      <button className={styles.emptyBtn} onClick={handleSelect}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.folder }} />
        {t('input.selectWorkspace')}
      </button>
    </div>
  );
}
