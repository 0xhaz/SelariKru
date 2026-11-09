import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { AssistantPanel, createApiClient } from './features/assistant/index.ts';
import type { EngineeringDataSource } from '@selarikru/view-protocol';
import { AuthGate } from './auth/AuthGate.tsx';
import { DemoBadge } from './data-source/DemoBadge.tsx';
import { loadDemoDataSource } from './data-source/demo.ts';
import { auth, createAdapter, getOwnerToken, usingAuthEmulator } from './firebase.ts';
import './index.css';

function App() {
  const adapter = useMemo(createAdapter, []);
  const hold = useMemo(() => new RestrictedDraftHold(), []);
  // The local default exists only in dev. A hosted build with no URL has no handoff.
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
  const api = useMemo(() => (baseUrl ? createApiClient({ baseUrl, getToken: getOwnerToken }) : null), [baseUrl]);
  const defaults = {
    projectId: (import.meta.env.VITE_DEMO_PROJECT_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_PROJECT_ID as string | undefined) || '',
    runId: (import.meta.env.VITE_DEMO_RUN_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_RUN_ID as string | undefined) || '',
  };
  // Demo data is opt-in (`?demo`) and exists only in dev builds: loadDemoDataSource returns null in production.
  const [demo, setDemo] = useState<EngineeringDataSource | null>(null);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('demo')) return;
    let source: EngineeringDataSource | null = null;
    let cancelled = false;
    void loadDemoDataSource().then((s) => {
      if (cancelled) return s?.disconnect();
      source = s;
      setDemo(s);
    });
    return () => {
      cancelled = true;
      source?.disconnect();
    };
  }, []);
  return (
    <>
      {demo ? <DemoBadge source={demo} /> : null}
      <AssistantPanel adapter={adapter} api={api} hold={hold} defaults={defaults} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate auth={auth} emulator={usingAuthEmulator}>{() => <App />}</AuthGate>
  </StrictMode>,
);
