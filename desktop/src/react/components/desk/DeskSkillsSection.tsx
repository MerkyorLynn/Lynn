/**
 * DeskSkillsSection — 技能总览与开关
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './Desk.module.css';

const DESK_SKILLS_KEY = 'hana-desk-skills-collapsed';
const PRIORITY_LABELS = new Set(['Cursor', 'Codex', 'Claude Code', 'CodeBuddy', 'Agents']);

export function DeskSkillsSection() {
  const skills = useStore(state => state.deskSkills);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkills = useCallback(async () => {
    try {
      const response = await hanaFetch('/api/skills');
      const data = await response.json();
      const all = (data.skills || []) as Array<{
        name: string;
        enabled: boolean;
        hidden?: boolean;
        source?: string;
        externalLabel?: string | null;
        externalPriority?: number;
      }>;
      useStore.getState().setDeskSkills(
        all
          .filter(skill => !skill.hidden)
          .sort((left, right) => {
            const priorityDiff = (right.externalPriority || 0) - (left.externalPriority || 0);
            if (priorityDiff !== 0) return priorityDiff;
            const leftPreferred = left.externalLabel && PRIORITY_LABELS.has(left.externalLabel) ? 1 : 0;
            const rightPreferred = right.externalLabel && PRIORITY_LABELS.has(right.externalLabel) ? 1 : 0;
            if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
            return left.name.localeCompare(right.name, 'zh-Hans-CN');
          })
          .map(skill => ({
            name: skill.name,
            enabled: skill.enabled,
            source: skill.source,
            externalLabel: skill.externalLabel,
          })),
      );
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDeskSkills();
    window.__loadDeskSkills = loadDeskSkills;
    return () => {
      delete window.__loadDeskSkills;
    };
  }, [loadDeskSkills]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const previous = useStore.getState().deskSkills;
    const nextSkills = previous.map(skill => skill.name === name ? { ...skill, enabled: enable } : skill);
    useStore.getState().setDeskSkills(nextSkills);
    const enabledList = nextSkills.filter(skill => skill.enabled).map(skill => skill.name);
    try {
      const agentId = useStore.getState().currentAgentId || '';
      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      useStore.getState().setDeskSkills(previous);
    }
  }, []);

  const enabledCount = useMemo(
    () => skills.filter(skill => skill.enabled).length,
    [skills],
  );
  const t = window.t ?? ((key: string) => key);

  if (!loading && skills.length === 0) return null;

  return (
    <div className={styles.skillsSection}>
      <button className={styles.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.skills')}</span>
        <span className={styles.skillsCount}>{enabledCount}</span>
        <svg
          className={`${styles.skillsChevron}${collapsed ? '' : ` ${styles.skillsChevronOpen}`}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className={styles.skillsList}>
          {skills.map(skill => (
            <div className={styles.skillItem} key={skill.name}>
              <span className={styles.skillName}>{skill.name}</span>
              {skill.externalLabel && (
                <span className={styles.skillSource}>{skill.externalLabel}</span>
              )}
              <button
                className={`hana-toggle mini${skill.enabled ? ' on' : ''}`}
                onClick={() => toggleSkill(skill.name, !skill.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
