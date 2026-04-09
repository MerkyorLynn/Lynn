/**
 * DeskSkillsSection — 中央能力中心（技能 / MCP）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './Desk.module.css';

const DESK_CAPABILITY_VIEW_KEY = 'hana-desk-capability-view';
type CapabilityView = 'skills' | 'mcp';
type RecommendedSort = 'score' | 'downloads';

interface DeskSkillRecord {
  name: string;
  description: string;
  enabled: boolean;
  hidden?: boolean;
  source?: string;
  externalLabel?: string | null;
  baseDir?: string;
  filePath?: string;
}

interface RecommendedSkill {
  id: string;
  aliases: string[];
  category: string;
  score: number;
  downloads: number;
  builtin?: boolean;
  defaultSeeded?: boolean;
  requiresCredentials?: boolean;
}

const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  { id: 'self-improving-agent', aliases: ['self-improvement', 'self-improving-agent'], category: 'AI 智能', score: 100, downloads: 117, builtin: true, defaultSeeded: true },
  { id: 'tavily-search', aliases: ['tavily', 'tavily-search'], category: '开发工具', score: 99, downloads: 98, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'find-skills', aliases: ['find-skills'], category: 'AI 智能', score: 97, downloads: 95, builtin: true, defaultSeeded: true },
  { id: 'summarize', aliases: ['summarize'], category: '效率提升', score: 96, downloads: 95, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'agent-browser', aliases: ['Agent Browser', 'agent-browser'], category: '开发工具', score: 95, downloads: 91, builtin: true, defaultSeeded: true },
  { id: 'github', aliases: ['github'], category: '开发工具', score: 94, downloads: 88, builtin: true, defaultSeeded: true },
  { id: 'proactive-agent', aliases: ['proactive-agent'], category: 'AI 智能', score: 93, downloads: 69, builtin: true, defaultSeeded: true },
  { id: 'ontology', aliases: ['ontology'], category: 'AI 智能', score: 92, downloads: 65, builtin: true, defaultSeeded: true },
  { id: 'weather', aliases: ['weather'], category: '生活实用', score: 91, downloads: 61, builtin: true, defaultSeeded: true },
  { id: 'skill-vetter', aliases: ['skill-vetter'], category: 'AI 智能', score: 90, downloads: 58, builtin: true, defaultSeeded: true },
  { id: 'nano-pdf', aliases: ['nano-pdf'], category: '效率提升', score: 89, downloads: 71, builtin: true, defaultSeeded: true },
  { id: 'humanizer', aliases: ['humanizer'], category: '内容创作', score: 88, downloads: 69, builtin: true, defaultSeeded: true },
  { id: 'ffmpeg-video-editor', aliases: ['ffmpeg-video-editor'], category: '开发工具', score: 87, downloads: 32, builtin: true, defaultSeeded: true },
  { id: 'docker-essentials', aliases: ['docker-essentials'], category: '开发工具', score: 86, downloads: 29, builtin: true, defaultSeeded: true },
  { id: 'baidu-search', aliases: ['baidu-search'], category: '数据分析', score: 85, downloads: 79, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'stock-analysis', aliases: ['stock-analysis'], category: '数据分析', score: 84, downloads: 63, builtin: true, defaultSeeded: true },
];

const CAPABILITY_CATEGORIES = [
  '全部',
  'AI 智能',
  '开发工具',
  '效率提升',
  '数据分析',
  '内容创作',
  '安全合规',
  '通讯协作',
  '生活实用',
];

function normalizeSkillAlias(value: string) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function shortDescription(raw: string) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

function recommendedSkillHint(entry: {
  skill: DeskSkillRecord | null;
  builtin?: boolean;
  defaultSeeded?: boolean;
  requiresCredentials?: boolean;
}) {
  if (entry.skill?.enabled) {
    return '已启用，上方“已安装技能”里可以继续查看和关闭。';
  }
  if (entry.skill) {
    return '已经装在本机里了，点右侧按钮即可启用，不需要再复制路径。';
  }
  if (entry.requiresCredentials) {
    return '这个技能需要你先配置自己的 API Key，适合按需安装，不会再默认给新用户启用。';
  }
  if (entry.defaultSeeded && entry.builtin) {
    return '这是默认预装能力，如果当前没装上，点一下即可直接恢复安装。';
  }
  if (entry.builtin) {
    return '当前版本已经内置，点击右侧按钮即可直接安装，不会跳网页。';
  }
  return '当前版本未内置，点击右侧按钮会打开腾讯 SkillHub 镜像站继续安装。';
}

export function DeskSkillsSection() {
  const discoveredAgents = useStore((state) => state.discoveredAgents);
  const capabilitySnapshot = useStore((state) => state.capabilitySnapshot);
  const deskSkillsSnapshot = useStore((state) => state.deskSkills);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<CapabilityView>(
    () => (localStorage.getItem(DESK_CAPABILITY_VIEW_KEY) as CapabilityView) || 'skills',
  );
  const [sortMode, setSortMode] = useState<RecommendedSort>('score');
  const [category, setCategory] = useState('全部');
  const [showAllInstalled, setShowAllInstalled] = useState(false);
  const [allSkills, setAllSkills] = useState<DeskSkillRecord[]>([]);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const [installFeedback, setInstallFeedback] = useState<string | null>(null);

  const loadDeskSkills = useCallback(async () => {
    setLoading(true);
    try {
      const response = await hanaFetch('/api/skills');
      const data = await response.json();
      let all = (data.skills || []) as DeskSkillRecord[];
      if (all.length === 0) {
        try {
          const reloadResponse = await hanaFetch('/api/skills/reload', { method: 'POST' });
          const reloadData = await reloadResponse.json();
          all = (reloadData.skills || []) as DeskSkillRecord[];
        } catch {
          // keep the initial list if the reload probe fails
        }
      }
      const sortedSkills = all.sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        if (!!left.hidden !== !!right.hidden) return left.hidden ? 1 : -1;
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
      });
      setAllSkills(sortedSkills);
      if (sortedSkills.length > 0) {
        useStore.getState().setDeskSkills(
          sortedSkills.map((skill) => ({
            name: skill.name,
            enabled: skill.enabled,
            source: skill.source,
            externalLabel: skill.externalLabel,
          })),
        );
      }
      setInstallFeedback(null);
    } catch {
      setInstallFeedback('已安装技能读取失败，我会自动重试，不会影响你直接安装或启用推荐技能。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDeskSkills();
    window.__loadDeskSkills = loadDeskSkills;
    return () => {
      delete window.__loadDeskSkills;
    };
  }, [loadDeskSkills]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: CapabilityView }>).detail || {};
      const target = detail.target || 'skills';
      setVisible(true);
      setView(target);
      localStorage.setItem(DESK_CAPABILITY_VIEW_KEY, target);
      if (target === 'skills') {
        void loadDeskSkills();
      }
    };
    window.addEventListener('desk-capability-open', onOpen as EventListener);
    return () => window.removeEventListener('desk-capability-open', onOpen as EventListener);
  }, [loadDeskSkills]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  const switchView = useCallback((next: CapabilityView) => {
    setView(next);
    localStorage.setItem(DESK_CAPABILITY_VIEW_KEY, next);
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const previous = allSkills;
    const nextSkills = previous.map((skill) => (skill.name === name ? { ...skill, enabled: enable } : skill));
    setAllSkills(nextSkills);
    useStore.getState().setDeskSkills(
      nextSkills.map((skill) => ({
        name: skill.name,
        enabled: skill.enabled,
        source: skill.source,
        externalLabel: skill.externalLabel,
      })),
    );

    const enabledList = nextSkills.filter((skill) => skill.enabled).map((skill) => skill.name);
    try {
      const agentId = useStore.getState().currentAgentId || '';
      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
      useStore.getState().addToast(
        enable ? `${name} 已启用，上方“已安装技能”里可以继续查看和关闭` : `${name} 已关闭`,
        'success',
      );
      window.dispatchEvent(new CustomEvent('skills-changed'));
    } catch {
      setAllSkills(previous);
      useStore.getState().setDeskSkills(
        previous.map((skill) => ({
          name: skill.name,
          enabled: skill.enabled,
          source: skill.source,
          externalLabel: skill.externalLabel,
        })),
      );
      useStore.getState().addToast('技能状态更新失败', 'error');
    }
  }, [allSkills]);

  const installedSkills = useMemo(() => {
    if (allSkills.length > 0) return allSkills;
    if (deskSkillsSnapshot.length === 0) return [];
    return deskSkillsSnapshot
      .map((skill) => ({
        name: skill.name,
        description: '',
        enabled: skill.enabled,
        hidden: false,
        source: skill.source,
        externalLabel: skill.externalLabel,
        baseDir: undefined,
        filePath: undefined,
      }))
      .sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
      });
  }, [allSkills, deskSkillsSnapshot]);
  const enabledCount = useMemo(() => allSkills.filter((skill) => skill.enabled).length, [allSkills]);

  const recommendedSkills = useMemo(() => {
    const byAlias = new Map(installedSkills.map((skill) => [normalizeSkillAlias(skill.name), skill]));
    return RECOMMENDED_SKILLS.map((entry) => {
      const matched = entry.aliases
        .map((alias) => byAlias.get(normalizeSkillAlias(alias)))
        .find(Boolean)
        || byAlias.get(normalizeSkillAlias(entry.id))
        || null;
      return {
        ...entry,
        skill: matched || null,
        displayName: matched?.name || entry.id,
        description: matched?.description || '',
      };
    }).filter((entry) => category === '全部' || entry.category === category)
      .sort((left, right) => {
        const scoreKey = sortMode === 'downloads' ? 'downloads' : 'score';
        const order = right[scoreKey] - left[scoreKey];
        if (order !== 0) return order;
        return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN');
      });
  }, [category, installedSkills, sortMode]);

  const visibleInstalled = showAllInstalled ? installedSkills : installedSkills.slice(0, 8);

  const installBuiltinSkill = useCallback(async (entry: (typeof recommendedSkills)[number]) => {
    const response = await hanaFetch('/api/skills/install-builtin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entry.id, aliases: entry.aliases }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadDeskSkills();
    window.dispatchEvent(new CustomEvent('skills-changed'));
    const installedName = data.skill?.name || entry.displayName;
    setInstallFeedback(`${installedName} 已安装并启用，现在可以在上方“已安装技能”里找到。`);
    useStore.getState().addToast(`${installedName} 已安装并启用`, 'success');
  }, [loadDeskSkills]);

  const handleRecommendedClick = useCallback(async (entry: (typeof recommendedSkills)[number]) => {
    if (entry.skill?.enabled) {
      useStore.getState().addToast(`${entry.skill.name} 已启用，上方已安装技能里可以直接找到`, 'success');
      return;
    }
    if (!entry.skill && discoveredAgents.length > 0 && !localStorage.getItem('agent-discovery-seen')) {
      setInstallFeedback('检测到本机其他智能体已经装过技能。你可以先点上方“一键关联现有技能”，本机已有的就能直接复用。');
      useStore.getState().addToast('先试试复用本机其他智能体已经装过的技能，不用重复安装。', 'info');
      return;
    }

    const busyKey = entry.skill?.name || entry.id;
    setBusySkill(busyKey);
    try {
      if (entry.skill) {
        await toggleSkill(entry.skill.name, true);
        return;
      }
      if (!entry.builtin) {
        setInstallFeedback(`${entry.displayName} 当前不在 Lynn 内置包里。你可以继续去腾讯 SkillHub 镜像站安装，安装完后这里会显示“已安装”。`);
        window.platform?.openExternal?.('https://skillhub.tencent.com');
        useStore.getState().addToast(`${entry.displayName} 当前不在内置包里，已为你打开腾讯 SkillHub 镜像站`, 'info');
        return;
      }
      await installBuiltinSkill(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInstallFeedback(`${entry.displayName} 安装失败：${message}`);
      useStore.getState().addToast(`${entry.displayName} 安装失败：${message}`, 'error');
    } finally {
      setBusySkill(null);
    }
  }, [discoveredAgents.length, installBuiltinSkill, toggleSkill]);

  const enableDiscoveredSkillLibraries = useCallback(async () => {
    if (discoveredAgents.length === 0) return;
    try {
      const paths = discoveredAgents.map((agent) => agent.dirPath);
      await hanaFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      localStorage.setItem('agent-discovery-seen', 'true');
      useStore.setState({ agentDiscoveryVisible: false });
      useStore.getState().addToast('已关联本机其他智能体的技能目录', 'success');
      await loadDeskSkills();
    } catch {
      useStore.getState().addToast('关联本机技能目录失败', 'error');
    }
  }, [discoveredAgents, loadDeskSkills]);

  if (!visible) return null;

  return (
    <div className={styles.capabilityOverlay} onClick={() => setVisible(false)}>
      <div
        className={styles.capabilityDialog}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={view === 'skills' ? '技能中心' : 'MCP 中心'}
      >
        <div className={styles.capabilityDialogHeader}>
          <div className={styles.capabilityDialogTitleBlock}>
            <div className={styles.capabilityDialogTitle}>{view === 'skills' ? '技能' : 'MCP'}</div>
            <div className={styles.capabilityDialogSubtitle}>
              {view === 'skills'
                ? '已安装的能力在上面，推荐能力在下面；点击即可启用或安装。'
                : 'MCP 更像外部能力接入。已接入的服务在上面，推荐接入方式在下面。'}
            </div>
          </div>
          <div className={styles.capabilityDialogActions}>
            <div className={styles.capabilityTabs}>
              <button
                type="button"
                className={`${styles.capabilityTab}${view === 'skills' ? ` ${styles.capabilityTabActive}` : ''}`}
                onClick={() => switchView('skills')}
              >
                技能
              </button>
              <button
                type="button"
                className={`${styles.capabilityTab}${view === 'mcp' ? ` ${styles.capabilityTabActive}` : ''}`}
                onClick={() => switchView('mcp')}
              >
                MCP
              </button>
            </div>
            <button
              type="button"
              className={styles.capabilityCloseBtn}
              onClick={() => setVisible(false)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        </div>

        <div className={styles.capabilityDialogBody}>
          {view === 'skills' ? (
            <>
              {discoveredAgents.length > 0 && !localStorage.getItem('agent-discovery-seen') && (
                <div className={styles.capabilityNotice}>
                  <div className={styles.capabilityNoticeTitle}>检测到本机已有可复用技能</div>
                  <div className={styles.capabilityNoticeText}>
                    其他智能体已经装过的技能，不必再装一遍。你可以先一键关联，本机已有的就能直接复用。
                  </div>
                  <div className={styles.capabilityNoticeActions}>
                    <button type="button" className={styles.noticePrimaryBtn} onClick={() => void enableDiscoveredSkillLibraries()}>
                      一键关联现有技能
                    </button>
                  </div>
                </div>
              )}

              {installFeedback && (
                <div className={styles.capabilityInlineFeedback}>{installFeedback}</div>
              )}

              <div className={styles.skillsBlock}>
                <div className={styles.skillsBlockHeader}>
                  <span>已安装技能</span>
                  <span className={styles.skillsMeta}>{installedSkills.length}</span>
                </div>
                <div className={styles.capabilityGrid}>
                  {loading ? (
                    <div className={styles.capabilityNotice}>
                      <div className={styles.capabilityNoticeTitle}>正在读取已安装技能</div>
                      <div className={styles.capabilityNoticeText}>
                        我会把本机里已经装过的技能、已启用能力和已弃用项一起整理出来。
                      </div>
                    </div>
                  ) : visibleInstalled.length > 0 ? visibleInstalled.map((skill) => (
                    <div
                      className={styles.skillCard}
                      key={skill.name}
                      onClick={() => {
                        if (skill.baseDir) {
                          window.platform?.openSkillViewer?.({
                            name: skill.name,
                            baseDir: skill.baseDir,
                            filePath: skill.filePath,
                            installed: true,
                          });
                        }
                      }}
                    >
                      <div className={styles.skillCardBody}>
                        <div className={styles.skillCardHeader}>
                          <span className={styles.skillName}>{skill.name}</span>
                          {skill.enabled ? (
                            <span className={`${styles.skillSource} ${styles.skillStatusEnabled}`}>已启用</span>
                          ) : (
                            <span className={`${styles.skillSource} ${styles.skillStatusInstalled}`}>
                              {skill.hidden ? '已安装（已弃用）' : '已安装'}
                            </span>
                          )}
                          {skill.externalLabel && (
                            <span className={styles.skillSource}>{skill.externalLabel}</span>
                          )}
                        </div>
                        <div className={styles.skillCardDesc}>{shortDescription(skill.description)}</div>
                      </div>
                      <button
                        className={`hana-toggle mini${skill.enabled ? ' on' : ''}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleSkill(skill.name, !skill.enabled);
                        }}
                      />
                    </div>
                  )) : (
                    <div className={styles.capabilityNotice}>
                      <div className={styles.capabilityNoticeTitle}>暂时没读到已安装技能</div>
                      <div className={styles.capabilityNoticeText}>
                        我会自动重试读取本机技能。你也可以先看下面的推荐技能，点一下即可安装或启用。
                      </div>
                    </div>
                  )}
                </div>
                {installedSkills.length > 8 && (
                  <button
                    type="button"
                    className={styles.skillsMoreBtn}
                    onClick={() => setShowAllInstalled((prev) => !prev)}
                  >
                    {showAllInstalled ? '收起' : `显示更多 (${installedSkills.length - 8})`}
                  </button>
                )}
              </div>

              <div className={styles.skillsBlock}>
                <div className={styles.skillsBlockHeader}>
                  <span>推荐技能</span>
                  <div className={styles.skillSortTabs}>
                    <button
                      type="button"
                      className={`${styles.skillSortTab}${sortMode === 'score' ? ` ${styles.skillSortTabActive}` : ''}`}
                      onClick={() => setSortMode('score')}
                    >
                      综合评分
                    </button>
                    <button
                      type="button"
                      className={`${styles.skillSortTab}${sortMode === 'downloads' ? ` ${styles.skillSortTabActive}` : ''}`}
                      onClick={() => setSortMode('downloads')}
                    >
                      下载推荐
                    </button>
                  </div>
                </div>
                <div className={styles.categoryTabs}>
                  {CAPABILITY_CATEGORIES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={`${styles.categoryTab}${category === item ? ` ${styles.categoryTabActive}` : ''}`}
                      onClick={() => setCategory(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <div className={styles.capabilityGrid}>
                  {recommendedSkills.map((entry) => {
                    const busyKey = entry.skill?.name || entry.id;
                    return (
                      <div className={styles.recommendedCard} key={`${entry.category}-${entry.id}`}>
                        <div className={styles.recommendedCardBody}>
                          <div className={styles.skillCardHeader}>
                            <span className={styles.skillName}>{entry.displayName}</span>
                            <span className={styles.recommendedCategory}>{entry.category}</span>
                          </div>
                          <div className={styles.skillCardDesc}>
                            {shortDescription(entry.description) || '点击即可启用，之后 Lynn 会在合适时机自动使用它。'}
                          </div>
                          <div className={styles.recommendedHint}>{recommendedSkillHint(entry)}</div>
                        </div>
                        <button
                          type="button"
                          className={`${styles.recommendedActionBtn}${entry.skill?.enabled ? ` ${styles.recommendedActionBtnDone}` : ''}`}
                          disabled={busySkill === busyKey}
                          onClick={() => void handleRecommendedClick(entry)}
                        >
                          {busySkill === busyKey
                            ? '处理中…'
                            : entry.skill?.enabled
                              ? '已启用'
                              : entry.skill
                                ? '启用'
                                : entry.builtin
                                  ? '安装'
                                  : '去镜像站'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className={styles.capabilityFooterActions}>
                  <button
                    type="button"
                    className={styles.capabilityLinkBtn}
                    onClick={() => window.platform?.openExternal?.('https://skillhub.tencent.com')}
                  >
                    打开腾讯 SkillHub
                  </button>
                  <button
                    type="button"
                    className={styles.capabilityLinkBtn}
                    onClick={() => window.platform?.openSettings?.('skills')}
                  >
                    打开完整技能库
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={styles.skillsBlock}>
                <div className={styles.skillsBlockHeader}>
                  <span>MCP 接入</span>
                  <span className={styles.skillsMeta}>{capabilitySnapshot?.mcp?.servers || 0}</span>
                </div>
                <div className={styles.capabilityNotice}>
                  <div className={styles.capabilityNoticeTitle}>MCP 更像外部能力接入，不是应用商店</div>
                  <div className={styles.capabilityNoticeText}>
                    你可以把常用服务直接接进 Lynn。像 GitHub、Notion、filesystem、MiniMax 这类能力，接好之后 Lynn 就会自动把它们算进可用工具里。
                  </div>
                  <div className={styles.mcpStatsRow}>
                    <span className={styles.mcpStat}>已连接 {capabilitySnapshot?.mcp?.servers || 0} 个服务</span>
                    <span className={styles.mcpStat}>可用 {capabilitySnapshot?.mcp?.tools || 0} 个工具</span>
                  </div>
                </div>
              </div>

              <div className={styles.skillsBlock}>
                <div className={styles.skillsBlockHeader}>
                  <span>推荐接入</span>
                </div>
                <div className={styles.capabilityGrid}>
                  {[
                    { name: 'MiniMax MCP', desc: '适合把 MiniMax 的网页/文档类能力接进 Lynn。' },
                    { name: 'GitHub', desc: '适合 issue、PR、仓库信息与自动化流程。' },
                    { name: 'Notion', desc: '适合知识库、文档、任务与项目摘要。' },
                    { name: 'filesystem', desc: '适合本地目录读写与工作区工具协同。' },
                  ].map((item) => (
                    <div key={item.name} className={styles.recommendedCard}>
                      <div className={styles.recommendedCardBody}>
                        <div className={styles.skillCardHeader}>
                          <span className={styles.skillName}>{item.name}</span>
                          <span className={styles.recommendedCategory}>MCP</span>
                        </div>
                        <div className={styles.skillCardDesc}>{item.desc}</div>
                        <div className={styles.recommendedHint}>配置好之后，Lynn 会自动在合适时机调用它。</div>
                      </div>
                      <button
                        type="button"
                        className={styles.recommendedActionBtn}
                        onClick={() => window.platform?.openSettings?.('mcp')}
                      >
                        去设置
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
