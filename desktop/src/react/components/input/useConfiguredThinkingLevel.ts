import { useEffect } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { ThinkingLevel } from '../../stores/model-slice';

export function useConfiguredThinkingLevel(setThinkingLevel: (level: ThinkingLevel) => void) {
  useEffect(() => {
    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch((err: unknown) => console.warn('[InputArea] load config failed', err));
  }, [setThinkingLevel]);
}
