import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import styles from './FloatingActions.module.css';
import type { Artifact } from '../../types';

interface Props {
  artifact: Artifact;
  content: string;
  editable: boolean;
  onDetach: () => void;
  onExport: () => void;
}

export function FloatingActions({ artifact, content, editable, onDetach, onExport }: Props) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInputFocus = useStore((s) => s.requestInputFocus);
  const addAttachedFile = useStore((s) => s.addAttachedFile);


  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [content]);

  const handleOpenInBrowser = useCallback(() => {
    window.platform?.openHtmlInBrowser?.(content, artifact.title);
  }, [content, artifact.title]);

  const handleAttachToInput = useCallback(() => {
    if (!artifact.filePath) return;
    addAttachedFile({
      path: artifact.filePath,
      name: artifact.title || artifact.filePath.split('/').pop() || artifact.filePath,
    });
    requestInputFocus();
  }, [addAttachedFile, artifact.filePath, artifact.title, requestInputFocus]);

  const t = window.t ?? ((p: string) => p);
  const canReveal = !!artifact.filePath;

  return (
    <div className={styles.floatingActions} data-react-managed>
      <button className={styles.actionBtn} onClick={handleCopy}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{copyLabel ?? t('attach.copy')}</span>
      </button>
      {artifact.type === 'html' && (
        <button className={styles.actionBtn} onClick={handleOpenInBrowser} title={t('preview.openInBrowser')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span>{t('preview.openInBrowser')}</span>
        </button>
      )}
      {artifact.filePath && (
        <button className={styles.actionBtn} onClick={handleAttachToInput} title={t('input.attachFile')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="14" y2="17" />
          </svg>
          <span>{t('input.attachFile')}</span>
        </button>
      )}
      <button className={styles.actionBtn} onClick={onExport} title={canReveal ? t('desk.openInFinder') : t('common.save')}> 
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {canReveal ? (
            <>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="10 14 21 3" />
              <polyline points="15 3 21 3 21 9" />
            </>
          ) : (
            <>
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </>
          )}
        </svg>
        <span>{canReveal ? t('desk.openInFinder') : t('common.save')}</span>
      </button>
      {editable && (
        <button className={styles.actionBtn} title="Open in window" onClick={onDetach}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="15" height="15" rx="2" ry="2" />
            <path d="M7 2h15v15" />
          </svg>
        </button>
      )}
    </div>
  );
}
