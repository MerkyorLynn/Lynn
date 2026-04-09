import React, { useState, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { useStore } from '../../stores';
import { hanaFetch, hanaUrl, yuanFallbackAvatar as settingsYuanFallbackAvatar } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { browseAgent, loadSettingsConfig, loadAgents } from '../actions';
import { YuanSelector } from './agent/YuanSelector';
import { MemorySection } from './agent/AgentMemory';
import {
  buildUserVisibleModelOptions,
  decodeUserVisibleModelValue,
  encodeUserVisibleModelValue,
  normalizeDisplayModelId,
  normalizeDisplayModelName,
  normalizeDisplayProviderLabel,
} from '../../utils/brain-models';
import { getDisplayYuanEntries, normalizeYuanKey } from '../../utils/agent-helpers';
import { resolveRoleDefaultModel } from '../../../../../shared/assistant-role-models.js';
import styles from '../Settings.module.css';
import {
  type ExpCategory, parseExperience,
  ExperienceBlock, putExperience,
} from './agent/AgentExperience';

const platform = window.platform;

function isBundledLynnAvatarSrc(src: string | null | undefined): boolean {
  const value = String(src || '');
  return value.includes('assets/Lynn-512-opt.png') || value.includes('assets/Lynn.png');
}

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsConfig, settingsConfigAgentId, currentPins,
    showToast,
    globalModelsConfig,
  } = store;

  const settingsAgentId = store.getSettingsAgentId();

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [expCategories, setExpCategories] = useState<ExpCategory[]>([]);
  const [pendingYuan, setPendingYuan] = useState('hanako');
  const [nameTouched, setNameTouched] = useState(false);
  const modelFieldRef = React.useRef<HTMLDivElement | null>(null);
  const lastReviewerFocusRef = React.useRef<string | null>(null);
  const builtInAgentIds = useMemo(() => new Set(['lynn', 'hanako', 'butter']), []);

  const effectiveAgentId = settingsAgentId || currentAgentId || agents[0]?.id || null;
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === effectiveAgentId) || null,
    [agents, effectiveAgentId],
  );
  const availableBuiltInAgentIds = useMemo(
    () => new Set(agents.filter((agent) => builtInAgentIds.has(agent.id)).map((agent) => agent.id)),
    [agents, builtInAgentIds],
  );
  const currentRuntimeModel = useStore((s: any) => s.currentModel);
  const configReady = !!settingsConfig && settingsConfigAgentId === effectiveAgentId;
  const activeSettingsConfig = configReady ? settingsConfig : null;
  const hasUtilityModel = useMemo(() => {
    const sharedModels = globalModelsConfig?.models || {};
    const agentModels = activeSettingsConfig?.models || {};
    const runtimeChatFallback = effectiveAgentId === currentAgentId ? currentRuntimeModel?.id : null;
    return !!(
      sharedModels.utility_large
      || agentModels.utility_large
      || sharedModels.utility
      || agentModels.utility
      || agentModels.chat
      || runtimeChatFallback
    );
  }, [activeSettingsConfig, currentAgentId, currentRuntimeModel?.id, effectiveAgentId, globalModelsConfig]);
  const isBuiltInAgentView = !!selectedAgent && builtInAgentIds.has(selectedAgent.id);

  useEffect(() => {
    if (activeSettingsConfig) {
      setAgentName(activeSettingsConfig.agent?.name || '');
      setIdentity(activeSettingsConfig._identity || '');
      setIshiki(activeSettingsConfig._ishiki || '');
      setExpCategories(parseExperience(activeSettingsConfig._experience || ''));
      setPendingYuan(activeSettingsConfig.agent?.yuan || selectedAgent?.yuan || 'hanako');
      setNameTouched(false);
      return;
    }
    setAgentName(selectedAgent?.name || '');
    setIdentity('');
    setIshiki('');
    setExpCategories([]);
    setPendingYuan(selectedAgent?.yuan || 'hanako');
    setNameTouched(false);
  }, [activeSettingsConfig, selectedAgent]);

  const builtInYuanEntries = useMemo(() => {
    const raw = (t('yuan.types') || {}) as Record<string, { name?: string }>;
    return Object.fromEntries(getDisplayYuanEntries(raw));
  }, []);
  const yuanHint = String(t('settings.agent.yuanHint') || '').trim();

  useEffect(() => {
    if (!selectedAgent) return;
    if (nameTouched) return;
    const previousYuanKey = normalizeYuanKey(activeSettingsConfig?.agent?.yuan || selectedAgent.yuan || 'hanako');
    const nextYuanKey = normalizeYuanKey(pendingYuan);
    if (previousYuanKey === nextYuanKey) return;

    const previousBuiltInName = builtInYuanEntries[previousYuanKey]?.name || '';
    const nextBuiltInName = builtInYuanEntries[nextYuanKey]?.name || '';
    if (!nextBuiltInName) return;

    const trimmedAgentName = String(agentName || '').trim();
    const selectedAgentName = String(selectedAgent.name || '').trim();
    if (!trimmedAgentName || trimmedAgentName === previousBuiltInName || trimmedAgentName === selectedAgentName) {
      setAgentName(nextBuiltInName);
    }
  }, [activeSettingsConfig, agentName, builtInYuanEntries, nameTouched, pendingYuan, selectedAgent]);

  useEffect(() => {
    if (!activeSettingsConfig || settingsConfigAgentId !== effectiveAgentId) return;
    if (activeSettingsConfig.agent?.tier !== 'reviewer' || !effectiveAgentId) return;
    if (lastReviewerFocusRef.current === effectiveAgentId) return;
    lastReviewerFocusRef.current = effectiveAgentId;
    requestAnimationFrame(() => {
      modelFieldRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const target = modelFieldRef.current?.querySelector('button, [role="combobox"]') as HTMLElement | null;
      target?.focus?.();
    });
  }, [activeSettingsConfig, effectiveAgentId, settingsConfigAgentId]);

  const isViewingOther = effectiveAgentId !== currentAgentId;
  const currentYuan = activeSettingsConfig?.agent?.yuan || selectedAgent?.yuan || 'hanako';

  const chatRaw = activeSettingsConfig?.models?.chat;
  const currentModel = typeof chatRaw === 'object' && chatRaw?.id ? chatRaw.id : (chatRaw || '');
  const currentProvider = typeof chatRaw === 'object' && chatRaw?.provider ? chatRaw.provider : (activeSettingsConfig?.api?.provider || '');
  const selectedAgentId = selectedAgent?.id || effectiveAgentId || '';

  // 从唯一信源 /api/models 获取模型列表（和聊天页一致）
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  useEffect(() => {
    hanaFetch('/api/models').then(r => r.json()).then(data => {
      setAvailableModels(data.models || []);
    }).catch(() => {});
  }, [activeSettingsConfig]); // settingsConfig 变化时刷新

  const fallbackVisibleModel = useMemo(() => {
    if (currentModel) return null;
    if (effectiveAgentId === currentAgentId && currentRuntimeModel?.id) {
      return {
        id: currentRuntimeModel.id,
        provider: currentRuntimeModel.provider || '',
      };
    }
    const fallback = resolveRoleDefaultModel(availableModels as any, currentYuan);
    return fallback ? { id: fallback.id, provider: fallback.provider || '' } : null;
  }, [availableModels, currentAgentId, currentModel, currentRuntimeModel, currentYuan, effectiveAgentId]);

  const effectiveCurrentModelId = currentModel || fallbackVisibleModel?.id || '';
  const effectiveCurrentProvider = currentProvider || fallbackVisibleModel?.provider || '';

  const visibleCurrentModel = useMemo(() => {
    if (!effectiveCurrentModelId) return '';
    return encodeUserVisibleModelValue({
      id: normalizeDisplayModelId(effectiveCurrentModelId, effectiveCurrentProvider),
      provider: effectiveCurrentProvider || undefined,
    });
  }, [effectiveCurrentModelId, effectiveCurrentProvider]);

  const modelOptions = useMemo(() => {
    const opts = buildUserVisibleModelOptions(availableModels).map((option) => ({
      value: option.value,
      label: option.label,
      group: option.rawProvider && option.rawProvider !== 'brain'
        ? (normalizeDisplayProviderLabel(option.rawProvider) || option.rawProvider)
        : '',
    }));
    if (visibleCurrentModel && !opts.some((model) => model.value === visibleCurrentModel)) {
      opts.unshift({
        value: visibleCurrentModel,
        label: normalizeDisplayModelName(
          { id: effectiveCurrentModelId, name: effectiveCurrentModelId, provider: effectiveCurrentProvider || undefined },
          { role: currentYuan, purpose: 'chat' },
        ) || effectiveCurrentModelId,
        group: effectiveCurrentProvider && effectiveCurrentProvider !== 'brain'
          ? (normalizeDisplayProviderLabel(effectiveCurrentProvider) || effectiveCurrentProvider)
          : '',
      });
    }
    return opts;
  }, [availableModels, currentYuan, effectiveCurrentModelId, effectiveCurrentProvider, visibleCurrentModel]);

  const selectedAvatarSrc = useMemo(() => {
    if (selectedAgent?.hasAvatar && selectedAgentId) {
      return hanaUrl(`/api/agents/${selectedAgentId}/avatar?t=${selectedAgentId}`);
    }
    return settingsYuanFallbackAvatar(pendingYuan || currentYuan);
  }, [currentYuan, pendingYuan, selectedAgent?.hasAvatar, selectedAgentId]);

  const isBundledLynnAvatar = isBundledLynnAvatarSrc(selectedAvatarSrc);
  const memoryEnabled = activeSettingsConfig?.memory?.enabled !== false;

  const saveAgent = async () => {
    try {
      const agentId = effectiveAgentId || agents[0]?.id;
      if (!agentId) throw new Error('no valid agent selected');
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, unknown> = {};
      if (agentName && agentName !== (activeSettingsConfig?.agent?.name || '')) {
        configPartial.agent = { name: agentName };
      }
      if (pendingYuan !== (activeSettingsConfig?.agent?.yuan || 'hanako')) {
        configPartial.agent = {
          ...((configPartial.agent as Record<string, unknown>) || {}),
          yuan: pendingYuan,
        };
      }

      const identityChanged = identity !== (activeSettingsConfig?._identity || '');
      const ishikiChanged = ishiki !== (activeSettingsConfig?._ishiki || '');

      if (!Object.keys(configPartial).length && !identityChanged && !ishikiChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(configPartial).length) {
        requests.push(hanaFetch(`${agentBase}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configPartial),
        }));
      }
      if (identityChanged) {
        requests.push(hanaFetch(`${agentBase}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identity }),
        }));
      }
      if (ishikiChanged) {
        requests.push(hanaFetch(`${agentBase}/ishiki`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ishiki }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (isActive && (configPartial as { agent?: { name: string } })?.agent?.name) {
        store.set({ agentName: (configPartial as { agent: { name: string } }).agent.name });
        platform?.settingsChanged?.('agent-updated', {
          agentName: (configPartial as { agent: { name: string } }).agent.name,
          agentId,
        });
      }
      if (isActive && (configPartial as { agent?: { yuan?: string } })?.agent?.yuan) {
        store.set({ agentYuan: pendingYuan });
        platform?.settingsChanged?.('agent-updated', {
          agentId,
          yuan: pendingYuan,
        });
      }
      await loadSettingsConfig();
      await loadAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const handleAvatarClick = () => {
    // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker, not part of React tree
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      if (input.files?.[0]) {
        window.dispatchEvent(new CustomEvent('hana-open-cropper', {
          detail: { role: 'agent', file: input.files[0] },
        }));
      }
    });
    input.click();
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="agent">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.title')}</h2>
        <div className={styles['settings-avatar-center']}>
          <div className={styles['avatar-upload']} onClick={handleAvatarClick} title="">
            <img
              key={selectedAvatarSrc}
              className={`${styles['avatar-preview']}${isBundledLynnAvatar ? ` ${styles['avatar-preview-bundled-lynn']}` : ''}`}
              src={selectedAvatarSrc}
              draggable={false}
              onError={(e) => {
                const img = e.currentTarget;
                img.onerror = null;
                img.src = settingsYuanFallbackAvatar(pendingYuan || currentYuan);
              }}
            />
            <div className={styles['avatar-upload-overlay']}>{t('settings.agent.changeAvatar')}</div>
          </div>
        </div>

        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          <input
            className={styles['agent-name-input']}
            type="text"
            value={agentName}
            placeholder={t('settings.agent.agentNameHint')}
            onChange={(e) => {
              setNameTouched(true);
              setAgentName(e.target.value);
            }}
          />
        </div>
        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`} ref={modelFieldRef}>
          <div className={styles['model-capsule']}>
            <span className={styles['model-capsule-label']}>{t('settings.agent.chatModel')}</span>
            <SelectWidget
              options={modelOptions}
              value={visibleCurrentModel}
              disabled={modelOptions.length === 0}
              onChange={async (modelValue) => {
                const parsed = decodeUserVisibleModelValue(modelValue);
                if (!parsed.id) return;
                const normalizedId = normalizeDisplayModelId(parsed.id, parsed.provider || currentProvider || '');
                const match = availableModels.find((model) => (
                  model.id === normalizedId
                  && (!parsed.provider || model.provider === parsed.provider)
                )) || availableModels.find((model) => model.id === normalizedId);

                const provider = parsed.provider || match?.provider || currentProvider || '';
                const partial: Record<string, unknown> = {
                  models: {
                    chat: provider ? { id: normalizedId, provider } : normalizedId,
                  },
                };
                if (provider) {
                  partial.api = { provider };
                }
                await autoSaveConfig(partial, { refreshModels: true });
              }}
              placeholder={t('settings.api.selectModel')}
            />
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.agent.chatModelHint')}</span>
        </div>
      </section>

      {/* 关于 Ta */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.about.title')}</h2>
        <div className={`${styles['settings-field']} ${styles['settings-field-center']}`}>
          {yuanHint && <span className={styles['settings-field-hint']}>{yuanHint}</span>}
          <YuanSelector
            currentYuan={pendingYuan || currentYuan}
            onChange={(key) => {
              const normalizedKey = normalizeYuanKey(key);
              if (isBuiltInAgentView && availableBuiltInAgentIds.has(normalizedKey)) {
                void browseAgent(normalizedKey);
                return;
              }
              setPendingYuan(normalizedKey);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.agent.identity')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.identityHint')}</span>
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.agent.ishiki')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={10}
            spellCheck={false}
            value={ishiki}
            onChange={(e) => setIshiki(e.target.value)}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.ishikiHint')}</span>
        </div>
      </section>

      <MemorySection
        hasUtilityModel={hasUtilityModel}
        memoryEnabled={memoryEnabled}
        isViewingOther={isViewingOther}
        currentPins={currentPins}
      />

      {/* 经验 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.experience.title')}</h2>
        <p className={styles['settings-hint']}>{t('settings.experience.hint')}</p>
        {expCategories.length === 0 ? (
          <div className={styles['exp-empty']}>{t('settings.experience.empty')}</div>
        ) : (
          <div className={styles['exp-list']}>
            {expCategories.map((cat) => (
              <ExperienceBlock
                key={cat.name}
                category={cat}
                onSave={(updated) => {
                  const next = expCategories.map(c => c.name === cat.name ? updated : c);
                  setExpCategories(next);
                  putExperience(store, next);
                }}
                onDelete={() => {
                  const next = expCategories.filter(c => c.name !== cat.name);
                  setExpCategories(next);
                  putExperience(store, next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <div className={styles['settings-section-footer']}>
        <button className={styles['settings-save-btn-sm']} onClick={saveAgent}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}
