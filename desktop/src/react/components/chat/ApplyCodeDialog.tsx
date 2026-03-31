/**
 * ApplyCodeDialog — 代码块 Apply 弹窗
 *
 * 点击 Apply 按钮后弹出，选择/输入文件路径，一键写入。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './ApplyCodeDialog.module.css';

interface Props {
  code: string;
  language?: string;
  onClose: () => void;
  anchorRect?: DOMRect;
}

export function ApplyCodeDialog({ code, language, onClose, anchorRect }: Props) {
  const [filePath, setFilePath] = useState('');
  const [status, setStatus] = useState<'idle' | 'applying' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 猜测文件扩展名
  const ext = language ? `.${language}` : '';

  const handleApply = useCallback(async () => {
    const path = filePath.trim();
    if (!path) return;
    setStatus('applying');
    try {
      const res = await hanaFetch('/api/fs/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: path, content: code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatus('success');
      setTimeout(onClose, 1200);
    } catch (err: unknown) {
      setErrorMsg((err as Error).message || 'Failed to apply');
      setStatus('error');
    }
  }, [filePath, code, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleApply, onClose]);

  // 关闭背景点击
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const content = (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.dialog} style={anchorRect ? {
        position: 'fixed',
        top: Math.min(anchorRect.bottom + 4, window.innerHeight - 180),
        left: Math.min(anchorRect.left, window.innerWidth - 340),
      } : undefined}>
        <div className={styles.header}>
          <span className={styles.title}>Apply to file</span>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder={`File path${ext ? ` (e.g. ./file${ext})` : '...'}`}
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={status === 'applying' || status === 'success'}
          />
          {status === 'error' && <div className={styles.error}>{errorMsg}</div>}
          {status === 'success' && <div className={styles.success}>✓ Applied successfully</div>}
        </div>
        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.applyBtn}
            onClick={handleApply}
            disabled={!filePath.trim() || status === 'applying' || status === 'success'}
          >
            {status === 'applying' ? 'Applying...' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
