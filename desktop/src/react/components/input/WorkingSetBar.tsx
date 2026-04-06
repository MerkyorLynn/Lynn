import styles from './InputArea.module.css';
import type { WorkingSetFile } from '../../stores/input-slice';

interface WorkingSetBarProps {
  files: WorkingSetFile[];
  currentDocPath?: string | null;
  docContextPath?: string | null;
  attachedPaths?: string[];
  onAttachFile: (file: WorkingSetFile) => void;
  onAttachCurrentDoc: () => void;
}

export function WorkingSetBar({
  files,
  currentDocPath,
  docContextPath,
  attachedPaths = [],
  onAttachFile,
  onAttachCurrentDoc,
}: WorkingSetBarProps) {
  if (!currentDocPath && files.length === 0) return null;

  const t = window.t ?? ((key: string) => key);
  const attachedSet = new Set(attachedPaths);
  const totalItems = files.length + (currentDocPath ? 1 : 0);

  return (
    <div className={styles['working-set-row']}>
      <div className={styles['working-set-head']}>
        <span className={styles['working-set-label']}>{t('input.docContext')}</span>
        <span className={styles['working-set-count']} title={`${totalItems}`}>
          {totalItems}
        </span>
      </div>
      <div className={styles['working-set-rail']}>
        {currentDocPath && (
          <button
            type="button"
            className={`${styles['working-set-chip']}${docContextPath === currentDocPath ? ` ${styles.active}` : ''}`}
            onClick={onAttachCurrentDoc}
          >
            <PinIcon />
            <span>{t('input.currentFile') || '当前文件'}</span>
          </button>
        )}
        {files.map((file) => {
          const active = attachedSet.has(file.path) || docContextPath === file.path;
          return (
            <button
              type="button"
              key={file.path}
              className={`${styles['working-set-chip']}${active ? ` ${styles.active}` : ''}`}
              onClick={() => onAttachFile(file)}
              title={file.path}
            >
              <FileIcon />
              <span>{file.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M8 3l8 8" />
      <path d="M17 8l4 4-6 1-7-7 1-6 4 4z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
