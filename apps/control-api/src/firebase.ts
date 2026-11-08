import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { TokenVerifier } from './auth.ts';

/**
 * Verifies Firebase ID tokens. The same code runs locally against the Auth Emulator and hosted against production:
 * the SDK switches on FIREBASE_AUTH_EMULATOR_HOST by itself, and config loading refuses that variable in hosted mode.
 * There is deliberately no option here that skips verification.
 */
export function createFirebaseVerifier(options: { projectId: string }): TokenVerifier {
  const name = `selarikru-auth-${options.projectId}`;
  const app = getApps().find((a) => a.name === name) ?? initializeApp({ projectId: options.projectId }, name);
  const auth = getAuth(app);
  return {
    async verifyToken(idToken) {
      const decoded = await auth.verifyIdToken(idToken);
      return { uid: decoded.uid };
    },
  };
}
