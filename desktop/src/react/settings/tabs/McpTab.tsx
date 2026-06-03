import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

import {
  BUILTIN_FALLBACKS,
  mergeBuiltinStates,
  BUILTIN_GROUP_META,
  humanizeBuiltinError,
  PRESETS,
  emptyDraft,
  draftFromServer,
  buildPayload,
  type McpServerState,
  type McpBuiltinState,
  type DraftState,
} from "./McpTab.helpers";

export function McpTab() {
  const platform = window.platform;
  const { showToast, ready, serverPort, serverToken } = useSettingsStore();
  const [servers, setServers] = useState<McpServerState[]>([]);
  const [builtinServers, setBuiltinServers] = useState<McpBuiltinState[]>(BUILTIN_FALLBACKS);
  const [builtinDrafts, setBuiltinDrafts] = useState<Record<string, Record<string, string>>>({});
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<'save' | 'test' | 'reload' | 'delete' | null>(null);
  const [testResult, setTestResult] = useState<string>('');
  const [builtinBusy, setBuiltinBusy] = useState<Record<string, 'save' | 'test' | null>>({});
  const [builtinTestResults, setBuiltinTestResults] = useState<Record<string, string>>({});
  const serverRetryCountRef = useRef(0);
  const builtinRetryCountRef = useRef(0);
  const serverRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const builtinRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedServer = useMemo(
    () => servers.find((server) => server.name === selectedName && server.source !== 'builtin') || null,
    [selectedName, servers],
  );

  const customServers = useMemo(
    () => servers.filter((server) => server.source !== 'builtin'),
    [servers],
  );

  const builtinSections = useMemo(() => {
    const grouped = new Map<string, McpBuiltinState[]>();
    for (const server of builtinServers) {
      const group = server.group || 'other';
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(server);
    }
    return BUILTIN_GROUP_META
      .map((meta) => ({
        ...meta,
        servers: grouped.get(meta.id) || [],
      }))
      .filter((section) => section.servers.length > 0);
  }, [builtinServers]);

  const loadServersRef = useRef<() => Promise<void>>(async () => {});
  const loadBuiltinServersRef = useRef<() => Promise<void>>(async () => {});

  const scheduleServerRetry = useCallback(() => {
    if (serverRetryTimerRef.current || serverRetryCountRef.current >= 4) return;
    serverRetryCountRef.current += 1;
    const delay = Math.min(1200 * serverRetryCountRef.current, 4000);
    serverRetryTimerRef.current = setTimeout(() => {
      serverRetryTimerRef.current = null;
      void loadServersRef.current();
    }, delay);
  }, []);

  const scheduleBuiltinRetry = useCallback(() => {
    if (builtinRetryTimerRef.current || builtinRetryCountRef.current >= 4) return;
    builtinRetryCountRef.current += 1;
    const delay = Math.min(1200 * builtinRetryCountRef.current, 4000);
    builtinRetryTimerRef.current = setTimeout(() => {
      builtinRetryTimerRef.current = null;
      void loadBuiltinServersRef.current();
    }, delay);
  }, []);

  const loadServers = useCallback(async () => {
    if (!ready || !serverPort || !serverToken) return;
    setLoading(true);
    try {
      const res = await hanaFetch('/api/mcp/servers');
      const data = await res.json();
      if (data?.ok === false && /MCP manager unavailable/i.test(String(data?.error || ''))) {
        scheduleServerRetry();
        return;
      }
      const nextServers = data.servers || [];
      serverRetryCountRef.current = 0;
      setServers(nextServers);
      setSelectedName((prev) => {
        if (prev && nextServers.some((server: McpServerState) => server.name === prev && server.source !== 'builtin')) return prev;
        return nextServers.find((server: McpServerState) => server.source !== 'builtin')?.name || null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/MCP manager unavailable/i.test(message)) {
        scheduleServerRetry();
        return;
      }
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [ready, scheduleServerRetry, serverPort, serverToken, showToast]);

  const loadBuiltinServers = useCallback(async () => {
    if (!ready || !serverPort || !serverToken) return;
    try {
      const res = await hanaFetch('/api/mcp/builtin');
      const data = await res.json();
      const nextBuiltin = mergeBuiltinStates(data.builtin || []);
      if (data?.ok === false && /MCP manager unavailable/i.test(String(data?.error || ''))) {
        scheduleBuiltinRetry();
        return;
      }
      const hasConfiguredBuiltin = nextBuiltin.some((server) => server.configured || server.connected || server.toolCount || server.resourceCount);
      if (!hasConfiguredBuiltin) {
        scheduleBuiltinRetry();
      } else {
        builtinRetryCountRef.current = 0;
      }
      setBuiltinServers(nextBuiltin);
      setBuiltinDrafts(
        Object.fromEntries(
          nextBuiltin.map((server: McpBuiltinState) => [
            server.name,
            Object.fromEntries(
              (server.credentialFields || []).map((field) => [field.key, field.value || '']),
            ),
          ]),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/MCP manager unavailable/i.test(message)) {
        scheduleBuiltinRetry();
        return;
      }
      showToast(message, 'error');
    }
  }, [ready, scheduleBuiltinRetry, serverPort, serverToken, showToast]);

  loadServersRef.current = loadServers;
  loadBuiltinServersRef.current = loadBuiltinServers;

  useEffect(() => {
    if (!ready || !serverPort || !serverToken) return;
    loadServers().catch(() => {});
    loadBuiltinServers().catch(() => {});
    return () => {
      if (serverRetryTimerRef.current) clearTimeout(serverRetryTimerRef.current);
      if (builtinRetryTimerRef.current) clearTimeout(builtinRetryTimerRef.current);
    };
  }, [loadBuiltinServers, loadServers, ready, serverPort, serverToken]);

  useEffect(() => {
    const handleFocus = () => {
      if (builtinServers.length === 0) void loadBuiltinServers();
      if (servers.length === 0) void loadServers();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [builtinServers.length, loadBuiltinServers, loadServers, servers.length]);

  useEffect(() => {
    setDraft(draftFromServer(selectedServer));
    setTestResult('');
  }, [selectedServer]);

  const saveServer = async () => {
    const name = draft.name.trim();
    if (!name) {
      showToast(t('settings.mcp.nameRequired') || '请输入 MCP 名称', 'error');
      return;
    }
    setBusyAction('save');
    try {
      const res = await hanaFetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: buildPayload(draft) }),
      });
      const data = await res.json();
      setSelectedName(data.server?.name || name);
      await loadServers();
      showToast(t('settings.saved') || '保存成功', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const testServer = async () => {
    setBusyAction('test');
    setTestResult('');
    try {
      const res = await hanaFetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.name || 'test', config: buildPayload(draft) }),
      });
      const data = await res.json();
      const summary = `${t('settings.mcp.testSuccess') || '连接成功'} · ${data.toolCount || 0} tools / ${data.resourceCount || 0} resources`;
      setTestResult(summary);
      showToast(summary, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResult(message);
      showToast(message, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const reloadServers = async () => {
    setBusyAction('reload');
    try {
      await hanaFetch('/api/mcp/reload', { method: 'POST' });
      await loadServers();
      await loadBuiltinServers();
      showToast(t('settings.mcp.reloaded') || '已重新加载 MCP', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const deleteServer = async () => {
    if (!selectedServer) return;
    setBusyAction('delete');
    try {
      await hanaFetch(`/api/mcp/servers/${encodeURIComponent(selectedServer.name)}`, { method: 'DELETE' });
      setSelectedName(null);
      await loadServers();
      showToast(t('settings.deleted', { name: selectedServer.name }) || '已删除', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const updateBuiltinField = (name: string, key: string, value: string) => {
    setBuiltinDrafts((prev) => ({
      ...prev,
      [name]: {
        ...(prev[name] || {}),
        [key]: value,
      },
    }));
  };

  const saveBuiltin = async (name: string, enabled?: boolean) => {
    setBuiltinBusy((prev) => ({ ...prev, [name]: 'save' }));
    try {
      await hanaFetch(`/api/mcp/builtin/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: builtinDrafts[name] || {},
          ...(enabled !== undefined ? { enabled } : {}),
        }),
      });
      await loadServers();
      await loadBuiltinServers();
      showToast(t('settings.saved') || '保存成功', 'success');
    } catch (err) {
      const message = humanizeBuiltinError(name, err instanceof Error ? err.message : String(err));
      showToast(message, 'error');
    } finally {
      setBuiltinBusy((prev) => ({ ...prev, [name]: null }));
    }
  };

  const testBuiltin = async (name: string) => {
    setBuiltinBusy((prev) => ({ ...prev, [name]: 'test' }));
    setBuiltinTestResults((prev) => ({ ...prev, [name]: '' }));
    try {
      const res = await hanaFetch(`/api/mcp/builtin/${encodeURIComponent(name)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: builtinDrafts[name] || {},
        }),
      });
      const data = await res.json();
      const summary = `${t('settings.mcp.testSuccess') || '连接成功'} · ${data.toolCount || 0} tools / ${data.resourceCount || 0} resources`;
      setBuiltinTestResults((prev) => ({ ...prev, [name]: summary }));
      showToast(summary, 'success');
    } catch (err) {
      const message = humanizeBuiltinError(name, err instanceof Error ? err.message : String(err));
      setBuiltinTestResults((prev) => ({ ...prev, [name]: message }));
      showToast(message, 'error');
    } finally {
      setBuiltinBusy((prev) => ({ ...prev, [name]: null }));
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="mcp">
      <section className={styles['settings-section']}>
        <div className={styles['settings-section-header']}>
          <h2 className={styles['settings-section-title']}>{t('settings.mcp.title') || 'MCP'}</h2>
          <button
            className={styles['settings-icon-btn']}
            onClick={() => reloadServers()}
            disabled={busyAction === 'reload'}
            title={t('settings.mcp.reload') || '重新加载'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15.55-6.36L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15.55 6.36L3 16" />
            </svg>
          </button>
        </div>
        <p className={styles['settings-hint']}>
          {t('settings.mcp.hint') || '管理本地 stdio 和远程 SSE MCP 服务，连上后工具会直接进入 Lynn。'}
        </p>

        {builtinServers.length > 0 && (
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.mcp.builtinTitle') || '内置增强服务'}</label>
            <div className={styles['mcp-builtin-intro']}>
              <div className={styles['mcp-builtin-intro-title']}>把高价值增强能力接进 Lynn</div>
              <div className={styles['mcp-builtin-intro-copy']}>
                腾讯文档适合直接提升日常协作；智谱和 MiniMax 这类增强更适合需要更强搜索、网页深读、截图理解或开源仓库检索时再开启。
              </div>
            </div>
            {builtinSections.map((section) => (
              <div key={section.id} className={styles['mcp-builtin-section']}>
                <div className={styles['mcp-builtin-section-header']}>
                  <div className={styles['mcp-builtin-section-title']}>{section.title}</div>
                  <div className={styles['mcp-builtin-section-copy']}>{section.copy}</div>
                </div>
                <div className={styles['mcp-builtin-grid']}>
                  {section.servers.map((server) => {
                    const fields = server.credentialFields || [];
                    const busy = builtinBusy[server.name];
                    const detailError = humanizeBuiltinError(server.name, builtinTestResults[server.name] || server.lastError || '');
                    const statusText = server.connected
                      ? (t('settings.providers.ready') || '已就绪')
                      : server.configured
                        ? (t('settings.providers.verifyFailed') || '验证失败')
                        : (t('settings.providers.noKey') || '未配置');
                    return (
                      <div key={server.name} className={styles['mcp-builtin-card']}>
                        <div className={styles['mcp-builtin-header']}>
                          <div>
                            <div className={styles['mcp-builtin-title']}>{server.label}</div>
                            <div className={styles['mcp-builtin-copy']}>{server.description || ''}</div>
                          </div>
                          <span
                            className={styles['mcp-builtin-badge']}
                            style={{
                              color: server.connected ? 'var(--mint)' : 'var(--text-muted)',
                              borderColor: server.connected ? 'color-mix(in srgb, var(--mint) 32%, transparent)' : 'var(--border)',
                            }}
                          >
                            {statusText}
                          </span>
                        </div>

                        {fields.map((field) => (
                          <div key={`${server.name}-${field.key}`} className={styles['settings-field']}>
                            <label className={styles['settings-field-label']}>{field.label}</label>
                            <input
                              className={styles['settings-input']}
                              type={field.secret === false ? 'text' : 'password'}
                              value={builtinDrafts[server.name]?.[field.key] || ''}
                              placeholder={field.placeholder || ''}
                              onChange={(e) => updateBuiltinField(server.name, field.key, e.target.value)}
                              onBlur={() => {
                                if ((builtinDrafts[server.name]?.[field.key] || '').trim()) {
                                  void saveBuiltin(server.name);
                                }
                              }}
                            />
                          </div>
                        ))}

                        {server.hint && (
                          <div className={styles['settings-hint']} style={{ textAlign: 'left', marginTop: 0 }}>
                            {server.hint}
                          </div>
                        )}

                        <div className={styles['mcp-builtin-actions']}>
                          <button
                            className={styles['provider-item-action']}
                            style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }}
                            onClick={() => saveBuiltin(server.name)}
                            disabled={busy === 'save'}
                          >
                            {busy === 'save' ? (t('review.loading') || 'Loading') : (t('settings.save') || '保存')}
                          </button>
                          <button
                            className={styles['provider-item-action']}
                            style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }}
                            onClick={() => testBuiltin(server.name)}
                            disabled={busy === 'test'}
                          >
                            {busy === 'test' ? (t('review.loading') || 'Loading') : (t('settings.mcp.test') || '测试连接')}
                          </button>
                          <button
                            className={styles['provider-item-action']}
                            style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }}
                            onClick={() => saveBuiltin(server.name, !server.enabled)}
                          >
                            {server.enabled ? (t('settings.mcp.disableBuiltin') || '停用') : (t('settings.mcp.enableBuiltin') || '启用')}
                          </button>
                          {server.docsUrl && (
                            <button
                              className={styles['provider-item-action']}
                              style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }}
                              onClick={() => platform?.openExternal?.(server.docsUrl || '')}
                            >
                              {t('settings.mcp.openDocs') || '打开文档'}
                            </button>
                          )}
                        </div>

                        {detailError && (
                          <div className={styles['settings-hint']} style={{ textAlign: 'left', marginTop: '8px' }}>
                            {detailError}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.mcp.presets') || '预设模板'}</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={styles['provider-item-action']}
                style={{ width: 'auto', height: '30px', padding: '0 10px', opacity: 1 }}
                onClick={() => {
                  setSelectedName(null);
                  setDraft(preset.build());
                  setTestResult('');
                }}
              >
                {preset.label}
              </button>
            ))}
            <button
              className={styles['provider-item-action']}
              style={{ width: 'auto', height: '30px', padding: '0 10px', opacity: 1 }}
              onClick={() => {
                setSelectedName(null);
                setDraft(emptyDraft());
                setTestResult('');
              }}
            >
              {t('settings.mcp.newServer') || '新建'}
            </button>
          </div>
        </div>
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.mcp.serverList') || '服务器列表'}</h2>
        <div className={styles['provider-list']}>
          {loading && (
            <div className={styles['provider-empty']}>{t('review.loading') || 'Loading'}</div>
          )}
          {!loading && customServers.length === 0 && (
            <div className={styles['provider-empty']}>{t('settings.mcp.empty') || '还没有 MCP 服务器'}</div>
          )}
          {!loading && customServers.map((server) => (
            <button
              key={server.name}
              type="button"
              className={styles['provider-item']}
              onClick={() => setSelectedName(server.name)}
              style={{
                width: '100%',
                textAlign: 'left',
                background: selectedName === server.name ? 'var(--accent-light)' : undefined,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '999px',
                  background: server.connected ? 'var(--mint)' : 'var(--text-muted)',
                  flexShrink: 0,
                }}
              />
              <span className={styles['provider-item-name']}>{server.name}</span>
              <span className={styles['provider-item-count']}>
                {(server.transport || 'stdio').toUpperCase()} · {server.toolCount || 0} tools
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.mcp.detail') || '服务详情'}</h2>

        <div className={styles['settings-row-2col']}>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.mcp.name') || '名称'}</label>
            <input
              className={styles['settings-input']}
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="filesystem"
            />
          </div>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.mcp.transport') || '传输'}</label>
            <select
              className={styles['settings-input']}
              value={draft.transport}
              onChange={(e) => setDraft((prev) => ({ ...prev, transport: e.target.value as 'stdio' | 'sse' }))}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
            </select>
          </div>
        </div>

        {draft.transport === 'stdio' ? (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.command') || '命令'}</label>
              <input
                className={styles['settings-input']}
                value={draft.command}
                onChange={(e) => setDraft((prev) => ({ ...prev, command: e.target.value }))}
                placeholder="npx"
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.args') || '参数'}</label>
              <textarea
                className={styles['settings-textarea']}
                rows={4}
                value={draft.argsText}
                onChange={(e) => setDraft((prev) => ({ ...prev, argsText: e.target.value }))}
                placeholder="@modelcontextprotocol/server-filesystem&#10;/Users/lynn"
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.cwd') || '工作目录'}</label>
              <input
                className={styles['settings-input']}
                value={draft.cwd}
                onChange={(e) => setDraft((prev) => ({ ...prev, cwd: e.target.value }))}
                placeholder="/Users/lynn"
              />
            </div>
          </>
        ) : (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.url') || 'SSE URL'}</label>
              <input
                className={styles['settings-input']}
                value={draft.url}
                onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://mcp.example.com/sse"
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.messageUrl') || '消息 URL（可选）'}</label>
              <input
                className={styles['settings-input']}
                value={draft.messageUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, messageUrl: e.target.value }))}
                placeholder="https://mcp.example.com/messages"
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>{t('settings.mcp.headers') || '请求头'}</label>
              <textarea
                className={styles['settings-textarea']}
                rows={6}
                value={draft.headersText}
                onChange={(e) => setDraft((prev) => ({ ...prev, headersText: e.target.value }))}
                placeholder={'{\n  "Authorization": "Bearer xxx"\n}'}
              />
            </div>
          </>
        )}

        <div className={styles['settings-field']}>
          <label className={styles['settings-toggle-row']}>
            <input
              type="checkbox"
              checked={!draft.disabled}
              onChange={(e) => setDraft((prev) => ({ ...prev, disabled: !e.target.checked }))}
            />
            <span>{t('settings.mcp.enabled') || '启用此服务器'}</span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <button className={styles['provider-item-action']} style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }} onClick={() => saveServer()} disabled={busyAction === 'save'}>
            {busyAction === 'save' ? (t('review.loading') || 'Loading') : (t('settings.save') || '保存')}
          </button>
          <button className={styles['provider-item-action']} style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: 1 }} onClick={() => testServer()} disabled={busyAction === 'test'}>
            {busyAction === 'test' ? (t('review.loading') || 'Loading') : (t('settings.mcp.test') || '测试连接')}
          </button>
          <button
            className={`${styles['provider-item-action']} ${styles.delete || ''}`}
            style={{ width: 'auto', height: '32px', padding: '0 12px', opacity: selectedServer?.source === 'local' ? 1 : 0.5 }}
            onClick={() => deleteServer()}
            disabled={busyAction === 'delete' || selectedServer?.source !== 'local'}
          >
            {t('settings.providers.delete') || '删除'}
          </button>
        </div>

        {testResult && (
          <div className={styles['settings-hint']} style={{ textAlign: 'left' }}>
            {testResult}
          </div>
        )}

        {selectedServer && (
          <>
            <div className={styles['settings-hint']} style={{ textAlign: 'left' }}>
              {(t('settings.mcp.source') || '来源')}: {selectedServer.source === 'local' ? (t('settings.mcp.local') || '本地配置') : (selectedServer.sourcePath || t('settings.mcp.discovered') || '自动发现')}
              {selectedServer.lastError ? ` · ${selectedServer.lastError}` : ''}
            </div>
            {(selectedServer.tools?.length || 0) > 0 && (
              <div className={styles['settings-field']}>
                <label className={styles['settings-field-label']}>{t('settings.mcp.tools') || '工具'}</label>
                <div className={styles['provider-list']}>
                  {selectedServer.tools?.map((tool) => (
                    <div key={tool.name} className={styles['provider-item']}>
                      <span className={styles['provider-item-name']}>{tool.name}</span>
                      <span className={styles['provider-item-count']}>{tool.description || ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(selectedServer.resources?.length || 0) > 0 && (
              <div className={styles['settings-field']}>
                <label className={styles['settings-field-label']}>{t('settings.mcp.resources') || '资源'}</label>
                <div className={styles['provider-list']}>
                  {selectedServer.resources?.map((resource) => (
                    <div key={`${resource.name}-${resource.uri || ''}`} className={styles['provider-item']}>
                      <span className={styles['provider-item-name']}>{resource.name}</span>
                      <span className={styles['provider-item-count']}>{resource.uri || ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
