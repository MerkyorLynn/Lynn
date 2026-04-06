import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import { resolveBundledAvatar } from '../../utils/agent-helpers';
import {
  buildUserVisibleModelOptions,
  decodeUserVisibleModelValue,
  encodeUserVisibleModelValue,
  normalizeDisplayModelId,
  normalizeDisplayProviderLabel,
} from '../../utils/brain-models';
import styles from '../Settings.module.css';

const platform = window.platform;

type ReviewerKind = 'hanako' | 'butter';

interface ReviewCandidate {
  id: string;
  name: string;
  displayName: string;
  yuan: ReviewerKind;
  hasAvatar?: boolean;
  isCurrent?: boolean;
  modelId?: string | null;
  modelProvider?: string | null;
}

interface ReviewConfigResponse {
  defaultReviewer: ReviewerKind;
  hanakoReviewerId?: string | null;
  butterReviewerId?: string | null;
  candidates: {
    hanako: ReviewCandidate[];
    butter: ReviewCandidate[];
  };
  resolvedReviewer?: ReviewCandidate | null;
}

const LOCAL_DEFAULT_WORKSPACE = '/Users/lynn/Desktop/Lynn';
const LOCAL_DEFAULT_TRUSTED_ROOTS = [LOCAL_DEFAULT_WORKSPACE, '/Users/lynn/Desktop'];

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const trimmed = String(root || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeReviewerKind(kind?: string | null): ReviewerKind {
  return kind === 'butter' ? 'butter' : 'hanako';
}

function reviewerLabel(kind: ReviewerKind): string {
  return kind === 'butter' ? 'Butter' : 'Hanako';
}

function reviewerAvatar(kind: ReviewerKind): string {
  return resolveBundledAvatar(kind === 'butter' ? 'Butter.png' : 'Hanako.png');
}

function toModelRef(raw: unknown): { id: string; provider?: string } | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.trim() ? { id: raw.trim() } : null;
  if (typeof raw === 'object' && raw !== null) {
    const id = typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id.trim()
      : '';
    if (!id) return null;
    const provider = typeof (raw as { provider?: unknown }).provider === 'string'
      ? (raw as { provider: string }).provider.trim()
      : '';
    return provider ? { id, provider } : { id };
  }
  return null;
}

export function WorkTab() {
  const { settingsConfig, showToast, activeTab, pendingReviewerKind, homeFolder: runtimeHomeFolder, trustedRoots: runtimeTrustedRoots } = useSettingsStore();
  const [homeFolder, setHomeFolder] = useState('');
  const [trustedRoots, setTrustedRoots] = useState<string[]>([]);
  const [defaultWorkspace, setDefaultWorkspace] = useState<{ workspacePath: string; trustedRoots: string[] } | null>(null);
  const [hbEnabled, setHbEnabled] = useState(true);
  const [hbInterval, setHbInterval] = useState(17);
  const [cronAutoApprove, setCronAutoApprove] = useState(true);
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const effectiveHomeFolder = homeFolder || defaultWorkspace?.workspacePath || LOCAL_DEFAULT_WORKSPACE;
  const effectiveTrustedRoots = trustedRoots.length > 0
    ? trustedRoots
    : ((defaultWorkspace?.trustedRoots && defaultWorkspace.trustedRoots.length > 0)
      ? defaultWorkspace.trustedRoots
      : LOCAL_DEFAULT_TRUSTED_ROOTS);

  const loadReviewConfig = useCallback(async () => {
    setReviewLoading(true);
    try {
      const res = await hanaFetch('/api/review/config');
      const data = await res.json();
      setReviewConfig(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    } finally {
      setReviewLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const defaults = await platform?.getOnboardingDefaults?.();
        if (cancelled || !defaults?.workspacePath) return;
        setDefaultWorkspace({
          workspacePath: defaults.workspacePath,
          trustedRoots: Array.isArray(defaults.trustedRoots) ? uniqueRoots(defaults.trustedRoots) : [],
        });
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (settingsConfig) {
      const cfgHome = settingsConfig.desk?.home_folder || runtimeHomeFolder || defaultWorkspace?.workspacePath || '';
      const cfgRoots = Array.isArray(settingsConfig.desk?.trusted_roots)
        ? settingsConfig.desk.trusted_roots
        : (Array.isArray(runtimeTrustedRoots) && runtimeTrustedRoots.length > 0
          ? runtimeTrustedRoots
          : (defaultWorkspace?.trustedRoots || []));

      setHomeFolder(cfgHome);
      const roots = uniqueRoots(cfgRoots);
      setTrustedRoots(roots);
      setHbEnabled(settingsConfig.desk?.heartbeat_enabled !== false);
      setHbInterval(settingsConfig.desk?.heartbeat_interval ?? 17);
      setCronAutoApprove(settingsConfig.desk?.cron_auto_approve !== false);
    }
  }, [settingsConfig, runtimeHomeFolder, runtimeTrustedRoots, defaultWorkspace]);

  useEffect(() => {
    if (!defaultWorkspace?.workspacePath) return;
    if (!settingsConfig) return;
    const hasConfiguredHome = Boolean(settingsConfig.desk?.home_folder || runtimeHomeFolder);
    const hasConfiguredRoots = Array.isArray(settingsConfig.desk?.trusted_roots) && settingsConfig.desk.trusted_roots.length > 0
      ? true
      : Array.isArray(runtimeTrustedRoots) && runtimeTrustedRoots.length > 0;
    if (hasConfiguredHome && hasConfiguredRoots) return;
    void hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        desk: {
          home_folder: hasConfiguredHome ? (settingsConfig.desk?.home_folder || runtimeHomeFolder || '') : defaultWorkspace.workspacePath,
          trusted_roots: hasConfiguredRoots
            ? (Array.isArray(settingsConfig.desk?.trusted_roots) && settingsConfig.desk.trusted_roots.length > 0
              ? settingsConfig.desk.trusted_roots
              : runtimeTrustedRoots)
            : defaultWorkspace.trustedRoots,
        },
      }),
    });
  }, [defaultWorkspace, settingsConfig, runtimeHomeFolder, runtimeTrustedRoots]);

  useEffect(() => {
    loadReviewConfig().catch(() => {});
  }, [loadReviewConfig]);

  useEffect(() => {
    hanaFetch('/api/models')
      .then((r) => r.json())
      .then((data) => setAvailableModels(data.models || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleReviewConfigChanged = () => {
      void loadReviewConfig();
    };
    window.addEventListener('review-config-changed', handleReviewConfigChanged);
    return () => window.removeEventListener('review-config-changed', handleReviewConfigChanged);
  }, [loadReviewConfig]);

  useEffect(() => {
    if (activeTab !== 'work' || !pendingReviewerKind) return;
    const el = document.querySelector(`[data-reviewer-section="${pendingReviewerKind}"]`);
    if (!(el instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus?.();
      useSettingsStore.setState({ pendingReviewerKind: null });
    });
  }, [activeTab, pendingReviewerKind]);

  const saveTrustedRoots = async (roots: string[]) => {
    const nextRoots = uniqueRoots(roots);
    setTrustedRoots(nextRoots);
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { trusted_roots: nextRoots } }),
    });
    useSettingsStore.setState({ trustedRoots: nextRoots });
  };

  const pickHomeFolder = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setHomeFolder(folder);
    useSettingsStore.setState({ homeFolder: folder });
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { home_folder: folder } }),
    });

    if (!trustedRoots.includes(folder)) {
      await saveTrustedRoots([...trustedRoots, folder]);
    }
  };

  const clearHomeFolder = async () => {
    const fallback = defaultWorkspace?.workspacePath || LOCAL_DEFAULT_WORKSPACE;
    setHomeFolder(fallback);
    useSettingsStore.setState({ homeFolder: fallback || null });
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { home_folder: fallback } }),
    });
  };

  const addTrustedRoot = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    await saveTrustedRoots([...trustedRoots, folder]);
  };

  const removeTrustedRoot = async (root: string) => {
    await saveTrustedRoots(effectiveTrustedRoots.filter((item) => item !== root));
  };

  const toggleHeartbeat = async (on: boolean) => {
    setHbEnabled(on);
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { heartbeat_enabled: on } }),
    });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    setCronAutoApprove(on);
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { cron_auto_approve: on } }),
    });
  };

  const saveWork = async () => {
    const interval = Math.max(1, Math.min(120, hbInterval));
    await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desk: { heartbeat_interval: interval } }),
    });
  };

  const updateReviewConfig = async (patch: Partial<ReviewConfigResponse>) => {
    setReviewSaving(true);
    try {
      const res = await hanaFetch('/api/review/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      setReviewConfig(data);
      window.platform?.notifyMainWindow?.('review-config-changed', {
        defaultReviewer: data?.defaultReviewer ?? null,
      });
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    } finally {
      setReviewSaving(false);
    }
  };

  const reviewerModelOptions = useMemo(() => {
    return buildUserVisibleModelOptions(availableModels).map((option) => ({
      value: option.value,
      label: option.label,
      group: option.rawProvider && option.rawProvider !== 'brain'
        ? (normalizeDisplayProviderLabel(option.rawProvider) || option.rawProvider)
        : '',
    }));
  }, [availableModels]);

  const updateReviewerModel = async (reviewerId: string, modelValue: string) => {
    const parsed = decodeUserVisibleModelValue(modelValue);
    if (!reviewerId || !parsed.id) return;
    const match = availableModels.find((model) => (
      model.id === normalizeDisplayModelId(parsed.id, parsed.provider || '')
      && (!parsed.provider || model.provider === parsed.provider)
    )) || availableModels.find((model) => model.id === normalizeDisplayModelId(parsed.id, parsed.provider || ''));
    const provider = parsed.provider || match?.provider || '';
    const normalizedId = normalizeDisplayModelId(parsed.id, provider);

    setReviewSaving(true);
    try {
      await hanaFetch(`/api/agents/${reviewerId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api: provider ? { provider } : undefined,
          models: {
            chat: provider ? { id: normalizedId, provider } : normalizedId,
          },
        }),
      });
      await loadReviewConfig();
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    } finally {
      setReviewSaving(false);
    }
  };

  const createReviewer = async (kind: ReviewerKind) => {
    try {
      const name = kind === 'butter' ? 'Butter Reviewer' : 'Hanako Reviewer';
      const res = await hanaFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, yuan: kind }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const inheritedModel = toModelRef(settingsConfig?.models?.chat);
      const inheritedProvider = inheritedModel?.provider
        || (typeof settingsConfig?.api?.provider === 'string' ? settingsConfig.api.provider : '');
      if (data.id && inheritedModel?.id) {
        await hanaFetch(`/api/agents/${data.id}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: { yuan: kind, tier: 'reviewer' },
            api: inheritedProvider ? { provider: inheritedProvider } : undefined,
            models: {
              chat: inheritedProvider ? { id: inheritedModel.id, provider: inheritedProvider } : inheritedModel.id,
            },
          }),
        });
      }
      showToast(t('settings.work.review.createSuccess', { name: data.name || name }), 'success');
      await loadReviewConfig();
      await updateReviewConfig(kind === 'butter'
        ? { butterReviewerId: data.id }
        : { hanakoReviewerId: data.id });
      window.platform?.openSettings?.({ tab: 'agent', agentId: data.id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    }
  };

  const openReviewerAgent = (agentId?: string | null) => {
    if (!agentId) return;
    window.platform?.openSettings?.({ tab: 'agent', agentId });
  };

  const renderReviewerSection = (kind: ReviewerKind) => {
    const config = reviewConfig;
    const candidates = config?.candidates?.[kind] || [];
    const selectedId = kind === 'butter' ? config?.butterReviewerId : config?.hanakoReviewerId;
    const autoCandidate = candidates.find((item) => !item.isCurrent) || null;
    const resolved = selectedId
      ? candidates.find((item) => item.id === selectedId) || null
      : autoCandidate;
    const options = [
      { value: '', label: t('review.auto') || 'Auto select' },
      ...candidates.map((item) => ({ value: item.id, label: item.name, group: item.modelProvider || undefined })),
    ];
    const reviewerModelValue = resolved?.modelId
      ? encodeUserVisibleModelValue({
        id: normalizeDisplayModelId(resolved.modelId, resolved.modelProvider || undefined),
        provider: resolved.modelProvider || undefined,
      })
      : '';

    return (
      <div className={styles['work-reviewer-card']} data-reviewer-section={kind} tabIndex={-1}>
        <div className={styles['work-review-persona']}>
          <img className={styles['work-review-avatar']} src={reviewerAvatar(kind)} alt={reviewerLabel(kind)} draggable={false} />
          <div className={styles['work-review-persona-copy']}>
            <span className={styles['tool-caps-name']}>{t(`settings.work.review.${kind}Title`)}</span>
            <span className={styles['tool-caps-desc']}>{t(`settings.work.review.${kind}Desc`)}</span>
          </div>
        </div>
        {resolved ? (
          <span className={styles['tool-caps-desc']}>
            {t('settings.work.review.boundModel', {
              provider: resolved.modelProvider || 'default',
              model: resolved.modelId || 'default',
            })}
          </span>
        ) : (
          <span className={styles['work-review-unbound']}>{t('settings.work.review.unboundHint')}</span>
        )}
        <div className={styles['work-review-actions']}>
          <SelectWidget
            options={options}
            value={selectedId || ''}
            onChange={(value) => {
              void updateReviewConfig(kind === 'butter'
                ? { butterReviewerId: value || null }
                : { hanakoReviewerId: value || null });
            }}
            placeholder={t('settings.work.review.chooseReviewer')}
            disabled={reviewSaving || reviewLoading}
          />
          <button
            className={styles['work-review-link']}
            onClick={() => {
              if (resolved?.id) openReviewerAgent(resolved.id);
              else void createReviewer(kind);
            }}
          >
            {resolved?.id ? t('settings.work.review.configureModel') : t('settings.work.review.createReviewer')}
          </button>
        </div>
        <div className={styles['work-review-actions']}>
          <SelectWidget
            options={reviewerModelOptions}
            value={reviewerModelValue}
            onChange={(value) => {
              if (!resolved?.id) return;
              void updateReviewerModel(resolved.id, value);
            }}
            placeholder={t('settings.api.selectModel')}
            disabled={reviewSaving || reviewLoading || !resolved?.id || reviewerModelOptions.length === 0}
          />
        </div>
      </div>
    );
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="work">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.homeFolder')}</h2>
        <p className={`${styles['settings-desc']} ${styles['settings-desc-compact']}`}>
          {t('settings.work.homeFolderDesc')}
        </p>
        <div className={styles['settings-folder-picker']}>
          <input
            type="text"
            className={`${styles['settings-input']} ${styles['settings-folder-input']}`}
            readOnly
            value={effectiveHomeFolder}
            placeholder={t('settings.work.homeFolderPlaceholder')}
            onClick={pickHomeFolder}
          />
          <button className={styles['settings-folder-browse']} onClick={pickHomeFolder}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {effectiveHomeFolder && (
            <button
              className={styles['settings-folder-clear']}
              onClick={clearHomeFolder}
              title={t('settings.work.homeFolderClear')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.trustedRoots')}</h2>
        <p className={`${styles['settings-desc']} ${styles['settings-desc-compact']}`}>
          {t('settings.work.trustedRootsDesc')}
        </p>

        {effectiveTrustedRoots.length === 0 && (
          <p className={styles['settings-desc']}>
            {t('settings.work.trustedRootsHint')}
          </p>
        )}

        <div className={styles['tool-caps-group']}>
          {effectiveTrustedRoots.map((root) => (
            <div key={root} className={styles['tool-caps-item']}>
              <div className={styles['tool-caps-label']}>
                <span className={styles['tool-caps-name']} title={root}>{root}</span>
              </div>
              <button
                className={styles['settings-folder-clear']}
                onClick={() => removeTrustedRoot(root)}
                title={t('common.delete') || 'Delete'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.addTrustedRoot')}</span>
            </div>
            <button className={styles['settings-folder-browse']} onClick={addTrustedRoot}>
              +
            </button>
          </div>
        </div>
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.review.title')}</h2>
        <p className={`${styles['settings-desc']} ${styles['settings-desc-compact']}`}>
          {t('settings.work.review.desc')}
        </p>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.review.defaultReviewer')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.work.review.defaultReviewerDesc')}</span>
            </div>
            <SelectWidget
              options={[
                { value: 'hanako', label: 'Hanako' },
                { value: 'butter', label: 'Butter' },
              ]}
              value={normalizeReviewerKind(reviewConfig?.defaultReviewer)}
              onChange={(value) => { void updateReviewConfig({ defaultReviewer: normalizeReviewerKind(value) }); }}
              disabled={reviewLoading || reviewSaving}
            />
          </div>
          {renderReviewerSection('hanako')}
          {renderReviewerSection('butter')}
        </div>
        <p className={styles['settings-desc']}>
          {t('settings.work.review.modelHint')}
        </p>
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.title')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.heartbeatEnabled')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.work.heartbeatDesc')}</span>
            </div>
            <Toggle
              on={hbEnabled}
              onChange={toggleHeartbeat}
            />
          </div>
          <div className={`${styles['tool-caps-item']}${hbEnabled ? '' : ' settings-disabled'}`}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.heartbeatInterval')}</span>
            </div>
            <div className={styles['settings-input-group']}>
              <input
                type="number"
                className={`${styles['settings-input']} ${styles['small']}`}
                min={1}
                max={120}
                value={hbInterval}
                disabled={!hbEnabled}
                onChange={(e) => setHbInterval(parseInt(e.target.value) || 15)}
                onBlur={() => { void saveWork(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <span className={styles['settings-input-unit']}>{t('settings.work.heartbeatUnit')}</span>
            </div>
          </div>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.cronAutoApprove')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.work.cronAutoApproveDesc')}</span>
            </div>
            <Toggle
              on={cronAutoApprove}
              onChange={toggleCronAutoApprove}
            />
          </div>
        </div>
      </section>

    </div>
  );
}
