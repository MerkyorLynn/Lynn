/**
 * TaskModePicker — 任务模式选择器
 *
 * 输入框左下角的芯片按钮，点击展开下拉面板。
 * 用户在面板里选模式（自动/小说/社媒/代码/...）+ 看 slash 命令 + 激活 MCP 服务器。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { ensureSession } from '../../stores/session-actions';
import {
  TASK_MODES,
  CATEGORY_LABELS,
  getModesByCategory,
  getModeById,
  type TaskMode,
  type TaskModeCategory,
} from '../../config/task-modes';
import styles from './TaskModePicker.module.css';

interface McpServerState {
  name: string;
  label?: string;
  toolCount?: number;
  connected?: boolean;
}

export const TaskModePicker = memo(function TaskModePicker() {
  const taskModeId = useStore(s => s.taskModeId);
  const open = useStore(s => s.taskModePickerOpen);
  const setTaskModeId = useStore(s => s.setTaskModeId);
  const setOpen = useStore(s => s.setTaskModePickerOpen);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const setComposerText = useStore(s => s.setComposerText);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const addToast = useStore(s => s.addToast);
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');

  const [mcpServers, setMcpServers] = useState<McpServerState[]>([]);
  const [activeMcp, setActiveMcp] = useState<string[]>([]);
  const [loadingMcp, setLoadingMcp] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  const currentMode = getModeById(taskModeId) || TASK_MODES[0];

  // 分组
  const grouped = useMemo(() => ({
    auto: getModesByCategory('auto'),
    writing: getModesByCategory('writing'),
    work: getModesByCategory('work'),
    study: getModesByCategory('study'),
  }), []);

  // 打开面板时拉 MCP 状态
  useEffect(() => {
    if (!open) return;
    setLoadingMcp(true);
    Promise.all([
      hanaFetch('/api/mcp/servers').then(r => r.json()).catch(() => ({ servers: [] })),
      currentSessionPath
        ? hanaFetch(`/api/mcp/session-active?sessionPath=${encodeURIComponent(currentSessionPath)}`).then(r => r.json()).catch(() => ({ active: [] }))
        : Promise.resolve({ active: [] }),
    ]).then(([serversRes, activeRes]) => {
      const servers = (serversRes?.servers || []).filter((s: McpServerState) => s.connected);
      setMcpServers(servers);
      setActiveMcp(activeRes?.active || []);
    }).finally(() => setLoadingMcp(false));
  }, [open, currentSessionPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const togglePanel = useCallback(() => setOpen(!open), [open, setOpen]);
  const closePanel = useCallback(() => setOpen(false), [setOpen]);

  const handleSelectMode = useCallback((id: string) => {
    setTaskModeId(id);
  }, [setTaskModeId]);

  const handleSlashClick = useCallback((cmd: string) => {
    setComposerText(cmd + ' ');
    setOpen(false);
    requestInputFocus();
  }, [setComposerText, setOpen, requestInputFocus]);

  const handleToggleMcp = useCallback(async (serverName: string) => {
    // 如果还没建立 session（新会话空白态），先 ensureSession 拿到 sessionPath
    let sessionPath = currentSessionPath;
    if (!sessionPath) {
      const ok = await ensureSession();
      if (!ok) {
        addToast(isZh ? '请先选择工作目录' : 'Select a workspace first', 'error', 3000);
        return;
      }
      sessionPath = useStore.getState().currentSessionPath;
    }
    if (!sessionPath) return;

    const isActive = activeMcp.includes(serverName);
    const endpoint = isActive ? '/api/mcp/session-deactivate' : '/api/mcp/session-activate';
    try {
      const res = await hanaFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath, serverName }),
      });
      const data = await res.json();
      if (Array.isArray(data?.active)) {
        setActiveMcp(data.active);
      } else if (data?.error) {
        addToast(isZh ? `MCP 切换失败：${data.error}` : `MCP toggle failed: ${data.error}`, 'error', 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(isZh ? `MCP 切换失败：${msg}` : `MCP toggle failed: ${msg}`, 'error', 3000);
    }
  }, [currentSessionPath, activeMcp, addToast, isZh]);

  const renderGroup = (category: TaskModeCategory, modes: TaskMode[]) => {
    if (modes.length === 0) return null;
    const label = CATEGORY_LABELS[category];
    return (
      <div key={category} className={styles.group}>
        {label && <div className={styles['group-label']}>{label}</div>}
        {modes.map(mode => (
          <div
            key={mode.id}
            className={`${styles.item}${mode.id === taskModeId ? ` ${styles['item-active']}` : ''}`}
            onClick={() => handleSelectMode(mode.id)}
          >
            <span className={styles['item-emoji']}>{mode.emoji}</span>
            <div className={styles['item-text']}>
              <span className={styles['item-name']}>{mode.name}</span>
              <span className={styles['item-subtitle']}>{mode.subtitle}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={styles['picker-wrap']}>
      <button
        type="button"
        className={`${styles.chip}${taskModeId !== 'auto' ? ` ${styles['chip-active']}` : ''}`}
        onClick={togglePanel}
        title={isZh ? '任务模式' : 'Task mode'}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={styles['chip-emoji']}>{currentMode.emoji}</span>
        <span>{currentMode.name}</span>
        <span className={styles['chip-arrow']}>▾</span>
      </button>

      {open && (
        <>
          <div className={styles['panel-overlay']} onClick={closePanel} />
          <div ref={panelRef} className={styles.panel}>
            <div className={styles['panel-title']}>
              <div className={styles['panel-avatar']}>{currentMode.emoji}</div>
            </div>

            {renderGroup('auto', grouped.auto)}
            {renderGroup('writing', grouped.writing)}
            {renderGroup('work', grouped.work)}
            {renderGroup('study', grouped.study)}

            {/* 当前模式详情 */}
            {taskModeId !== 'auto' && (
              <div className={styles['mode-detail']}>
                <div className={styles['mode-detail-title']}>
                  {currentMode.emoji} {currentMode.name} · {currentMode.subtitle}
                </div>
                {currentMode.persona && (
                  <div className={styles['mode-detail-subtitle']}>
                    {isZh ? '已启用专属人设，发送消息时自动注入' : 'Persona active, auto-injected'}
                  </div>
                )}
              </div>
            )}

            {/* Slash 命令（如果当前模式有） */}
            {currentMode.slashCommands && currentMode.slashCommands.length > 0 && (
              <>
                <div className={styles['slash-title']}>{isZh ? 'Slash 命令' : 'Slash Commands'}</div>
                <div className={styles['slash-chips']}>
                  {currentMode.slashCommands.map(sc => (
                    <button
                      key={sc.cmd}
                      type="button"
                      className={styles['slash-chip']}
                      onClick={() => handleSlashClick(sc.cmd)}
                      title={sc.label}
                    >
                      {sc.cmd}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* MCP 激活面板 */}
            <div className={styles['mcp-section']}>
              <div className={styles['mcp-title']}>
                <span>🔌 {isZh ? 'MCP 服务器' : 'MCP Servers'}</span>
                <span className={styles['mcp-count']}>
                  {activeMcp.length > 0 ? `${activeMcp.length}/${mcpServers.length} ${isZh ? '已激活' : 'active'}` : `${mcpServers.length} ${isZh ? '可用' : 'available'}`}
                </span>
              </div>
              {loadingMcp ? (
                <div className={styles['mcp-empty']}>{isZh ? '加载中…' : 'Loading…'}</div>
              ) : mcpServers.length === 0 ? (
                <div className={styles['mcp-empty']}>
                  {isZh ? '未连接任何 MCP 服务器' : 'No MCP servers connected'}
                </div>
              ) : (
                mcpServers.map(srv => {
                  const on = activeMcp.includes(srv.name);
                  return (
                    <div key={srv.name} className={styles['mcp-server-row']}>
                      <span className={styles['mcp-server-name']}>{srv.label || srv.name}</span>
                      <span className={styles['mcp-server-tools']}>{srv.toolCount || 0} {isZh ? '工具' : 'tools'}</span>
                      <span
                        className={styles.toggle}
                        onClick={() => handleToggleMcp(srv.name)}
                        role="switch"
                        aria-checked={on}
                        tabIndex={0}
                      >
                        <span className={`${styles['toggle-bg']}${on ? ` ${styles['toggle-bg-on']}` : ''}`}>
                          <span className={styles['toggle-knob']} />
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
