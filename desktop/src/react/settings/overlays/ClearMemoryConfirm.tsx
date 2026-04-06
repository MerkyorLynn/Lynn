import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { useDialogA11y } from '../../hooks/use-dialog-a11y';
import styles from '../Settings.module.css';

export function ClearMemoryConfirm() {
  const { showToast } = useSettingsStore();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('hana-show-clear-confirm', handler);
    return () => window.removeEventListener('hana-show-clear-confirm', handler);
  }, []);

  const close = () => setVisible(false);
  const dialogRef = useDialogA11y({ open: visible, onClose: close });

  const doClear = async () => {
    close();
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memories?agentId=${aid}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.memory.actions.clearSuccess'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  if (!visible) return null;

  return (
    <div className={`${styles['memory-confirm-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        ref={dialogRef}
        className={styles['memory-confirm-card']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-memory-confirm-title"
        tabIndex={-1}
      >
        <p id="clear-memory-confirm-title" className={styles['memory-confirm-text']}>{t('settings.memory.actions.clearConfirm')}</p>
        <div className={styles['memory-confirm-actions']}>
          <button className={styles['memory-confirm-cancel']} onClick={close}>{t('settings.memory.actions.cancel')}</button>
          <button className={styles['memory-confirm-danger']} onClick={doClear}>{t('settings.memory.actions.confirmClear')}</button>
        </div>
      </div>
    </div>
  );
}
