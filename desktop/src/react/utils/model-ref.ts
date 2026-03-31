export interface ModelRef {
  id: string;
  provider: string;
}

export function parseSharedModelRef(ref: unknown): ModelRef {
  if (!ref) return { id: '', provider: '' };

  if (typeof ref === 'object' && ref !== null && 'id' in ref) {
    const value = ref as { id?: unknown; provider?: unknown };
    return {
      id: typeof value.id === 'string' ? value.id : String(value.id || ''),
      provider: typeof value.provider === 'string' ? value.provider : '',
    };
  }

  if (typeof ref === 'string') {
    return { id: ref, provider: '' };
  }

  return { id: String(ref), provider: '' };
}
