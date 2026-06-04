/**
 * SessionList pure helpers — workspace-path normalization, session grouping by
 * workspace, time parsing, provider label, fallback yuan. Extracted from
 * SessionList.tsx (GUI monolith decomposition). No React/hooks/JSX — pure over
 * the shared Session type, so unit-testable in isolation.
 */

import type { Session } from '../types';

export interface WorkspaceSessionsGroup {
  key: string;
  kind: 'agent' | 'workspace';
  title: string;
  path: string | null;
  latestModified: number;
  items: Session[];
}

export function parseModifiedTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeLegacyWorkspacePath(cwd: string | null | undefined): string | null {
  const raw = String(cwd || '').trim();
  if (!raw) return null;
  const oldRoot = '/Users/lynn/openhanako';
  const newRoot = '/Users/lynn/Lynn';
  if (raw === oldRoot || raw.startsWith(`${oldRoot}/`)) {
    return raw.replace(oldRoot, newRoot);
  }
  return raw;
}

export function formatWorkspaceTitle(cwd: string | null, fallbackName: string): string {
  const normalized = normalizeLegacyWorkspacePath(cwd);
  if (!normalized) return fallbackName;
  const dirName = normalized.split('/').filter(Boolean).pop();
  return dirName || fallbackName;
}

export function groupSessionsByWorkspace(sessions: Session[], fallbackName: string): WorkspaceSessionsGroup[] {
  const groups = new Map<string, WorkspaceSessionsGroup>();

  for (const session of sessions) {
    const normalizedCwd = normalizeLegacyWorkspacePath(session.cwd);
    const key = normalizedCwd ? `cwd:${normalizedCwd}` : 'cwd:agent-root';
    const existing = groups.get(key);
    const modifiedAt = parseModifiedTime(session.modified);
    if (existing) {
      existing.items.push(session);
      existing.latestModified = Math.max(existing.latestModified, modifiedAt);
      continue;
    }
    groups.set(key, {
      key,
      kind: normalizedCwd ? 'workspace' : 'agent',
      title: formatWorkspaceTitle(normalizedCwd, fallbackName),
      path: normalizedCwd,
      latestModified: modifiedAt,
      items: [session],
    });
  }

  const result = [...groups.values()];
  result.sort((a, b) => {
    if (a.kind === 'agent' && b.kind !== 'agent') return -1;
    if (b.kind === 'agent' && a.kind !== 'agent') return 1;
    if (b.latestModified !== a.latestModified) return b.latestModified - a.latestModified;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  for (const group of result) {
    group.items.sort((a, b) => {
      const pinDelta = Number(!!b.pinned) - Number(!!a.pinned);
      if (pinDelta !== 0) return pinDelta;
      return parseModifiedTime(b.modified) - parseModifiedTime(a.modified);
    });
  }

  return result;
}

export function formatProviderLabel(provider?: string | null): string {
  if (!provider) return '';
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function inferSessionFallbackYuan(agentName?: string | null): string {
  const normalized = String(agentName || '').trim().toLowerCase();
  if (normalized.includes('hanako') || normalized.includes('花子')) return 'hanako';
  if (normalized.includes('butter')) return 'butter';
  if (normalized.includes('kong')) return 'kong';
  return 'lynn';
}
