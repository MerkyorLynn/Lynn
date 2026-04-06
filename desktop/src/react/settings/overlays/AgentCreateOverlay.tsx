import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { switchToAgent } from '../actions';
import { getDisplayYuanEntries, isBundledLynnAvatarSrc, resolveBundledAvatar } from '../../utils/agent-helpers';
import { useDialogA11y } from '../../hooks/use-dialog-a11y';
import styles from '../Settings.module.css';

const platform = window.platform;

export function AgentCreateOverlay() {
  const { showToast } = useSettingsStore();
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [yuan, setYuan] = useState('hanako');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => {
      setName('');
      setYuan('hanako');
      setVisible(true);
    };
    window.addEventListener('hana-show-agent-create', handler);
    return () => window.removeEventListener('hana-show-agent-create', handler);
  }, []);

  const close = () => setVisible(false);
  const dialogRef = useDialogA11y({ open: visible, onClose: close, initialFocusRef: inputRef });

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) { showToast(t('settings.agent.nameRequired'), 'error'); return; }

    setCreating(true);
    try {
      const res = await hanaFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, yuan }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      close();
      showToast(t('settings.agent.created', { name: data.name }), 'success');
      platform?.settingsChanged?.('agent-created', { agentId: data.id, name: data.name });
      await switchToAgent(data.id);
    } catch (err: any) {
      showToast(t('settings.agent.createFailed') + ': ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  if (!visible) return null;

  const types = t('yuan.types') || {};
  const entries = getDisplayYuanEntries(types);

  return (
    <div className={`${styles['agent-create-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        ref={dialogRef}
        className={styles['agent-create-card']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-create-title"
        tabIndex={-1}
      >
        <h3 id="agent-create-title" className={styles['agent-create-title']}>{t('settings.agent.createTitle')}</h3>
        <div className={styles['settings-field']}>
          <input
            ref={inputRef}
            className={styles['settings-input']}
            type="text"
            placeholder={t('settings.agent.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); create(); }
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <div className="yuan-selector">
            <div className="yuan-chips">
              {entries.filter(([key]) => key !== 'kong').map(([key, meta]) => (
                <button
                  key={key}
                  className={`${'yuan-chip'}${key === yuan ? ' ' + styles['selected'] : ''}`}
                  type="button"
                  onClick={() => setYuan(key)}
                >
                  {(() => {
                    const avatarSrc = resolveBundledAvatar(meta.avatar || 'Lynn.png');
                    const isBundledLynnAvatar = isBundledLynnAvatarSrc(avatarSrc);
                    return (
                      <span className="yuan-chip-avatar-shell">
                        <img
                          className={`yuan-chip-avatar${isBundledLynnAvatar ? ' yuan-chip-avatar-bundled-lynn' : ''}`}
                          src={avatarSrc}
                          draggable={false}
                        />
                      </span>
                    );
                  })()}
                  <div className="yuan-chip-info">
                    <span className="yuan-chip-name">{meta.name || key}</span>
                    <span className="yuan-chip-desc">{meta.label || ''}</span>
                  </div>
                </button>
              ))}
            </div>
            {entries.filter(([key]) => key === 'kong').map(([key, meta]) => (
              <button
                key={key}
                className={`${'yuan-chip'}${key === yuan ? ' ' + styles['selected'] : ''}`}
                type="button"
                onClick={() => setYuan(key)}
              >
                {(() => {
                  const avatarSrc = resolveBundledAvatar(meta.avatar || 'Lynn.png');
                  const isBundledLynnAvatar = isBundledLynnAvatarSrc(avatarSrc);
                  return (
                    <span className="yuan-chip-avatar-shell">
                      <img
                        className={`yuan-chip-avatar${isBundledLynnAvatar ? ' yuan-chip-avatar-bundled-lynn' : ''}`}
                        src={avatarSrc}
                        draggable={false}
                      />
                    </span>
                  );
                })()}
                <div className="yuan-chip-info">
                  <span className="yuan-chip-name">{meta.name || key}</span>
                  <span className="yuan-chip-desc">{meta.label || ''}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className={styles['agent-create-actions']}>
          <button className={styles['agent-create-cancel']} onClick={close}>{t('settings.agent.cancel')}</button>
          <button className={styles['agent-create-confirm']} onClick={create} disabled={creating}>{t('settings.agent.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
