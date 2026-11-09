import { signBody } from '@selarikru/integrations-github';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, RUN, bearer, get, makeHarness, owner, post, resetDb, setupTestDb, type Harness, type TestDb } from './helpers.ts';

const SECRET = 'whsec_route_test_secret';
let t: TestDb;
let h: Harness;

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t, {}, undefined, { github: { webhookSecret: SECRET } });
  await h.app.ready();
});
afterAll(async () => { await h.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`UPDATE projects SET repository = 'acme/feedback-board'`);
});

const body = Buffer.from(JSON.stringify({ action: 'closed', number: 4, repository: { full_name: 'acme/feedback-board' }, pull_request: { merged: true } }));
const send = (raw: Buffer, headers: Record<string, string>) => h.app.inject({ method: 'POST', url: '/v1/webhooks/github', payload: raw, headers: { 'content-type': 'application/json', ...headers } });
const deliveries = async () => [...(await t.db.execute(sql`SELECT delivery_id, status FROM integration_deliveries`))];

describe('POST /v1/webhooks/github', () => {
  it('verifies the signature over the raw bytes and queues a hint without touching state', async () => {
    const ok = await send(body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'del-1', 'x-hub-signature-256': signBody(SECRET, body) });
    expect(ok.statusCode).toBe(202);
    expect(await deliveries()).toEqual([{ delivery_id: 'del-1', status: 'received' }]);
    const dup = await send(body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'del-1', 'x-hub-signature-256': signBody(SECRET, body) });
    expect(dup.statusCode).toBe(200);
    expect(await deliveries()).toHaveLength(1);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM events`))[0]!['n'])).toBe(0);
  });

  it('rejects unsigned, mis-signed and unknown deliveries', async () => {
    expect((await send(body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'a' })).statusCode).toBe(401);
    expect((await send(body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'b', 'x-hub-signature-256': signBody('nope', body) })).statusCode).toBe(401);
    expect((await send(body, { 'x-github-event': 'push', 'x-github-delivery': 'c', 'x-hub-signature-256': signBody(SECRET, body) })).statusCode).toBe(422);
    expect(await deliveries()).toEqual([]);
  });

  it('is not registered without a configured secret', async () => {
    const plain = makeHarness(t);
    const res = await plain.app.inject({ method: 'POST', url: '/v1/webhooks/github', payload: body, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(404);
    await plain.app.close();
  });

  it('the public API exposes no merge', async () => {
    const urls = h.app.routeTable.map((r) => `${r.method} ${r.url}`);
    expect(urls.filter((u) => /merge/i.test(u))).toEqual([]);
    expect(urls).toContain('POST /v1/webhooks/github');
    // Nothing under pulls/merge style paths answers on any verb.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await h.app.inject({ method, url: `/v1/runs/${RUN}/merge`, headers: owner(), payload: {} });
      expect(res.statusCode).toBe(404);
    }
    void bearer; void get; void post; void PROJECT;
  });
});
