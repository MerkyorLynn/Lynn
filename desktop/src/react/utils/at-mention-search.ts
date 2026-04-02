import type { WorkingSetFile } from '../stores/input-slice';

export interface AtMentionFileResult {
  name: string;
  path: string;
  rel: string;
  isDir: boolean;
}

interface RankedAtMentionFileResult extends AtMentionFileResult {
  relevance: number;
  recentIndex: number;
  fromSearch: boolean;
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function buildRelativePath(path: string, basePath?: string | null): string {
  if (!basePath) return normalizeSeparators(path);

  const normalizedPath = normalizeSeparators(path);
  const normalizedBase = normalizeSeparators(basePath).replace(/\/$/, '');

  if (normalizedPath === normalizedBase) return normalizedPath;
  if (normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath.slice(normalizedBase.length + 1);
  }

  return normalizedPath;
}

function hasTokenPrefix(value: string, query: string): boolean {
  return value.split(/[\\/._\-\s]+/).some((token) => token.startsWith(query));
}

function hasPathSegmentPrefix(value: string, query: string): boolean {
  const normalized = normalizeSeparators(value);
  return normalized.startsWith(query) || normalized.includes(`/${query}`);
}

function getRelevance(file: AtMentionFileResult, query: string): number | null {
  const lowerName = file.name.toLowerCase();
  const lowerRel = normalizeSeparators(file.rel.toLowerCase());
  const lowerPath = normalizeSeparators(file.path.toLowerCase());

  if (lowerName === query || lowerRel === query || lowerPath === query) return 0;
  if (lowerName.startsWith(query)) return 1;
  if (hasTokenPrefix(lowerName, query)) return 2;
  if (lowerRel.startsWith(query) || hasPathSegmentPrefix(lowerRel, query)) return 3;
  if (hasTokenPrefix(lowerRel, query) || hasTokenPrefix(lowerPath, query)) return 4;
  if (lowerName.includes(query)) return 5;
  if (lowerRel.includes(query) || lowerPath.includes(query)) return 6;

  return null;
}

function mergeCandidate(
  candidates: Map<string, RankedAtMentionFileResult>,
  file: AtMentionFileResult,
  query: string,
  recentIndex: number,
  fromSearch: boolean,
): void {
  const relevance = getRelevance(file, query);
  if (relevance === null) return;

  const key = normalizeSeparators(file.path);
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(key, {
      ...file,
      relevance,
      recentIndex,
      fromSearch,
    });
    return;
  }

  existing.relevance = Math.min(existing.relevance, relevance);
  existing.recentIndex = Math.min(existing.recentIndex, recentIndex);

  if (fromSearch && !existing.fromSearch) {
    existing.name = file.name;
    existing.rel = file.rel;
    existing.isDir = file.isDir;
    existing.fromSearch = true;
  }
}

function compareCandidates(a: RankedAtMentionFileResult, b: RankedAtMentionFileResult): number {
  if (a.relevance !== b.relevance) return a.relevance - b.relevance;
  if (a.recentIndex !== b.recentIndex) return a.recentIndex - b.recentIndex;
  if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
  const relOrder = a.rel.localeCompare(b.rel);
  if (relOrder !== 0) return relOrder;
  return a.path.localeCompare(b.path);
}

function recentFileToMentionResult(file: WorkingSetFile, basePath?: string | null): AtMentionFileResult {
  return {
    name: file.name,
    path: file.path,
    rel: buildRelativePath(file.path, basePath),
    isDir: !!file.isDirectory,
  };
}

export function buildAtMentionResults({
  query,
  searchResults,
  recentFiles,
  basePath,
}: {
  query: string;
  searchResults: AtMentionFileResult[];
  recentFiles: WorkingSetFile[];
  basePath?: string | null;
}): AtMentionFileResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const candidates = new Map<string, RankedAtMentionFileResult>();

  recentFiles.forEach((file, index) => {
    mergeCandidate(
      candidates,
      recentFileToMentionResult(file, basePath),
      normalizedQuery,
      index,
      false,
    );
  });

  searchResults.forEach((file) => {
    mergeCandidate(candidates, file, normalizedQuery, Number.POSITIVE_INFINITY, true);
  });

  return Array.from(candidates.values())
    .sort(compareCandidates)
    .map(({ relevance: _relevance, recentIndex: _recentIndex, fromSearch: _fromSearch, ...file }) => file);
}
