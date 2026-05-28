import type { ModelOption } from './types';

export function resolveJobModelValue(modelRef: string | undefined, options: ModelOption[]): string {
  const raw = String(modelRef || '').trim();
  if (!raw) return '';
  const exact = options.find((option) => option.value === raw);
  if (exact) return exact.value;
  const byRawId = options.find((option) => option.rawId === raw);
  return byRawId?.value || raw;
}

export function folderLabel(folderPath: string | null): string {
  if (!folderPath) return '';
  const parts = folderPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}
