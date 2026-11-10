import { lazy, useEffect, useMemo, useState } from 'react';
import { createLiveDataSource } from '@selarikru/data-source-live';
import { EmailAuthProvider, reauthenticateWithCredential, signOut } from 'firebase/auth';
import { RestrictedDraftHold, type InferenceMode } from '@selarikru/inference-firebase-web';
import { AuthGate } from '../auth/AuthGate.tsx';
import { OnboardingView } from '../features/onboarding/OnboardingView.tsx';
import { canReauthenticateWithPassword, reauthOutcomeOf, type ReauthOutcome } from '../features/onboarding/reauth.ts';
import { createOnboardingApi } from '../features/onboarding/index.ts';
import { createApiClient } from '../features/assistant/api.ts';
import { auth, createAdapter, getOwnerToken, usingAuthEmulator } from '../firebase.ts';
import { AppShell, type AccountInfo } from './AppShell.tsx';
import { createProjectionStore, type Scheduler } from './projection-store.ts';
import { NO_PROJECT, projectFromUrl, useActiveProject } from './active-project.ts';

// Its own chunk, so a failed load is caught by the route's boundary inside the shell.
const AssistantPanel = lazy(() => import('../features/assistant/AssistantPanel.tsx').then((m) => ({ default: m.AssistantPanel })));

const every: Scheduler = (fn, ms) => {
  const id = window.setInterval(fn, ms);
  return () => window.clearInterval(id);
};

/** Re-authenticates the signed-in owner in place: the same account, so the app is not remounted and nothing typed is lost. */
const signInAgain = {
  get email() { return auth.currentUser?.email ?? null; },
  get canUsePassword() { return canReauthenticateWithPassword(auth.currentUser); },
  signOut: () => void signOut(auth),
  /** The password goes to Firebase Auth and nowhere else: it is not kept in state, logged or stored. */
  async reauthenticate(password: string): Promise<ReauthOutcome> {
    const user = auth.currentUser;
    if (!user?.email) return 'failed';
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      await user.getIdToken(true);
      return 'ok';
    } catch (error) {
      return reauthOutcomeOf(error);
    }
  },
};

function App({ account }: { account: AccountInfo }) {
  const adapter = useMemo(createAdapter, []);
  const hold = useMemo(() => new RestrictedDraftHold(), []);
  // The local default exists only in dev. A hosted build with no URL has no handoff.
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');
  const api = useMemo(() => (baseUrl ? createApiClient({ baseUrl, getToken: getOwnerToken }) : null), [baseUrl]);
  const onboardingApi = useMemo(() => (baseUrl ? createOnboardingApi({ baseUrl, getToken: getOwnerToken }) : null), [baseUrl]);
  // A project set up here opens with `?project=`, and activating a setup on this page opens it in place. The env defaults still serve the seeded `dev:demo` and `dev:real` stacks.
  const { projectId, activate } = useActiveProject(projectFromUrl() || (import.meta.env.VITE_DEMO_PROJECT_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_PROJECT_ID as string | undefined) || '');
  const defaults = {
    projectId,
    runId: (import.meta.env.VITE_DEMO_RUN_ID as string | undefined) || (import.meta.env.VITE_DEFAULT_RUN_ID as string | undefined) || '',
  };
  // No URL or project configured means no source: the shell then says data is unavailable. It never shows mock data.
  const store = useMemo(() => createProjectionStore({ source: baseUrl && defaults.projectId ? createLiveDataSource({ baseUrl, getToken: getOwnerToken }) : null, projectId: defaults.projectId, clock: { nowMs: () => Date.now() }, every }), [baseUrl, defaults.projectId]);
  useEffect(() => {
    store.getState().start();
    return () => store.getState().stop();
  }, [store]);
  // A project set up here keeps the assistant route chosen for it.
  const [recordedMode, setRecordedMode] = useState<InferenceMode | null>(null);
  useEffect(() => {
    if (!onboardingApi || !defaults.projectId) return;
    let live = true;
    void onboardingApi.get(defaults.projectId).then((r) => { if (live) setRecordedMode(r.ok ? (r.value.execution?.inference ?? null) : null); });
    return () => { live = false; };
  }, [onboardingApi, defaults.projectId]);
  // With nothing to show yet, a first-time visitor lands on the guide rather than an empty office.
  useEffect(() => {
    if (!defaults.projectId && !window.location.hash) window.location.hash = '#/onboarding';
  }, [defaults.projectId]);
  return <AppShell store={store} mode="live" projectLabel={defaults.projectId || NO_PROJECT} account={account} assistant={<AssistantPanel adapter={adapter} api={api} hold={hold} defaults={defaults} recordedMode={recordedMode} />} onboarding={<OnboardingView api={onboardingApi} adapter={adapter} hold={hold} mode="live" onActivated={activate} signInAgain={signInAgain} />} />;
}

export default function LiveRoot() {
  return (
    <AuthGate auth={auth} emulator={usingAuthEmulator}>
      {(user) => <App key={user.uid} account={{ label: user.email ?? user.uid, onSignOut: () => void signOut(auth) }} />}
    </AuthGate>
  );
}
