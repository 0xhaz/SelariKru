import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectivity, isOnline } from './features/checkpoints/connectivity.ts';
import { FirebaseHybridAssistantAdapter, createFirebaseSdk, type FetchRoute } from '@selarikru/inference-firebase-web';

// Public web client config (not a secret), as in spikes/firebase-hybrid.
const firebaseConfig = {
  projectId: 'selarikru',
  appId: '1:808736999784:web:991baa74a0aa41bae6eedd',
  storageBucket: 'selarikru.firebasestorage.app',
  apiKey: 'AIzaSyBEMbdymrhgD-OT2TBYlw8huB5D-BLTSyQ',
  authDomain: 'selarikru.firebaseapp.com',
  messagingSenderId: '808736999784',
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Auth Emulator in dev (pnpm dev:stack). Hosted builds go to Firebase Auth by the same code path.
export const usingAuthEmulator = import.meta.env.DEV;
if (usingAuthEmulator) {
  connectAuthEmulator(auth, (import.meta.env.VITE_AUTH_EMULATOR_URL as string | undefined) || 'http://127.0.0.1:9099', { disableWarnings: true });
}

/** App Check (reCAPTCHA Enterprise) is set up inside createFirebaseSdk; the debug provider exists only when import.meta.env.DEV. */
/**
 * `fetchRoute` reads a task's route fresh before every AI call that names a task: the live data source's `getTaskRoute` (LiveRoot wires it). With no source there is
 * none, and a call that names a task is blocked (`route_fetch_failed`); calls that name no task, such as onboarding drafts, are unaffected. Where each call ran is
 * reported through the `route.report` command by the task agents (features/hybrid/agents.ts).
 */
export function createAdapter(fetchRoute: FetchRoute = async () => { throw new Error('no task route source is wired'); }): FirebaseHybridAssistantAdapter {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
  // H12: a call that needs the cloud while this browser is offline waits as a checkpoint instead of being sent.
  return new FirebaseHybridAssistantAdapter({ sdk: createFirebaseSdk({ app, recaptchaSiteKey: siteKey || undefined }), fetchRoute, isOnline, onNetworkFailure: () => connectivity.getState().reportNetworkFailure() });
}

export const getOwnerToken = async (): Promise<string> => {
  const user = auth.currentUser;
  // Firebase's own code for this state, so callers read one vocabulary.
  if (!user) throw Object.assign(new Error('not signed in'), { code: 'auth/no-current-user' });
  return user.getIdToken();
};
