import { lazy, useEffect, useMemo } from 'react';
import { createLiveDataSource } from '@selarikru/data-source-live';
import { signOut } from 'firebase/auth';
import { RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { AuthGate } from '../auth/AuthGate.tsx';
import { createApiClient } from '../features/assistant/api.ts';
import { auth, createAdapter, getOwnerToken, usingAuthEmulator } from '../firebase.ts';
import { AppShell, type AccountInfo } from './AppShell.tsx';
import { createProjectionStore, type Scheduler } from './projection-store.ts';

// Its own chunk, so a failed load is caught by the route's boundary inside the shell.
const AssistantPanel = lazy(() => import('../features/assistant/AssistantPanel.tsx').then((m) => ({ default: m.AssistantPanel })));

const every: Scheduler = (fn, ms) => {
  const id = window.setInterval(fn, ms);
  return () => window.clearInterval(id);
};

function App({ account }: { account: AccountInfo }) {
  const adapter = useMemo(createAdapter, []);
  const hold = useMemo(() => new RestrictedDraftHold(), []);
  // The local default exists only in dev. A hosted build with no URL has no handoff.
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
  const api = useMemo(() => (baseUrl ? createApiClient({ baseUrl, getToken: getOwnerToken }) : null), [baseUrl]);
  const defaults = {
    projectId: (import.meta.env.VITE_DEMO_PROJECT_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_PROJECT_ID as string | undefined) || '',
    runId: (import.meta.env.VITE_DEMO_RUN_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_RUN_ID as string | undefined) || '',
  };
  // No URL or project configured means no source: the shell then says data is unavailable. It never shows mock data.
  const store = useMemo(() => createProjectionStore({ source: baseUrl && defaults.projectId ? createLiveDataSource({ baseUrl, getToken: getOwnerToken }) : null, projectId: defaults.projectId, clock: { nowMs: () => Date.now() }, every }), [baseUrl, defaults.projectId]);
  useEffect(() => {
    store.getState().start();
    return () => store.getState().stop();
  }, [store]);
  return <AppShell store={store} mode="live" projectLabel={defaults.projectId || 'No project selected'} account={account} assistant={<AssistantPanel adapter={adapter} api={api} hold={hold} defaults={defaults} />} />;
}

export default function LiveRoot() {
  return (
    <AuthGate auth={auth} emulator={usingAuthEmulator}>
      {(user) => <App key={user.uid} account={{ label: user.email ?? user.uid, onSignOut: () => void signOut(auth) }} />}
    </AuthGate>
  );
}
