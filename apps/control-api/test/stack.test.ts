import net from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDS_READER_VERSION, refreshBrains } from '../src/brain.ts';
import { bearer, enrolRunner, get, makeHarness, post, PROJECT, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

const TENANT = 'tenant_a';
const BASE = 'b'.repeat(40);
const stackUrl = `/v1/projects/${PROJECT}/stack`;
const brainUrl = `/v1/projects/${PROJECT}/brain`;

let t: TestDb;
let h: Harness;

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t);
  await h.app.ready();
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE runners, runner_pairing_codes, project_onboardings, project_blueprints CASCADE`);
  await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
});

/** Applies one stack action against the revision the server last reported. */
async function act(action: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const now = await get(h.app, stackUrl);
  return post(h.app, stackUrl, { expectedRevision: now.body.revision, action });
}
async function mustAct(action: Record<string, unknown>): Promise<any> {
  const r = await act(action);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const claimsOf = (brain: any): any[] => brain.compilation.pages.flatMap((p: any) => p.claims);

/**
 * A fingerprint of every table in this test's schema: row count and an md5 of the rows. Used to show that an action changed nothing but what it says it changes.
 */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await t.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${t.schema} AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const out: Record<string, string> = {};
  for (const row of tables) {
    const name = String(row['table_name']);
    if (name.startsWith('__')) continue;
    const [r] = await t.db.execute(sql.raw(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS f FROM "${t.schema}"."${name}" x`));
    out[name] = String(r!['f']);
  }
  return out;
}
const changed = (a: Record<string, string>, b: Record<string, string>): string[] => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).sort();

describe('stack settings: selections are metadata only', () => {
  it('starts empty at revision 0 and carries the catalog version', async () => {
    const res = await get(h.app, stackUrl);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: PROJECT, revision: 0, catalogVersion: expect.any(String), document: { components: [], detection: null }, native: { ios: false, android: false } });
  });

  it('selecting Clerk, Stripe, Supabase, PostHog or Arcjet creates no credential, outbound request, runner command or repository change', async () => {
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    const before = await fingerprint();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sockets: unknown[] = [];
    const real = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) { sockets.push(args[0]); return (real as (...a: unknown[]) => net.Socket).apply(this, args); } as typeof real;
    try {
      for (const [category, label] of [['auth', 'clerk'], ['payments', 'stripe'], ['database_platforms', 'supabase'], ['analytics', 'posthog'], ['security', 'arcjet']] as const) {
        await mustAct({ kind: 'item.add', path: 'apps/web', category, item: { kind: 'catalog', entryId: label } });
      }
    } finally {
      net.Socket.prototype.connect = real;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // The only sockets opened are to this test's own database: no provider was contacted.
    const dbPort = Number(new URL(process.env['DATABASE_URL'] ?? 'postgres://x@127.0.0.1:54329/x').port || 5432);
    for (const s of sockets) expect(JSON.stringify(s)).toContain(String(dbPort));
    const after = await fingerprint();
    // The stack row and the Brain's own tables changed. Nothing else did: no runner command, event, outbox entry, setting, approval or credential store.
    expect(changed(before, after).filter((n) => !n.startsWith('brain_'))).toEqual(['project_stacks']);
    for (const table of ['task_commands', 'events', 'outbox', 'runner_config', 'runner_settings', 'run_settings', 'approvals', 'integration_deliveries']) expect(after[table], table).toBe(before[table]);
    const stored = JSON.stringify((await t.db.execute(sql`SELECT document FROM project_stacks`))[0]);
    expect(stored).not.toMatch(/credential|token|secret|apiKey|install/i);
  });

  it('a credential pasted into a custom label or source is refused and stored nowhere', async () => {
    await mustAct({ kind: 'component.upsert', path: '.', name: 'Repository', targets: [] });
    const before = await fingerprint();
    const r = await act({ kind: 'item.add', path: '.', category: 'payments', item: { kind: 'custom', label: 'sk_live_abcdefghijklmnop1234' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('credential_in_input');
    expect(JSON.stringify(r.body)).not.toContain('sk_live_abcdefghijklmnop1234');
    expect(await fingerprint()).toEqual(before);
    // A field the schema does not know, such as an API key, is refused outright.
    const extra = await act({ kind: 'item.add', path: '.', category: 'payments', item: { kind: 'catalog', entryId: 'stripe', apiKey: 'x' } });
    expect(extra.status).toBe(400);
  });

  it('None and Not decided differ in storage and in the API; removing a selection deletes no provider data and revokes nothing', async () => {
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    let view = await mustAct({ kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' });
    expect(view.document.components[0].categories.payments).toEqual({ state: 'none' });
    expect(view.document.components[0].categories.auth).toEqual({ state: 'not_decided' });
    const stored = (await t.db.execute(sql`SELECT document FROM project_stacks`))[0]!['document'] as any;
    expect(stored.components[0].categories.payments).toEqual({ state: 'none' });
    expect(stored.components[0].categories.auth).toEqual({ state: 'not_decided' });

    view = await mustAct({ kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'clerk' } });
    const before = await fingerprint();
    view = await mustAct({ kind: 'item.remove', path: 'apps/web', category: 'auth', key: 'clerk' });
    expect(view.document.components[0].categories.auth).toEqual({ state: 'not_decided' });
    expect(changed(before, await fingerprint()).filter((n) => !n.startsWith('brain_'))).toEqual(['project_stacks']);
  });

  it('refuses a write against a stale revision, an unknown entry and a wrong category, with nothing recorded', async () => {
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    const stale = await post(h.app, stackUrl, { expectedRevision: 0, action: { kind: 'category.set', path: 'apps/web', category: 'auth', state: 'none' } });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'stack_revision_conflict' } } });
    expect((await act({ kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'nope' } })).body.error.code).toBe('stack_entry_unknown');
    expect((await act({ kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'stripe' } })).body.error.code).toBe('stack_entry_wrong_category');
    expect((await get(h.app, stackUrl)).body.revision).toBe(1);
  });

  it('is for the owner only', async () => {
    const { token } = await enrolRunner(h.app);
    expect((await get(h.app, stackUrl, bearer(token))).status).toBe(403);
    expect((await get(h.app, '/v1/projects/nope/stack')).status).toBe(404);
  });
});

describe('stack settings feed the Project Brain as a cited source, scoped per component', () => {
  it('an owner write compiles the Brain; each worker gets only its component\'s stack, cited, and the records reader version moved', async () => {
    expect(RECORDS_READER_VERSION).toBe('5');
    await seedTask(t.db, specFor('T1', { title: 'Build the web screen', baseSha: BASE, allowedPaths: ['apps/web'] }), 'ready');
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    await mustAct({ kind: 'component.upsert', path: 'apps/mobile', name: 'Mobile', targets: ['ios', 'android'] });
    await mustAct({ kind: 'component.upsert', path: 'services/api', name: 'API', targets: ['server'] });
    await mustAct({ kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'nextjs', version: '15.1.0' } });
    await mustAct({ kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: 'expo' } });
    await mustAct({ kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: 'react-native' } });
    await mustAct({ kind: 'item.add', path: 'services/api', category: 'frameworks', item: { kind: 'catalog', entryId: 'fastapi' } });

    // Compiled by the write itself (no read in between): the head moved past the write.
    const [head] = await t.db.execute(sql`SELECT compiled_version FROM brain_heads`);
    expect(Number(head!['compiled_version'])).toBeGreaterThan(0);
    const brain = (await get(h.app, brainUrl)).body;
    const web = claimsOf(brain).find((c: any) => c.key === 'component:apps/web:frameworks:nextjs');
    expect(web).toMatchObject({ page: 'architecture', status: 'current', text: expect.stringContaining('Next.js 15.1.0'), citations: [{ sourceId: 'stack:apps/web', anchor: 'stack/apps/web/frameworks/nextjs' }] });
    const cite = web.citations[0];
    const src = await get(h.app, `${brainUrl}/sources/${encodeURIComponent(cite.sourceId)}/revisions/${cite.revision}`);
    expect(src.status).toBe(200);
    expect(src.body).toMatchObject({ kind: 'stack', standing: 'accepted', provenance: { origin: 'owner' } });

    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const ctx = claim.body.lease.context;
    const keys = ctx.claims.map((c: any) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['component:apps/web', 'component:apps/web:frameworks:nextjs']));
    expect(keys.filter((k: string) => k.startsWith('component:apps/mobile') || k.startsWith('component:services/api'))).toEqual([]);
    expect(ctx.omissions).toEqual(expect.arrayContaining([{ kind: 'claim', id: 'architecture:component:apps/mobile:frameworks:expo', reason: 'out_of_scope' }]));
  });

  it('a restricted component\'s stack is never served to a streamable attempt: the real claim omits it, named only by its source', async () => {
    await seedTask(t.db, specFor('T1', { title: 'Build', baseSha: BASE, allowedPaths: ['apps/web', 'services/billing'] }), 'ready');
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    await mustAct({ kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'nextjs' } });
    await mustAct({ kind: 'component.upsert', path: 'services/billing', name: 'Billing', targets: ['server'], classification: 'restricted' });
    await mustAct({ kind: 'item.add', path: 'services/billing', category: 'payments', item: { kind: 'custom', label: 'Acme ledger bridge', canonicalSource: null } });
    const brain = (await get(h.app, brainUrl)).body;
    expect(brain.sources.find((s: any) => s.sourceId === 'stack:services/billing')).toMatchObject({ classification: 'restricted', allowedUse: ['local'] });
    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    const { token } = await enrolRunner(h.app);
    const claimed = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body;
    const lease = claimed.lease;
    expect(lease, JSON.stringify(claimed)).toMatchObject({ taskId: 'T1', streamable: true });
    const ctx = lease.context;
    const keys = ctx.claims.map((c: any) => c.key);
    expect(keys).toContain('component:apps/web:frameworks:nextjs');
    expect(keys.filter((k: string) => k.startsWith('component:services/billing'))).toEqual([]);
    expect(JSON.stringify(ctx)).not.toContain('Acme ledger');
    expect(ctx.omissions).toEqual(expect.arrayContaining([{ kind: 'source', id: 'stack:services/billing', reason: 'restricted_for_destination' }]));
    expect(JSON.stringify(ctx.omissions)).not.toContain('component:services/billing');
  });
});

describe('stack settings: a component\'s label only rises', () => {
  it('lowering a label is refused with classification_downgrade; removing the component is explicit and recorded', async () => {
    await mustAct({ kind: 'component.upsert', path: 'svc', name: 'Service', targets: ['server'], classification: 'restricted' });
    const lower = await act({ kind: 'component.upsert', path: 'svc', name: 'Service', targets: ['server'], classification: 'internal' });
    expect(lower).toMatchObject({ status: 409, body: { error: { code: 'classification_downgrade' } } });
    expect((await act({ kind: 'component.remove', path: 'svc' })).body.error.code).toBe('classification_downgrade');
    const removed = await mustAct({ kind: 'component.remove', path: 'svc', acknowledgeLabel: true });
    expect(removed.document.components).toEqual([]);
    expect(removed.document.labelLog).toEqual([{ path: 'svc', classification: 'restricted', removedBy: 'owner_uid_1', removedAt: expect.any(String) }]);
    const again = await mustAct({ kind: 'component.upsert', path: 'svc', name: 'Service', targets: ['server'] });
    expect(again.document.labelLog).toHaveLength(1);
  });
});

describe('stack settings: stored documents and revisions', () => {
  it('a stored category this build does not know is dropped on read, and the rest is kept', async () => {
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    await mustAct({ kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' });
    await t.db.execute(sql`UPDATE project_stacks SET document = jsonb_set(document, '{components,0,categories,future_cat}', '{"state":"none"}')`);
    const view = (await get(h.app, stackUrl)).body;
    expect(view.unreadable).toBe(false);
    expect(view.document.components[0].categories.payments).toEqual({ state: 'none' });
    expect(view.document.components[0].categories.future_cat).toBeUndefined();
  });

  it('a stored document that cannot be read is never overwritten: writes are refused with stack_unreadable', async () => {
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    await t.db.execute(sql`UPDATE project_stacks SET document = '{"components": "not a list", "detection": null}'::jsonb`);
    const before = (await t.db.execute(sql`SELECT document::text AS d, revision FROM project_stacks`))[0];
    const view = (await get(h.app, stackUrl)).body;
    expect(view).toMatchObject({ unreadable: true, document: { components: [], detection: null } });
    const r = await post(h.app, stackUrl, { expectedRevision: view.revision, action: { kind: 'component.upsert', path: '.', name: 'R', targets: [] } });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'stack_unreadable' } } });
    expect((await t.db.execute(sql`SELECT document::text AS d, revision FROM project_stacks`))[0]).toEqual(before);
  });
});

describe('static detection from a runner: a proposal until the owner confirms it', () => {
  const detection = {
    commit: BASE,
    items: [
      { detectionId: 'det:apps/web:nextjs', componentPath: 'apps/web', entryId: 'nextjs', version: '15.1.0', evidence: { path: 'apps/web/package.json', detail: 'dependencies.next 15.1.0' } },
      { detectionId: 'det:apps/web:made-up', componentPath: 'apps/web', entryId: 'made-up', version: null, evidence: { path: 'apps/web/package.json', detail: 'x' } },
    ],
    commands: [{ componentPath: 'apps/web', kind: 'build', script: 'build', command: 'pnpm run build', body: 'next build && echo token=ghp_abcdefghijklmnopqrstuvwxyz123', evidencePath: 'apps/web/package.json' }],
    skipped: [{ path: 'apps/web/linked/package.json', reason: 'symlink' }],
  };

  async function lease(): Promise<{ ref: Record<string, unknown>; token: string }> {
    await seedTask(t.db, specFor('T1', { title: 'Build', baseSha: BASE, allowedPaths: ['apps/web'] }), 'ready');
    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    const { token } = await enrolRunner(h.app);
    const l = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    return { ref: { attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken }, token };
  }

  it('refuses a detection on an expired lease (T6.6 fix round 1, M2)', async () => {
    const { ref, token } = await lease();
    h.clock.advance(600);
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token))).status).toBe(409);
  });

  it('records the detection with evidence, drops entries the catalog does not know, redacts command text, and proposes commands that are not in effect', async () => {
    const { ref, token } = await lease();
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: { ...ref, leaseToken: 'nope' }, detection }, bearer(token))).status).toBe(409);
    const before = await fingerprint();
    const ok = await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token));
    expect(ok.status).toBe(200);
    expect(changed(before, await fingerprint())).toEqual(['project_stacks']);
    const view = (await get(h.app, stackUrl)).body;
    expect(view.document.components).toEqual([]);
    expect(view.document.detection).toMatchObject({ commit: BASE, items: [{ detectionId: 'det:apps/web:nextjs', state: 'proposed', evidence: { path: 'apps/web/package.json' } }] });
    expect(view.document.detection.items).toHaveLength(1);
    expect(view.document.detection.commands[0].body).not.toContain('ghp_');
    expect(view.document.detection.commands[0].body).toContain('[REDACTED]');

    const confirmed = await mustAct({ kind: 'detection.confirm', detectionId: 'det:apps/web:nextjs' });
    expect(confirmed.document.components[0]).toMatchObject({ path: 'apps/web', categories: { frameworks: { state: 'selected', items: [{ entryId: 'nextjs', origin: 'detected', version: '15.1.0' }] } } });
    // A later detection of the same commit keeps what the owner settled.
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token))).status).toBe(200);
    expect((await get(h.app, stackUrl)).body.document.detection.items[0].state).toBe('confirmed');
  });

  it('a detection has its own revision: it never makes an owner\'s edit stale', async () => {
    const { ref, token } = await lease();
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    const read = (await get(h.app, stackUrl)).body;
    expect(read.detectionRevision).toBe(0);
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token))).status).toBe(200);
    const after = (await get(h.app, stackUrl)).body;
    expect(after).toMatchObject({ revision: read.revision, detectionRevision: 1 });
    const edit = await post(h.app, stackUrl, { expectedRevision: read.revision, action: { kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' } });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ revision: read.revision + 1, detectionRevision: 1, document: { detection: { commit: BASE } } });
  });

  it('a detection for a stack that cannot be read is refused rather than overwriting it', async () => {
    const { ref, token } = await lease();
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    await t.db.execute(sql`UPDATE project_stacks SET document = '{"components": 7}'::jsonb`);
    const r = await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token));
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'stack_unreadable' } } });
  });

  it('nothing detected under a restricted component is stored, only a count; raising a label later withholds what was stored', async () => {
    const { ref, token } = await lease();
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'], classification: 'restricted' });
    const mixed = { ...detection, items: [...detection.items, { detectionId: 'det:svc:stripe', componentPath: 'svc', entryId: 'stripe', version: null, evidence: { path: 'svc/package.json', detail: 'dependencies.stripe 1' } }] };
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection: mixed }, bearer(token))).status).toBe(200);
    const stored = JSON.stringify((await t.db.execute(sql`SELECT document FROM project_stacks`))[0]);
    expect(stored).not.toMatch(/nextjs|next build|apps\/web\/linked/);
    const view = (await get(h.app, stackUrl)).body;
    expect(view.document.detection.items.map((i: any) => i.detectionId)).toEqual(['det:svc:stripe']);
    expect(view.document.detection).toMatchObject({ commands: [], skipped: [], withheld: 3 });
    // A component labelled restricted after a detection was stored: what is under it is withheld on that write.
    await mustAct({ kind: 'component.upsert', path: 'svc', name: 'Service', targets: ['server'], classification: 'secret' });
    const after = (await get(h.app, stackUrl)).body.document.detection;
    expect(after).toMatchObject({ items: [], withheld: 4 });
  });

  it('a detection changes neither who last edited the stack nor when; it keeps its own detectedAt', async () => {
    const { ref, token } = await lease();
    await mustAct({ kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] });
    const before = (await get(h.app, stackUrl)).body;
    h.clock.advance(30); // within the lease: an expired lease is refused
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token))).status).toBe(200);
    const after = (await get(h.app, stackUrl)).body;
    expect(after).toMatchObject({ updatedBy: before.updatedBy, updatedAt: before.updatedAt });
    expect(after.document.detection.detectedAt).not.toBe(before.updatedAt);
  });

  it('is refused for work whose data stays on the device', async () => {
    const { ref, token } = await lease();
    await t.db.execute(sql`UPDATE attempts SET detail = jsonb_set(detail, '{terminalStreamable}', 'false')`);
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: ref, detection }, bearer(token))).status).toBe(403);
    expect((await get(h.app, stackUrl)).body.document.detection).toBeNull();
  });

  it('owner credentials cannot post a detection, and a runner cannot write selections', async () => {
    expect((await post(h.app, '/v1/runners/stack/detection', { lease: { attemptId: 'a', fence: 1, leaseToken: 'x' }, detection })).status).toBe(403);
    const { token } = await enrolRunner(h.app);
    expect((await post(h.app, stackUrl, { expectedRevision: 0, action: { kind: 'component.upsert', path: '.', name: 'R', targets: [] } }, bearer(token))).status).toBe(403);
  });
});
