import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { AssistantPanel, createApiClient } from './features/assistant/index.ts';
import { AuthGate } from './auth/AuthGate.tsx';
import { auth, createAdapter, getOwnerToken, usingAuthEmulator } from './firebase.ts';
import './index.css';

function App() {
  const adapter = useMemo(createAdapter, []);
  const hold = useMemo(() => new RestrictedDraftHold(), []);
  // The local default exists only in dev. A hosted build with no URL has no handoff.
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
  const api = useMemo(() => (baseUrl ? createApiClient({ baseUrl, getToken: getOwnerToken }) : null), [baseUrl]);
  const defaults = {
    projectId: (import.meta.env.VITE_DEFAULT_PROJECT_ID as string | undefined) ?? '',
    runId: (import.meta.env.VITE_DEFAULT_RUN_ID as string | undefined) ?? '',
  };
  return <AssistantPanel adapter={adapter} api={api} hold={hold} defaults={defaults} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate auth={auth} emulator={usingAuthEmulator}>{() => <App />}</AuthGate>
  </StrictMode>,
);
