import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFirebaseVerifier } from '../src/index.ts';
import { buildApp } from '../src/index.ts';
import { createScheduler } from '@selarikru/workflow';
import { startAuthEmulator, type AuthEmulator } from './auth-emulator.ts';
import { API_POLICY, PROJECT, resetDb, setupTestDb, testClock, testConfig, type TestDb } from './helpers.ts';

/**
 * Runs the production verifier (firebase-admin, project `selarikru`) against the Firebase Auth Emulator.
 * Uses FIREBASE_AUTH_EMULATOR_HOST when set (pnpm dev:stack), otherwise starts the emulator through the firebase CLI.
 * The Auth Emulator is pure JavaScript, so no Java is needed. Skipped, visibly, only when no CLI is installed.
 */
const hasCli = spawnSync('firebase', ['--version'], { stdio: 'ignore' }).status === 0;
const external = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
const runnable = Boolean(external) || hasCli;

// Own project ID, so this file's emulator never shares a hub locator with another test file's. An external emulator (pnpm dev:stack) keeps its own.
const PROJECT_ID = external ? 'selarikru' : 'selarikru-auth-test';

async function waitUp(host: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(`http://${host}/`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error('Auth Emulator did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function signUp(host: string, email: string): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-1', returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

describe.skipIf(!runnable)('Firebase Auth Emulator', () => {
  let emulator: AuthEmulator | undefined;
  let host = external ?? '';
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
    if (!external) {
      emulator = await startAuthEmulator(PROJECT_ID);
      host = emulator.host;
    }
    if (external) await waitUp(host);
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = host;
  }, 90_000);

  afterAll(async () => {
    emulator?.stop();
    if (!external) delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    await t?.close();
  });

  it('verifies a real emulator-issued ID token with firebase-admin and enforces the single owner', async () => {
    const verifier = createFirebaseVerifier({ projectId: PROJECT_ID });
    const alice = await signUp(host, `alice-${Date.now()}@example.test`);
    const mallory = await signUp(host, `mallory-${Date.now()}@example.test`);

    expect(await verifier.verifyToken(alice.idToken)).toEqual({ uid: alice.uid });
    await expect(verifier.verifyToken('not.a.token')).rejects.toThrow();
    await expect(verifier.verifyToken(`${alice.idToken}x`)).rejects.toThrow();

    await resetDb(t.db);
    const clock = testClock();
    const app = buildApp({
      config: testConfig({ ownerUid: alice.uid }), db: t.db, verifier, now: clock.now,
      scheduler: createScheduler({ db: t.db, now: clock.now }), policy: API_POLICY,
    });
    const url = `/v1/projects/${PROJECT}/snapshot`;
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${alice.idToken}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${mallory.idToken}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer forged' } })).statusCode).toBe(401);
    await app.close();
  }, 60_000);
});
