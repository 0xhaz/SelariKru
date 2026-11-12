import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { CONTENT_SECURITY_POLICY } from './csp.ts';

/**
 * H9: the hosted demo's bundle, built for real with placeholder env (never a real key, id or site key). It must hold no demo SDK, no App Check debug token
 * code of ours, no web API key, and no env value it does not use.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLACEHOLDER: Record<string, string> = {
  VITE_FIREBASE_API_KEY: 'placeholder-api-key', VITE_FIREBASE_AUTH_DOMAIN: 'placeholder.example.invalid', VITE_FIREBASE_PROJECT_ID: 'placeholder-project',
  VITE_FIREBASE_STORAGE_BUCKET: 'placeholder.example.invalid', VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000', VITE_FIREBASE_APP_ID: '1:000000000000:web:placeholder',
  VITE_RECAPTCHA_SITE_KEY: 'placeholder-site-key',
  // An env value the hosted demo does not use: it must not be inlined.
  VITE_AUTH_EMULATOR_URL: 'http://canary-unused.example.invalid',
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function buildWith(mode: 'hosted' | 'production', env: Record<string, string>): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'selarikru-h9-'));
  dirs.push(outDir);
  const saved = { ...process.env };
  // Vitest runs with NODE_ENV=test, which Vite would read as a development build; the bundle is checked as the production build it is.
  Object.assign(process.env, { ...env, NODE_ENV: 'production' });
  try {
    await build({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), mode, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    for (const k of [...Object.keys(env), 'NODE_ENV']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return outDir;
}
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(js|html)$/.test(e.name)).map((e) => join(e.parentPath, e.name));
const text = (dir: string): string => files(dir).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('H9: the hosted demo bundle', () => {
  it('has the real SDK and demo data, and none of: the demo SDK, our debug-token code, a web API key, the live root, an unused env value', async () => {
    const all = text(await buildWith('hosted', PLACEHOLDER));
    // Demo data and the hosted root are in it.
    expect(all).toContain('healthy-parallel-work');
    expect(all).toContain('Cloud calls left in this demo');
    // The demo SDK (features/hybrid/demo-sdk.ts) is not: none of its canned answers.
    expect(all).not.toContain('Demo brief: the task as written');
    expect(all).not.toContain('demo-proposal.ts');
    // Our App Check debug-token switch is not (the SDK itself only reads the global, which nothing here sets).
    expect(all).not.toMatch(/FIREBASE_APPCHECK_DEBUG_TOKEN\s*=[^=]/);
    // No web API key literal (a redaction pattern for one is not a key).
    expect(all).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    // No live root, no Auth Emulator, and no env value the build does not read.
    expect(all).not.toContain('connectAuthEmulator');
    expect(all).not.toContain('canary-unused.example.invalid');
    // H9 fix round 1 (H1): coding workers are off in the hosted demo: no Claude catalog or assignment is in its data.
    expect(all).not.toContain('claude-sonnet-5-5');
    expect(all).not.toMatch(/['"`]anthropic['"`]/);
  }, 240_000);

  it('carries the Content-Security-Policy in its page', async () => {
    const dir = await buildWith('hosted', PLACEHOLDER);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(`<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`);
  }, 240_000);

  it('fails without its env', async () => {
    const empty = Object.fromEntries(Object.keys(PLACEHOLDER).map((k) => [k, '']));
    await expect(buildWith('hosted', { ...empty })).rejects.toThrow(/VITE_RECAPTCHA_SITE_KEY|VITE_FIREBASE_API_KEY/);
    await expect(buildWith('hosted', { ...PLACEHOLDER, VITE_RECAPTCHA_SITE_KEY: '' })).rejects.toThrow(/VITE_RECAPTCHA_SITE_KEY/);
    await expect(buildWith('hosted', { ...PLACEHOLDER, VITE_FIREBASE_APP_ID: '' })).rejects.toThrow(/VITE_FIREBASE_APP_ID/);
  }, 240_000);

  it('the real build has no demo data and no hosted root', async () => {
    const all = text(await buildWith('production', PLACEHOLDER));
    expect(all).not.toContain('healthy-parallel-work');
    // The hosted root's local review of the guide's answer (features/onboarding/demo-api.ts) is not in it.
    expect(all).not.toContain('selarikru.hosted-cloud-calls');
    expect(all).not.toContain('Demo brief: the task as written');
  }, 240_000);
});
