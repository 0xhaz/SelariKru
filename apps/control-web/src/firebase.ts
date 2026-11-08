import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { FirebaseHybridAssistantAdapter, createFirebaseSdk } from '@selarikru/inference-firebase-web';

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
export function createAdapter(): FirebaseHybridAssistantAdapter {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
  return new FirebaseHybridAssistantAdapter({ sdk: createFirebaseSdk({ app, recaptchaSiteKey: siteKey || undefined }) });
}

export const getOwnerToken = async (): Promise<string> => {
  const user = auth.currentUser;
  if (!user) throw new Error('not signed in');
  return user.getIdToken();
};
