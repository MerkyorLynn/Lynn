import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { t, lookupModelMeta, autoSaveConfig, CONTEXT_PRESETS, OUTPUT_PRESETS } from '../../helpers';
import { ComboInput } from '../../widgets/ComboInput';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';

export function ModelEditPanel({ modelId, anchorEl, onClose }: {
  modelId: string;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const { showToast } = useSettingsStore();
  const meta = lookupModelMeta(modelId) || {};
  const [displayName, setDisplayName] = useState(meta.displayName || '');
  const [ctxVal, setCtxVal] = useState(String(meta.context || ''));
  const [outVal, setOutVal] = useState(String(meta.maxOutput || ''));
  const [vision, setVision] = useState<boolean>(meta.vision === true);
  const [reasoning, setReasoning] = useState<boolean>(meta.reasoning === true);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const save = async () => {
    const entry: Record<string, string | number | boolean> = {};
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.displayName = name;
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    entry.vision = vision;
    entry.reasoning = reasoning;
    const config = useSettingsStore.getState().settingsConfig;
    const currentOverrides = config?.models?.overrides || {};
    await autoSaveConfig({ models: { overrides: { ...currentOverrides, [modelId]: entry } } });
    showToast(t('settings.saved'), 'success');
    onClose();
  };

  return (
    <>
    <div className={styles['pv-model-edit-overlay']} onClick={onClose} />
    <div ref={panelRef} className={styles['pv-model-edit-card']} style={style}>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>ID</label>
        <span className={styles['pv-model-edit-id']}>{modelId}</span>
      </div>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>{t('settings.api.displayName')}</label>
        <input
          className={styles['settings-input']}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={modelId}
        />
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
        </div>
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.vision')}</label>
          <Toggle on={vision} onChange={setVision} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.reasoning')}</label>
          <Toggle on={reasoning} onChange={setReasoning} />
        </div>
      </div>
      <div className={styles['pv-model-edit-actions']}>
        <button type="button" className={styles['pv-add-form-btn']} onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
    </>
  );
}
