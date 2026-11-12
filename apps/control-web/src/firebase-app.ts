import { initializeApp, type FirebaseApp } from 'firebase/app';
import { firebaseConfigFromEnv } from './build/hosted.ts';

/**
 * H9: the Firebase app, from the `VITE_FIREBASE_*` env variables (names in .env.example). A production build without them fails at build time (build/hosted.ts).
 * In dev only, a placeholder stands in so the Auth Emulator stack starts with no config; AI calls then need the real values in a local, git-ignored .env.
 */
// Each name read on its own, so a build inlines these values and no other env value.
const fromEnv = firebaseConfigFromEnv({
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  VITE_FIREBASE_STORAGE_BUCKET: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  VITE_FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
});
const DEV_PLACEHOLDER = { apiKey: 'dev-placeholder-not-a-key', authDomain: 'localhost', projectId: 'selarikru', storageBucket: '', messagingSenderId: '', appId: 'dev-placeholder' };

export const firebaseConfigured = fromEnv !== null;
export const app: FirebaseApp = initializeApp(fromEnv ?? (import.meta.env.DEV ? DEV_PLACEHOLDER : (() => { throw new Error('The Firebase web config is missing: set the VITE_FIREBASE_* variables listed in .env.example.'); })()));
