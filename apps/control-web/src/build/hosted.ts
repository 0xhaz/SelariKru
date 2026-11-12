import type { Plugin } from 'vite';

/**
 * H9: the Firebase web config and the hosted demo's build-time checks. The config is read from `VITE_FIREBASE_*` env variables (listed in `.env.example`), never
 * written in the source. A web config is not a secret, but a project's key is still kept out of the repository and the testing instructions (plan.md §11).
 *
 * Imported by vite.config.ts and by the app (firebase-app.ts): nothing here may import Node or Vite at run time.
 */
export const FIREBASE_ENV_NAMES = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID'] as const;

export interface FirebaseWebConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket: string;
  readonly messagingSenderId: string;
  readonly appId: string;
}

type Env = Readonly<Record<string, string | undefined>>;
const value = (env: Env, name: string): string => (typeof env[name] === 'string' ? env[name]!.trim() : '');

/** The web config, or null when any variable is missing or blank. */
export function firebaseConfigFromEnv(env: Env): FirebaseWebConfig | null {
  const [apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId] = FIREBASE_ENV_NAMES.map((n) => value(env, n));
  if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) return null;
  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
}

/**
 * What a production build is missing. Every build needs the Firebase config. The hosted demo also needs the reCAPTCHA Enterprise site key (App Check guards the
 * free-tier quota for the whole judging period), and refuses an App Check debug token: none is ever put in a hosted build.
 */
export function missingBuildEnv(env: Env, opts: { readonly hosted: boolean }): string[] {
  const missing: string[] = FIREBASE_ENV_NAMES.filter((n) => !value(env, n));
  if (opts.hosted && !value(env, 'VITE_RECAPTCHA_SITE_KEY')) missing.unshift('VITE_RECAPTCHA_SITE_KEY');
  if (opts.hosted && value(env, 'VITE_APPCHECK_DEBUG_TOKEN')) missing.push('VITE_APPCHECK_DEBUG_TOKEN must not be set');
  return missing;
}

/** Fails a production build that lacks its env, loudly and before anything is bundled. */
export function hostedEnvGuard(env: Env, opts: { readonly hosted: boolean }): Plugin {
  return {
    name: 'selarikru-build-env',
    apply: 'build',
    buildStart() {
      const missing = missingBuildEnv(env, opts);
      if (missing.length > 0) {
        throw new Error(`selarikru-build-env: the ${opts.hosted ? 'hosted demo' : 'production'} build needs ${missing.join(', ')}. Set them in the environment or a git-ignored .env file (names in .env.example).`);
      }
    },
  };
}
