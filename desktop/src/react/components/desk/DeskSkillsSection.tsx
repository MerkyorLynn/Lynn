/**
 * DeskSkillsSection — 中央能力中心（技能 / MCP）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { isChineseLocale } from '../../utils/locale';
import styles from './Desk.module.css';

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
  /** Stable category key (not the display label) so filtering survives locale switches. */
  category: SkillCategory;
  score: number;
  downloads: number;
  builtin?: boolean;
  defaultSeeded?: boolean;
  requiresCredentials?: boolean;
}

type SkillCategory =
  | 'all'
  | 'ai'
  | 'dev'
  | 'productivity'
  | 'data'
  | 'writing'
  | 'security'
  | 'comms'
  | 'lifestyle';

const CATEGORY_LABELS: Record<SkillCategory, { zh: string; en: string }> = {
  all: { zh: '全部', en: 'All' },
  ai: { zh: 'AI 智能', en: 'AI' },
  dev: { zh: '开发工具', en: 'Developer' },
  productivity: { zh: '效率提升', en: 'Productivity' },
  data: { zh: '数据分析', en: 'Data' },
  writing: { zh: '内容创作', en: 'Writing' },
  security: { zh: '安全合规', en: 'Security' },
  comms: { zh: '通讯协作', en: 'Communication' },
  lifestyle: { zh: '生活实用', en: 'Lifestyle' },
};

const CAPABILITY_CATEGORIES: SkillCategory[] = [
  'all',
  'ai',
  'dev',
  'productivity',
  'data',
  'writing',
  'security',
  'comms',
  'lifestyle',
];

const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  { id: 'self-improving-agent', aliases: ['self-improvement', 'self-improving-agent'], category: 'ai', score: 100, downloads: 117, builtin: true, defaultSeeded: true },
  { id: 'tavily-search', aliases: ['tavily', 'tavily-search'], category: 'dev', score: 99, downloads: 98, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'find-skills', aliases: ['find-skills'], category: 'ai', score: 97, downloads: 95, builtin: true, defaultSeeded: true },
  { id: 'summarize', aliases: ['summarize'], category: 'productivity', score: 96, downloads: 95, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'agent-browser', aliases: ['Agent Browser', 'agent-browser'], category: 'dev', score: 95, downloads: 91, builtin: true, defaultSeeded: true },
  { id: 'github', aliases: ['github'], category: 'dev', score: 94, downloads: 88, builtin: true, defaultSeeded: true },
  { id: 'proactive-agent', aliases: ['proactive-agent'], category: 'ai', score: 93, downloads: 69, builtin: true, defaultSeeded: true },
  { id: 'ontology', aliases: ['ontology'], category: 'ai', score: 92, downloads: 65, builtin: true, defaultSeeded: true },
  { id: 'weather', aliases: ['weather'], category: 'lifestyle', score: 91, downloads: 61, builtin: true, defaultSeeded: false },
  { id: 'skill-vetter', aliases: ['skill-vetter'], category: 'ai', score: 90, downloads: 58, builtin: true, defaultSeeded: true },
  { id: 'nano-pdf', aliases: ['nano-pdf'], category: 'productivity', score: 89, downloads: 71, builtin: true, defaultSeeded: true },
  { id: 'humanizer', aliases: ['humanizer'], category: 'writing', score: 88, downloads: 69, builtin: true, defaultSeeded: true },
  { id: 'ffmpeg-video-editor', aliases: ['ffmpeg-video-editor'], category: 'dev', score: 87, downloads: 32, builtin: true, defaultSeeded: true },
  { id: 'docker-essentials', aliases: ['docker-essentials'], category: 'dev', score: 86, downloads: 29, builtin: true, defaultSeeded: true },
  { id: 'baidu-search', aliases: ['baidu-search'], category: 'data', score: 85, downloads: 79, builtin: true, defaultSeeded: false, requiresCredentials: true },
  { id: 'stock-analysis', aliases: ['stock-analysis'], category: 'data', score: 84, downloads: 63, builtin: true, defaultSeeded: false },
];

function categoryLabel(key: SkillCategory, zh: boolean) {
  const label = CATEGORY_LABELS[key];
  return zh ? label.zh : label.en;
}

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
}, zh: boolean) {
  if (entry.skill?.enabled) {
    return zh
      ? '已启用，上方“已安装技能”里可以继续查看和关闭。'
      : 'Enabled. You can review or turn it off under Installed skills above.';
  }
  if (entry.skill) {
    return zh
      ? '已经装在本机里了，点右侧按钮即可启用，不需要再复制路径。'
      : 'Already installed on this machine. Use the button on the right to enable it — no need to copy any path.';
  }
  if (entry.requiresCredentials) {
    return zh
      ? '这个技能需要你先配置自己的 API Key，适合按需安装，不会再默认给新用户启用。'
      : 'This skill needs your own API key first. It is an optional install and is not enabled for new users by default.';
  }
  if (entry.defaultSeeded && entry.builtin) {
    return zh
      ? '这是默认预装能力，如果当前没装上，点一下即可直接恢复安装。'
      : 'This is part of the default setup. If it is missing, one click restores it.';
  }
  if (entry.builtin) {
    return zh
      ? '当前版本已经内置，点击右侧按钮即可直接安装，不会跳网页。'
      : 'Bundled with this version. Clicking the button installs it right away without opening a web page.';
  }
  return zh
    ? '当前版本未内置，点击右侧按钮会打开腾讯 SkillHub 镜像站继续安装。'
    : 'Not bundled with this version. Clicking the button opens the Tencent SkillHub mirror so you can keep installing.';
}

export function DeskSkillsSection() {
  const { locale } = useI18n();
  const zh = isChineseLocale(locale);
  const discoveredAgents = useStore((state) => state.discoveredAgents);
  const deskSkillsSnapshot = useStore((state) => state.deskSkills);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const [sortMode, setSortMode] = useState<RecommendedSort>('score');
  const [category, setCategory] = useState<SkillCategory>('all');

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
      const sortLocale = String(window.i18n?.locale || 'en');
      const sortedSkills = all.sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        if (!!left.hidden !== !!right.hidden) return left.hidden ? 1 : -1;
        return left.name.localeCompare(right.name, sortLocale);
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
      setInstallFeedback(isChineseLocale()
        ? '已安装技能读取失败，我会自动重试，不会影响你直接安装或启用推荐技能。'
        : 'Could not read installed skills. I will retry automatically; you can still install or enable recommended skills.');
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
    const onOpen = () => {
      setVisible(true);
      void loadDeskSkills();
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
        enable
          ? (isChineseLocale()
            ? `${name} 已启用，上方“已安装技能”里可以继续查看和关闭`
            : `${name} is enabled — manage it under Installed skills above`)
          : (isChineseLocale() ? `${name} 已关闭` : `${name} turned off`),
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
      useStore.getState().addToast(
        isChineseLocale() ? '技能状态更新失败' : 'Failed to update skill state',
        'error',
      );
    }
  }, [allSkills]);

  const installedSkills = useMemo(() => {
    if (allSkills.length > 0) return allSkills;
    if (deskSkillsSnapshot.length === 0) return [];
    const sortLocale = String(window.i18n?.locale || 'en');
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
        return left.name.localeCompare(right.name, sortLocale);
      });
  }, [allSkills, deskSkillsSnapshot]);
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
    }).filter((entry) => category === 'all' || entry.category === category)
      .sort((left, right) => {
        const scoreKey = sortMode === 'downloads' ? 'downloads' : 'score';
        const order = right[scoreKey] - left[scoreKey];
        if (order !== 0) return order;
        return left.displayName.localeCompare(right.displayName, String(window.i18n?.locale || 'en'));
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
    setInstallFeedback(isChineseLocale()
      ? `${installedName} 已安装并启用，现在可以在上方“已安装技能”里找到。`
      : `${installedName} is installed and enabled — you can find it under Installed skills above.`);
    useStore.getState().addToast(
      isChineseLocale() ? `${installedName} 已安装并启用` : `${installedName} installed and enabled`,
      'success',
    );
  }, [loadDeskSkills]);

  const handleRecommendedClick = useCallback(async (entry: (typeof recommendedSkills)[number]) => {
    if (entry.skill?.enabled) {
      useStore.getState().addToast(
        isChineseLocale()
          ? `${entry.skill.name} 已启用，上方已安装技能里可以直接找到`
          : `${entry.skill.name} is already enabled — find it under Installed skills above`,
        'success',
      );
      return;
    }
    if (!entry.skill && discoveredAgents.length > 0 && !localStorage.getItem('agent-discovery-seen')) {
      setInstallFeedback(isChineseLocale()
        ? '检测到本机其他智能体已经装过技能。你可以先点上方“一键关联现有技能”，本机已有的就能直接复用。'
        : 'Other agents on this machine already installed skills. Use "Link existing skills" above to reuse what is already here.');
      useStore.getState().addToast(
        isChineseLocale()
          ? '先试试复用本机其他智能体已经装过的技能，不用重复安装。'
          : 'Try reusing skills other agents on this machine already installed — no need to install them twice.',
        'info',
      );
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
        setInstallFeedback(isChineseLocale()
          ? `${entry.displayName} 当前不在 Lynn 内置包里。你可以继续去腾讯 SkillHub 镜像站安装，安装完后这里会显示“已安装”。`
          : `${entry.displayName} is not bundled with Lynn. You can keep installing from the Tencent SkillHub mirror; once done it shows as Installed here.`);
        window.platform?.openExternal?.('https://skillhub.tencent.com');
        useStore.getState().addToast(
          isChineseLocale()
            ? `${entry.displayName} 当前不在内置包里，已为你打开腾讯 SkillHub 镜像站`
            : `${entry.displayName} is not bundled — opened the Tencent SkillHub mirror for you`,
          'info',
        );
        return;
      }
      await installBuiltinSkill(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInstallFeedback(isChineseLocale()
        ? `${entry.displayName} 安装失败：${message}`
        : `Failed to install ${entry.displayName}: ${message}`);
      useStore.getState().addToast(
        isChineseLocale()
          ? `${entry.displayName} 安装失败：${message}`
          : `Failed to install ${entry.displayName}: ${message}`,
        'error',
      );
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
      useStore.getState().addToast(
        isChineseLocale()
          ? '已关联本机其他智能体的技能目录'
          : 'Linked the skill folders of other agents on this machine',
        'success',
      );
      await loadDeskSkills();
    } catch {
      useStore.getState().addToast(
        isChineseLocale() ? '关联本机技能目录失败' : 'Failed to link local skill folders',
        'error',
      );
    }
  }, [discoveredAgents, loadDeskSkills]);

  if (!visible) return null;

  const L = (zhText: string, enText: string) => (zh ? zhText : enText);

  return (
    <div className={styles.capabilityOverlay} onClick={() => setVisible(false)}>
      <div
        className={styles.capabilityDialog}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={L('技能中心', 'Skills center')}
      >
        <div className={styles.capabilityDialogHeader}>
          <div className={styles.capabilityDialogTitleBlock}>
            <div className={styles.capabilityDialogTitle}>{L('技能', 'Skills')}</div>
            <div className={styles.capabilityDialogSubtitle}>
              {L('已安装的能力在上面，推荐能力在下面；点击即可启用或安装。',
                'Installed skills are on top, recommendations below. Click to enable or install.')}
            </div>
          </div>
          <div className={styles.capabilityDialogActions}>
            <button
              type="button"
              className={styles.capabilityCloseBtn}
              onClick={() => setVisible(false)}
              aria-label={L('关闭', 'Close')}
            >
              ×
            </button>
          </div>
        </div>

        <div className={styles.capabilityDialogBody}>
          <>
            {discoveredAgents.length > 0 && !localStorage.getItem('agent-discovery-seen') && (
              <div className={styles.capabilityNotice}>
                <div className={styles.capabilityNoticeTitle}>
                  {L('检测到本机已有可复用技能', 'Reusable skills found on this machine')}
                </div>
                <div className={styles.capabilityNoticeText}>
                  {L('其他智能体已经装过的技能，不必再装一遍。你可以先一键关联，本机已有的就能直接复用。',
                    'Skills already installed by other agents do not need a second install. Link them once and reuse what is already here.')}
                </div>
                <div className={styles.capabilityNoticeActions}>
                  <button type="button" className={styles.noticePrimaryBtn} onClick={() => void enableDiscoveredSkillLibraries()}>
                    {L('一键关联现有技能', 'Link existing skills')}
                  </button>
                </div>
              </div>
            )}

            {installFeedback && (
              <div className={styles.capabilityInlineFeedback}>{installFeedback}</div>
            )}

            <div className={styles.skillsBlock}>
              <div className={styles.skillsBlockHeader}>
                <span>{L('已安装技能', 'Installed skills')}</span>
                <span className={styles.skillsMeta}>{installedSkills.length}</span>
              </div>
              <div className={styles.capabilityGrid}>
                  {loading ? (
                    <div className={styles.capabilityNotice}>
                      <div className={styles.capabilityNoticeTitle}>
                        {L('正在读取已安装技能', 'Loading installed skills')}
                      </div>
                      <div className={styles.capabilityNoticeText}>
                        {L('我会把本机里已经装过的技能、已启用能力和已弃用项一起整理出来。',
                          'Collecting skills already installed on this machine, along with enabled and deprecated ones.')}
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
                            <span className={`${styles.skillSource} ${styles.skillStatusEnabled}`}>{L('已启用', 'Enabled')}</span>
                          ) : (
                            <span className={`${styles.skillSource} ${styles.skillStatusInstalled}`}>
                              {skill.hidden ? L('已安装（已弃用）', 'Installed (deprecated)') : L('已安装', 'Installed')}
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
                      <div className={styles.capabilityNoticeTitle}>
                        {L('暂时没读到已安装技能', 'Could not load installed skills yet')}
                      </div>
                      <div className={styles.capabilityNoticeText}>
                        {L('我会自动重试读取本机技能。你也可以先看下面的推荐技能，点一下即可安装或启用。',
                          'I will retry automatically. In the meantime you can browse the recommendations below and install or enable one with a click.')}
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
                    {showAllInstalled
                      ? L('收起', 'Show less')
                      : L(`显示更多 (${installedSkills.length - 8})`, `Show more (${installedSkills.length - 8})`)}
                  </button>
                )}
              </div>

              <div className={styles.skillsBlock}>
                <div className={styles.skillsBlockHeader}>
                  <span>{L('推荐技能', 'Recommended skills')}</span>
                  <div className={styles.skillSortTabs}>
                    <button
                      type="button"
                      className={`${styles.skillSortTab}${sortMode === 'score' ? ` ${styles.skillSortTabActive}` : ''}`}
                      onClick={() => setSortMode('score')}
                    >
                      {L('综合评分', 'By score')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.skillSortTab}${sortMode === 'downloads' ? ` ${styles.skillSortTabActive}` : ''}`}
                      onClick={() => setSortMode('downloads')}
                    >
                      {L('下载推荐', 'By downloads')}
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
                      {categoryLabel(item, zh)}
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
                            <span className={styles.recommendedCategory}>{categoryLabel(entry.category, zh)}</span>
                          </div>
                          <div className={styles.skillCardDesc}>
                            {shortDescription(entry.description)
                              || L('点击即可启用，之后 Lynn 会在合适时机自动使用它。',
                                'One click enables it; Lynn will use it automatically when it fits.')}
                          </div>
                          <div className={styles.recommendedHint}>{recommendedSkillHint(entry, zh)}</div>
                        </div>
                        <button
                          type="button"
                          className={`${styles.recommendedActionBtn}${entry.skill?.enabled ? ` ${styles.recommendedActionBtnDone}` : ''}`}
                          disabled={busySkill === busyKey}
                          onClick={() => void handleRecommendedClick(entry)}
                        >
                          {busySkill === busyKey
                            ? L('处理中…', 'Working…')
                            : entry.skill?.enabled
                              ? L('已启用', 'Enabled')
                              : entry.skill
                                ? L('启用', 'Enable')
                                : entry.builtin
                                  ? L('安装', 'Install')
                                  : L('去镜像站', 'Open mirror')}
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
                    {L('打开腾讯 SkillHub', 'Open Tencent SkillHub')}
                  </button>
                  <button
                    type="button"
                    className={styles.capabilityLinkBtn}
                    onClick={() => window.platform?.openSettings?.('skills')}
                  >
                    {L('打开完整技能库', 'Open the full skill library')}
                  </button>
                </div>
              </div>
          </>
        </div>
      </div>
    </div>
  );
}
