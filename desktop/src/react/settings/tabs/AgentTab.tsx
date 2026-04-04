import React, { useState, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { browseAgent, switchToAgent, loadSettingsConfig, loadAgents } from '../actions';
import { AgentCardStack } from './agent/AgentCardStack';
import { YuanSelector } from './agent/YuanSelector';
import { MemorySection } from './agent/AgentMemory';
import {
  collapseBrainModelChoices,
  normalizeDisplayModelId,
  normalizeDisplayModelName,
  normalizeDisplayProviderLabel,
} from '../../utils/brain-models';
import { getDisplayYuanEntries, normalizeYuanKey } from '../../utils/agent-helpers';
import styles from '../Settings.module.css';
import {
  type ExpCategory, parseExperience,
  ExperienceBlock, putExperience,
} from './agent/AgentExperience';

const platform = window.platform;

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsConfig, settingsConfigAgentId, currentPins,
    showToast,
    globalModelsConfig,
  } = store;

  const hasUtilityModel = !!(globalModelsConfig?.models?.utility && globalModelsConfig?.models?.utility_large);
  const settingsAgentId = store.getSettingsAgentId();

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [expCategories, setExpCategories] = useState<ExpCategory[]>([]);
  const [pendingYuan, setPendingYuan] = useState('hanako');
  const [nameTouched, setNameTouched] = useState(false);
  const modelFieldRef = React.useRef<HTMLDivElement | null>(null);
  const lastReviewerFocusRef = React.useRef<string | null>(null);
  const builtInAgentIds = React.useMemo(() => new Set(['lynn', 'hanako', 'butter']), []);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === settingsAgentId) || null,
    [agents, settingsAgentId],
  );
  const configReady = !!settingsConfig && settingsConfigAgentId === settingsAgentId;

  useEffect(() => {
    if (configReady && settingsConfig) {
      setAgentName(settingsConfig.agent?.name || '');
      setIdentity(settingsConfig._identity || '');
      setIshiki(settingsConfig._ishiki || '');
      setExpCategories(parseExperience(settingsConfig._experience || ''));
      setPendingYuan(settingsConfig.agent?.yuan || 'hanako');
      setNameTouched(false);
      return;
    }
    setAgentName(selectedAgent?.name || '');
    setIdentity('');
    setIshiki('');
    setExpCategories([]);
    setPendingYuan(selectedAgent?.yuan || 'hanako');
    setNameTouched(false);
  }, [configReady, selectedAgent, settingsConfig]);

  const builtInYuanEntries = useMemo(() => {
    const raw = (t('yuan.types') || {}) as Record<string, { name?: string }>;
    return Object.fromEntries(getDisplayYuanEntries(raw));
  }, []);

  const isBuiltInAgentView = !!selectedAgent && builtInAgentIds.has(selectedAgent.id);

  useEffect(() => {
    if (!selectedAgent) return;
    if (nameTouched) return;
    const previousYuanKey = normalizeYuanKey(settingsConfig?.agent?.yuan || selectedAgent.yuan || 'hanako');
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
  }, [agentName, builtInYuanEntries, nameTouched, pendingYuan, selectedAgent, settingsConfig]);

  useEffect(() => {
    if (!configReady || !settingsConfig || settingsConfigAgentId !== settingsAgentId) return;
    if (settingsConfig.agent?.tier !== 'reviewer' || !settingsAgentId) return;
    if (lastReviewerFocusRef.current === settingsAgentId) return;
    lastReviewerFocusRef.current = settingsAgentId;
    requestAnimationFrame(() => {
      modelFieldRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const target = modelFieldRef.current?.querySelector('button, [role="combobox"]') as HTMLElement | null;
      target?.focus?.();
    });
  }, [configReady, settingsAgentId, settingsConfig, settingsConfigAgentId]);

  const isViewingOther = settingsAgentId !== currentAgentId;
  const currentYuan = settingsConfig?.agent?.yuan || selectedAgent?.yuan || 'hanako';

  const chatRaw = settingsConfig?.models?.chat;
  const currentModel = typeof chatRaw === 'object' && chatRaw?.id ? chatRaw.id : (chatRaw || '');
  const currentProvider = typeof chatRaw === 'object' && chatRaw?.provider ? chatRaw.provider : (settingsConfig?.api?.provider || '');

  // 从唯一信源 /api/models 获取模型列表（和聊天页一致）
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  useEffect(() => {
    hanaFetch('/api/models').then(r => r.json()).then(data => {
      setAvailableModels(data.models || []);
    }).catch(() => {});
  }, [settingsConfig]); // settingsConfig 变化时刷新

  const modelOptions = useMemo(() => {
    const visibleModels = collapseBrainModelChoices(availableModels);
    const opts = visibleModels.map(m => ({
      value: normalizeDisplayModelId(m.id, m.provider),
      label: normalizeDisplayModelName(m),
      group: normalizeDisplayProviderLabel(m.provider),
    }));
    const normalizedCurrent = normalizeDisplayModelId(currentModel, currentProvider);
    if (normalizedCurrent && !opts.some(m => m.value === normalizedCurrent)) {
      opts.unshift({ value: normalizedCurrent, label: normalizedCurrent, group: '' });
    }
    return opts;
  }, [availableModels, currentModel, currentProvider]);

  const visibleCurrentModel = normalizeDisplayModelId(currentModel, currentProvider);

  const memoryEnabled = settingsConfig?.memory?.enabled !== false;

  const saveAgent = async () => {
    try {
      const agentId = store.getSettingsAgentId()!;
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, unknown> = {};
      if (agentName && agentName !== (settingsConfig?.agent?.name || '')) {
        configPartial.agent = { name: agentName };
      }
      if (pendingYuan !== (settingsConfig?.agent?.yuan || 'hanako')) {
        configPartial.agent = {
          ...((configPartial.agent as Record<string, unknown>) || {}),
          yuan: pendingYuan,
        };
      }

      const identityChanged = identity !== (settingsConfig?._identity || '');
      const ishikiChanged = ishiki !== (settingsConfig?._ishiki || '');

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

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.title')}</h2>
        <AgentCardStack
          agents={agents}
          selectedId={settingsAgentId || currentAgentId}
          currentAgentId={currentAgentId}
          previewSelectedAgent={{ name: agentName, yuan: pendingYuan || currentYuan }}
          onSelect={(id) => {
            const targetAgent = agents.find((agent) => agent.id === id);
            if (targetAgent) {
              setAgentName(targetAgent.name || '');
              setPendingYuan(targetAgent.yuan || 'hanako');
              setIdentity('');
              setIshiki('');
              setExpCategories([]);
              setNameTouched(false);
            }
            void browseAgent(id);
          }}
          onAvatarClick={() => {
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
          }}
          onSetActive={(id) => switchToAgent(id)}
          onDelete={() => window.dispatchEvent(new Event('hana-show-agent-delete'))}
        />

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
              disabled={modelOptions.length <= 1}
              onChange={async (modelId) => {
                const partial: Record<string, unknown> = { models: { chat: modelId } };
                const match = availableModels.find(m => m.id === modelId);
                if (match?.provider) {
                  partial.api = { provider: match.provider };
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
          <span className={styles['settings-field-hint']}>{t('settings.agent.yuanHint')}</span>
          <YuanSelector
            currentYuan={pendingYuan || currentYuan}
            onChange={(key) => {
              if (isBuiltInAgentView && builtInAgentIds.has(key)) {
                void browseAgent(key);
                return;
              }
              setPendingYuan(key);
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
