import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp.ts';
import { FIREBASE_ENV_NAMES, firebaseConfigFromEnv, hostedEnvGuard, missingBuildEnv } from './hosted.ts';

/** Placeholders only: no real key, id or site key is ever used in a test. */
const PLACEHOLDER: Record<string, string> = {
  VITE_FIREBASE_API_KEY: 'placeholder-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'placeholder.example.invalid',
  VITE_FIREBASE_PROJECT_ID: 'placeholder-project',
  VITE_FIREBASE_STORAGE_BUCKET: 'placeholder.example.invalid',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:placeholder',
  VITE_RECAPTCHA_SITE_KEY: 'placeholder-site-key',
};

describe('H9: the Firebase web config comes from VITE_FIREBASE_* env variables', () => {
  it('names every field, and builds the config from them', () => {
    expect(FIREBASE_ENV_NAMES).toEqual(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID']);
    expect(firebaseConfigFromEnv(PLACEHOLDER)).toEqual({ apiKey: 'placeholder-api-key', authDomain: 'placeholder.example.invalid', projectId: 'placeholder-project', storageBucket: 'placeholder.example.invalid', messagingSenderId: '000000000000', appId: '1:000000000000:web:placeholder' });
  });

  it('is null when any of them is missing or blank', () => {
    expect(firebaseConfigFromEnv({ ...PLACEHOLDER, VITE_FIREBASE_APP_ID: ' ' })).toBeNull();
    expect(firebaseConfigFromEnv({})).toBeNull();
  });

  it('every name is listed in .env.example, with no value', () => {
    const example = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    for (const name of [...FIREBASE_ENV_NAMES, 'VITE_RECAPTCHA_SITE_KEY']) expect(example).toMatch(new RegExp(`^${name}=$`, 'm'));
  });

  it('the source holds no web API key literal', () => {
    for (const file of ['../firebase.ts', '../firebase-app.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    }
  });
});

describe('H9: the hosted build fails loudly without its env', () => {
  it('the hosted build needs the reCAPTCHA site key and every Firebase variable', () => {
    expect(missingBuildEnv(PLACEHOLDER, { hosted: true })).toEqual([]);
    expect(missingBuildEnv({ ...PLACEHOLDER, VITE_RECAPTCHA_SITE_KEY: '' }, { hosted: true })).toEqual(['VITE_RECAPTCHA_SITE_KEY']);
    expect(missingBuildEnv({ ...PLACEHOLDER, VITE_FIREBASE_API_KEY: undefined as never }, { hosted: true })).toEqual(['VITE_FIREBASE_API_KEY']);
    // The real build needs the Firebase config; App Check stays optional there, as before.
    expect(missingBuildEnv({ ...PLACEHOLDER, VITE_RECAPTCHA_SITE_KEY: '' }, { hosted: false })).toEqual([]);
    expect(missingBuildEnv({}, { hosted: false })).toEqual([...FIREBASE_ENV_NAMES]);
  });

  it('the guard plugin throws at build start with the missing names, and only on a build', () => {
    const plugin = hostedEnvGuard({ VITE_FIREBASE_PROJECT_ID: 'placeholder-project' }, { hosted: true });
    expect(plugin.apply).toBe('build');
    expect(() => (plugin.buildStart as () => void)()).toThrow(/VITE_RECAPTCHA_SITE_KEY.*VITE_FIREBASE_API_KEY|VITE_FIREBASE_API_KEY.*VITE_RECAPTCHA_SITE_KEY/s);
    expect(() => (hostedEnvGuard(PLACEHOLDER, { hosted: true }).buildStart as () => void)()).not.toThrow();
  });

  it('a hosted build is refused when a debug token is set for it', () => {
    expect(missingBuildEnv({ ...PLACEHOLDER, VITE_APPCHECK_DEBUG_TOKEN: 'x' }, { hosted: true })).toEqual(['VITE_APPCHECK_DEBUG_TOKEN must not be set']);
  });
});

describe('H9: Firebase Hosting config (hosting only, never deployed from here)', () => {
  const json = JSON.parse(readFileSync(new URL('../../../../firebase.json', import.meta.url), 'utf8')) as { hosting: { public: string; rewrites: unknown[]; headers: { source?: string; regex?: string; headers: { key: string; value: string }[] }[] } } & Record<string, unknown>;
  const rc = JSON.parse(readFileSync(new URL('../../../../.firebaserc', import.meta.url), 'utf8')) as { projects: { default: string } };
  // As Hosting matches a header rule: a glob `source` (extglob, as node:path matchesGlob reads it) or an RE2 `regex`.
  const headersFor = (path: string): Record<string, string> => Object.fromEntries(json.hosting.headers.filter((h) => (h.source !== undefined && matchesGlob(path, h.source)) || (h.regex !== undefined && new RegExp(h.regex).test(path))).flatMap((h) => h.headers).map((h) => [h.key, h.value]));

  it('is hosting only, serving the hosted build as a single-page app, for project selarikru', () => {
    expect(Object.keys(json)).toEqual(['hosting']);
    expect(json.hosting.public).toBe('apps/control-web/dist-hosted');
    expect(json.hosting.rewrites).toEqual([{ source: '**', destination: '/index.html' }]);
    expect(rc.projects.default).toBe('selarikru');
  });

  it('sends the security headers on every response, with a CSP that matches the page\'s meta CSP', () => {
    const all = headersFor('**');
    expect(all['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(all['X-Content-Type-Options']).toBe('nosniff');
    expect(all['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    // Allows nothing extra: every powerful feature is off.
    expect(all['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(all['Permissions-Policy']).toMatch(/microphone=\(\)/);
    expect(all['Permissions-Policy']).toMatch(/geolocation=\(\)/);
    expect(all['Permissions-Policy']).not.toMatch(/=\(self|=\*/);
  });

  it('caches hashed assets for a long time and never caches index.html, whichever path served it (the SPA rewrite)', () => {
    expect(headersFor('/assets/index-abc123.js')['Cache-Control']).toBe('public, max-age=31536000, immutable');
    for (const path of ['/', '/index.html', '/anything', '/a/b']) expect(headersFor(path)['Cache-Control']).toBe('no-cache');
    // The Hosting emulator showed its matcher does not match `/` with `**/!(*.*)`: the root has its own rule.
    expect(json.hosting.headers.find((h) => h.source === '/')?.headers).toEqual([{ key: 'Cache-Control', value: 'no-cache' }]);
  });

  it('H9 fix round 1 (H2): Hosting reads regex rules as RE2, which has no lookaround: none is used', () => {
    for (const h of json.hosting.headers) if (h.regex !== undefined) expect(h.regex).not.toMatch(/\(\?[=!<]/);
    expect(JSON.stringify(json)).not.toMatch(/\(\?[=!]/);
  });
});
