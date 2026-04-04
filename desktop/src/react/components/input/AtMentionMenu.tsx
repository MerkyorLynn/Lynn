/**
 * AtMentionMenu — @ 文件/上下文选择器弹窗
 *
 * 在输入框中输入 @ 触发，模糊搜索工作空间文件。
 * 架构与 SlashCommandMenu 一致：textarea 上方 popup。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { buildAtMentionResults, type AtMentionFileResult } from '../../utils/at-mention-search';
import styles from './InputArea.module.css';

type FileResult = AtMentionFileResult;

interface Props {
  query: string;
  selected: number;
  onSelect: (file: FileResult) => void;
  onHover: (i: number) => void;
  onResultsChange?: (results: FileResult[]) => void;
}

export function AtMentionMenu({ query, selected, onSelect, onHover, onResultsChange }: Props) {
  const { t } = useI18n();
  const workingSetRecentFiles = useStore(s => s.workingSetRecentFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const [searchResults, setSearchResults] = useState<FileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const results = useMemo(() => buildAtMentionResults({
    query,
    searchResults,
    recentFiles: workingSetRecentFiles,
    basePath: deskBasePath || null,
  }), [deskBasePath, query, searchResults, workingSetRecentFiles]);

  useEffect(() => {
    onResultsChange?.(results);
  }, [onResultsChange, results]);

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setSearchResults([]);
      setLoading(false);
      return;
    }

    setSearchResults([]);

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await hanaFetch(`/api/desk/search?q=${encodeURIComponent(normalizedQuery)}`);
        const data = await res.json();
        if (requestId !== requestIdRef.current) return;
        setSearchResults(Array.isArray(data.files) ? data.files : []);
      } catch {
        if (requestId === requestIdRef.current) {
          setSearchResults([]);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
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
          <span className={styles['slash-menu-desc']}>{t('input.atDiscovery.searching') || '正在搜索...'}</span>
        </div>
      )}
      {!query.trim() && results.length > 0 && (
        <div className={styles['slash-menu-item']} style={{ opacity: 0.7, cursor: 'default' }}>
          <span className={styles['slash-menu-desc']}>{t('input.atDiscovery.menuHint') || '输入文件名筛选，或直接选择最近文件'}</span>
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
