import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { GitContextSnapshot } from '../../utils/prompt-task';

interface UseGitContextArgs {
  deskBasePath: string | null | undefined;
  deskCurrentPath: string | null | undefined;
  pendingNewSession: boolean;
  selectedFolder: string | null | undefined;
}

export function useGitContext({
  deskBasePath,
  deskCurrentPath,
  pendingNewSession,
  selectedFolder,
}: UseGitContextArgs) {
  const [gitContext, setGitContext] = useState<GitContextSnapshot | null>(null);

  useEffect(() => {
    const dir = deskBasePath
      ? (deskCurrentPath ? `${deskBasePath}/${deskCurrentPath}` : deskBasePath)
      : (pendingNewSession ? selectedFolder : null);
    if (!dir) {
      setGitContext(null);
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ dir });
    hanaFetch(`/api/desk/git-context?${params.toString()}`)
      .then(r => r.json())
      .then((data) => {
        if (!cancelled) setGitContext(data?.available ? data : null);
      })
      .catch(() => {
        if (!cancelled) setGitContext(null);
      });

    return () => {
      cancelled = true;
    };
  }, [deskBasePath, deskCurrentPath, pendingNewSession, selectedFolder]);

  return gitContext;
}
