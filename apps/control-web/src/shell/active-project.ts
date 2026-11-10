import { useCallback, useState } from 'react';

/** What the header says when no project is open. */
export const NO_PROJECT = 'No project selected';

/** The project this page is open on, from `?project=`. */
export const projectFromUrl = (): string => new URLSearchParams(window.location.search).get('project') ?? '';

/**
 * The open project, which onboarding can set once a setup is activated: the address gains `?project=` in place, with the route and its hash kept, so the header
 * names the project and a reload opens the same one.
 */
export function useActiveProject(initial: string): { readonly projectId: string; readonly activate: (projectId: string) => void } {
  const [projectId, setProjectId] = useState(initial);
  const activate = useCallback((id: string) => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('project') !== id) {
      url.searchParams.set('project', id);
      window.history.replaceState(window.history.state, '', url);
    }
    setProjectId((current) => (current === id ? current : id));
  }, []);
  return { projectId, activate };
}
