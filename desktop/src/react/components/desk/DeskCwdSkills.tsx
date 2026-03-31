/**
 * DeskCwdSkills — 当前工作区技能面板
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { CwdSkillInfo } from '../../stores/desk-slice';
import styles from './Desk.module.css';

/** 上次成功的 ETag，用于 If-None-Match 条件请求 */
let _lastEtag = '';

async function loadCwdSkills(background = false) {
  const state = useStore.getState();
  if (!state.deskBasePath) return;
  try {
    const headers: Record<string, string> = {};
    // 有缓存数据时发送 If-None-Match，可能得到 304
    if (background && _lastEtag) {
      headers['If-None-Match'] = _lastEtag;
    }
    const response = await hanaFetch(
      `/api/desk/skills?dir=${encodeURIComponent(state.deskBasePath)}`,
      { headers },
    );
    // 304 Not Modified — 缓存仍有效，不更新 store
    if (response.status === 304) return;
    const etag = response.headers.get('ETag');
    if (etag) _lastEtag = etag;
    const data = await response.json();
    useStore.setState({ cwdSkills: data.skills || [] });
  } catch {
    // ignore
  }
}

function useCwdSkillsOpen() {
  const cwdSkills = useStore(state => state.cwdSkills);
  const cwdSkillsOpen = useStore(state => state.cwdSkillsOpen);
  return {
    open: cwdSkillsOpen,
    skills: cwdSkills,
    toggle: () => useStore.getState().toggleCwdSkillsOpen(),
  };
}

export function DeskCwdSkillsButton() {
  const deskBasePath = useStore(state => state.deskBasePath);
  const { open, skills, toggle } = useCwdSkillsOpen();
  const loadedRef = useRef('');

  useEffect(() => {
    if (deskBasePath && deskBasePath !== loadedRef.current) {
      // 切换工作区：重置 ETag，全量加载
      _lastEtag = '';
      loadCwdSkills().then(() => {
        loadedRef.current = deskBasePath;
      });
    }
  }, [deskBasePath]);

  const handleClick = useCallback(() => {
    if (!open) loadCwdSkills(true); // 后台刷新，先显示缓存数据
    toggle();
  }, [open, toggle]);

  if (!deskBasePath) return null;

  const t = window.t ?? ((key: string) => key);
  const label = skills.length > 0
    ? `${t('desk.cwdSkills')} · ${skills.length}`
    : t('desk.cwdSkills');

  return (
    <button
      className={`${styles.cwdBtn} ${styles.headerCwdBtn}${open ? ` ${styles.active}` : ''}`}
      onClick={handleClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

/** Skeleton placeholder while skills are loading for the first time */
function SkillsSkeleton() {
  return (
    <div style={{ padding: '0.4rem 0' }}>
      {[1, 2, 3].map(i => (
        <div
          key={i}
          style={{
            height: '2rem',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--overlay-subtle)',
            marginBottom: '0.35rem',
            animation: 'cwdPanelIn 0.6s ease-in-out infinite alternate',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

export function DeskCwdSkillsPanel() {
  const { open, skills } = useCwdSkillsOpen();
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cmPos, setCmPos] = useState<{ x: number; y: number } | null>(null);
  const [cmSkill, setCmSkill] = useState<CwdSkillInfo | null>(null);
  const hasLoadedOnce = useRef(false);
  const t = window.t ?? ((key: string) => key);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
      // 首次打开且无缓存数据时显示 skeleton
      if (!hasLoadedOnce.current && skills.length === 0) {
        setLoading(true);
        loadCwdSkills().finally(() => {
          setLoading(false);
          hasLoadedOnce.current = true;
        });
      } else {
        hasLoadedOnce.current = true;
      }
    } else if (visible) {
      setClosing(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setClosing(false);
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [open, visible]);

  useEffect(() => {
    if (!cmPos) return;
    const close = () => {
      setCmPos(null);
      setCmSkill(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [cmPos]);

  const deleteSkill = useCallback(async (skill: CwdSkillInfo) => {
    if (!skill.baseDir) return;
    try {
      await hanaFetch('/api/desk/delete-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillDir: skill.baseDir }),
      });
      _lastEtag = ''; // 强制下次全量加载
      await loadCwdSkills();
      window.__loadDeskSkills?.();
    } catch (error) {
      console.error('[cwd-skills] delete failed:', error);
    }
  }, []);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const dir = useStore.getState().deskBasePath;
    if (!dir) return;

    let installed = false;
    for (const file of files) {
      const filePath = window.platform?.getFilePath?.(file);
      if (!filePath) continue;
      try {
        const response = await hanaFetch('/api/desk/install-skill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, dir }),
        });
        const data = await response.json();
        if (!data.error) installed = true;
      } catch (error) {
        console.error('[cwd-skills] install failed:', error);
      }
    }

    if (installed) {
      _lastEtag = ''; // 强制下次全量加载
      await loadCwdSkills();
      window.__loadDeskSkills?.();
    }
  }, []);

  if (!visible) return null;

  const grouped: Record<string, CwdSkillInfo[]> = {};
  for (const skill of skills) {
    (grouped[skill.source] ??= []).push(skill);
  }

  return (
    <div className={`${styles.cwdPanelWrap}${closing ? ` ${styles.closing}` : ''}`}>
      <div
        className={`${styles.cwdPanel}${dragging ? ` ${styles.dragOver}` : ''}`}
        data-desk-cwd-panel=""
        onMouseDown={event => event.stopPropagation()}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          setCmPos({ x: event.clientX, y: event.clientY });
        }}
        onDragOver={event => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className={styles.cwdDescLine}>
          <span className={styles.cwdDescDeco} />
          <span className={styles.cwdDescText}>{t('desk.cwdSkillsDesc')}</span>
          <span className={styles.cwdDescDeco} />
        </div>

        {loading ? (
          <SkillsSkeleton />
        ) : skills.length === 0 ? (
          <>
            <p className={styles.cwdEmpty}>{t('desk.cwdSkillsEmpty')}</p>
            <p className={styles.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        ) : (
          <>
            {Object.entries(grouped).map(([source, items]) => (
              <div key={source}>
                <div className={styles.cwdGroupLabel}>{source}</div>
                {items.map(skill => {
                  let description = skill.description || '';
                  if (description.length > 60) description = `${description.slice(0, 60)}...`;
                  return (
                    <div
                      className={styles.cwdSkillItem}
                      key={`${source}:${skill.name}:${skill.baseDir}`}
                      onDoubleClick={() => {
                        window.platform?.openSkillViewer?.({
                          name: skill.name,
                          baseDir: skill.baseDir,
                          filePath: skill.filePath,
                          installed: false,
                        });
                      }}
                      onContextMenu={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setCmPos({ x: event.clientX, y: event.clientY });
                        setCmSkill(skill);
                      }}
                    >
                      <span className={styles.cwdSkillName}>{skill.name}</span>
                      <div className={styles.cwdSkillMeta}>
                        {description && <span className={styles.cwdSkillDesc}>{description}</span>}
                        {skill.providerLabel && <span className={styles.cwdSkillProvider}>{skill.providerLabel}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <p className={styles.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        )}

        {cmPos && (
          <div className={styles.cwdCtxMenu} style={{ position: 'fixed', left: cmPos.x, top: cmPos.y, zIndex: 9999 }}>
            <button onClick={() => {
              const target = cmSkill?.baseDir || `${useStore.getState().deskBasePath}/.agents/skills`;
              window.platform?.showInFinder?.(target);
              setCmPos(null);
            }}>
              {t('desk.openInFinder')}
            </button>
            {cmSkill && (
              <button
                className={styles.cwdCtxDanger}
                onClick={() => {
                  deleteSkill(cmSkill);
                  setCmPos(null);
                }}
              >
                {t('desk.deleteSkill')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
