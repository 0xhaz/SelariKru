import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOnboardingApi } from './api.ts';

const fail = (code: string): Error => Object.assign(new Error(code), { code });
const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('onboarding api errors', () => {
  it('a sign-in that can no longer give a token says to sign in again, not that the server is unreachable, and sends nothing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const code of ['auth/no-current-user', 'auth/user-token-expired', 'auth/user-disabled']) {
      const api = createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => { throw fail(code); } });
      const r = await api.list();
      expect(r).toMatchObject({ ok: false, code: 'unauthenticated' });
      if (!r.ok) {
        expect(r.message).toMatch(/sign in again/i);
        expect(r.message).not.toMatch(/could not reach/i);
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the server refusing the sign-in also says to sign in again', async () => {
    vi.stubGlobal('fetch', respond(401, { error: { code: 'invalid_token', message: 'token is not valid' } }));
    const r = await createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => 'expired' }).get('p');
    expect(r).toMatchObject({ ok: false, status: 401, code: 'invalid_token' });
    if (!r.ok) expect(r.message).toMatch(/sign in again/i);
  });

  it('an account that is not the owner is told so, not that its sign-in expired', async () => {
    vi.stubGlobal('fetch', respond(403, { error: { code: 'not_owner', message: 'not the owner' } }));
    const r = await createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => 't' }).list();
    expect(r).toMatchObject({ ok: false, code: 'not_owner' });
    if (!r.ok) {
      expect(r.message).toMatch(/not the project owner/);
      expect(r.message).not.toMatch(/expired/);
    }
  });

  it('a token refresh that failed for the network, and a fetch that failed, are still unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const down = await createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => 't' }).list();
    expect(down).toMatchObject({ ok: false, code: 'network_error' });
    const offline = await createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => { throw fail('auth/network-request-failed'); } }).list();
    expect(offline).toMatchObject({ ok: false, code: 'network_error' });
    if (!offline.ok) expect(offline.message).toMatch(/could not reach/i);
  });

  it('other refusals keep the server\'s own words', async () => {
    vi.stubGlobal('fetch', respond(409, { error: { code: 'stale_revision', message: 'revision moved' } }));
    const r = await createOnboardingApi({ baseUrl: 'http://api.test', getToken: async () => 't' }).get('p');
    expect(r).toMatchObject({ ok: false, status: 409, code: 'stale_revision', message: 'revision moved' });
  });
});
