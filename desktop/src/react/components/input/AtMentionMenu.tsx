/**
 * AtMentionMenu — @ 文件/上下文选择器弹窗
 *
 * 在输入框中输入 @ 触发，模糊搜索工作空间文件。
 * 架构与 SlashCommandMenu 一致：textarea 上方 popup。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './InputArea.module.css';

interface FileResult {
  name: string;
  path: string;
  rel: string;
  isDir: boolean;
}

interface Props {
  query: string;
  selected: number;
  onSelect: (file: FileResult) => void;
  onHover: (i: number) => void;
}

export function AtMentionMenu({ query, selected, onSelect, onHover }: Props) {
  const [results, setResults] = useState<FileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await hanaFetch(`/api/desk/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.files || []);
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }, 80); // 80ms debounce for responsiveness

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  if (results.length === 0 && !loading) return null;

  return (
    <div className={styles['slash-menu']} data-at-menu>
      {loading && results.length === 0 && (
        <div className={styles['slash-menu-item']} style={{ opacity: 0.5, cursor: 'default' }}>
          <span className={styles['slash-menu-desc']}>Searching...</span>
        </div>
      )}
      {results.map((file, i) => (
        <button
          key={file.path}
          className={`${styles['slash-menu-item']}${i === selected ? ` ${styles.selected}` : ''}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(file)}
        >
          <span className={styles['slash-menu-icon']}>
            {file.isDir ? '📁' : '📄'}
          </span>
          <span className={styles['slash-menu-label']}>{file.name}</span>
          <span className={styles['slash-menu-desc']}>{file.rel}</span>
        </button>
      ))}
    </div>
  );
}
