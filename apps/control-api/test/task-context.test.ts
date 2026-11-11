import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { PROJECT, RUN, TENANT, get, post, makeHarness, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  h = makeHarness(t);
});

let seq = 0;
const brainSource = (taskId: string | null, classification: string, allowedUse: string[], sourceId: string) => t.db.insert(schema.brainSources).values({
  tenantId: TENANT, projectId: PROJECT, sourceId, revision: 1, kind: 'note', title: 'n', standing: 'accepted', classification, allowedUse,
  provenance: { origin: 'owner', ref: 'x', recordedBy: 'u' }, taskId, sections: [], contentSha256: 'a'.repeat(64), seq: (seq += 1), recordedAt: new Date(),
});
const context = (taskId: string, destination: string, callOverride?: string, project = PROJECT) => get(h.app, `/v1/projects/${project}/tasks/${taskId}/context?destination=${destination}${callOverride ? `&callOverride=${callOverride}` : ''}`);
const onboardingChoice = (inference: string) => t.db.execute(sql`UPDATE runs SET setup_snapshot = ${JSON.stringify({ blueprintVersion: 1, execution: 'local', inference, agentBudgetUsd: 10, repository: null, defaultBranch: null, baseSha: null })}::jsonb WHERE run_id = ${RUN}`);
const save = (key: string, change: Record<string, unknown>) => post(h.app, `/v1/projects/${PROJECT}/settings`, { key, change, expectedRevision: 0, idempotencyKey: `k-${Math.random()}` });

describe('a task context for its agents (H4)', () => {
  beforeEach(async () => { await onboardingChoice('PREFER_ON_DEVICE'); });

  it('gives the task, its label, the bundle for the asked destination and the spec for the replan path', async () => {
    await seedTask(t.db, specFor('t1', { title: 'Search index', description: 'Index feedback by title.', allowedPaths: ['src/search'], requirementIds: ['FB-1'], criteria: [{ id: 'FB-1', text: 'Finds by title' }] }));
    const res = await context('t1', 'cloud');
    expect(res.status).toBe(200);
    const c = res.body;
    expect(c).toMatchObject({ taskId: 't1', revision: 1, destination: 'cloud', simulated: false, change: null });
    expect(c.task).toEqual({ title: 'Search index', description: 'Index feedback by title.', criteria: [{ id: 'FB-1', text: 'Finds by title' }], allowedPaths: ['src/search'], classification: 'internal' });
    expect(c.bundle).toMatchObject({ destination: 'cloud', taskId: 't1' });
    expect(c.spec).toMatchObject({ taskId: 't1', revision: 1 });
  });

  it('a cloud bundle leaves out a restricted project source the local bundle may keep', async () => {
    await seedTask(t.db, specFor('t1'));
    await brainSource(null, 'restricted', ['local'], 'note:secret-plan');
    const cloud = (await context('t1', 'cloud')).body;
    expect(cloud.bundle.omissions).toContainEqual({ kind: 'source', id: 'note:secret-plan', reason: 'restricted_for_destination' });
    expect(cloud.task.classification).toBe('internal');
    const local = (await context('t1', 'local')).body;
    expect(local.bundle.destination).toBe('local');
    expect(local.bundle.omissions).not.toContainEqual({ kind: 'source', id: 'note:secret-plan', reason: 'restricted_for_destination' });
  });

  it('the label is the strongest of the project, the task and its Brain sources', async () => {
    await seedTask(t.db, specFor('t1'));
    await brainSource('t1', 'restricted', ['local'], 'note:t1');
    expect((await context('t1', 'local')).body.task.classification).toBe('restricted');
  });

  it('refuses a destination it does not know and a task that does not exist', async () => {
    await seedTask(t.db, specFor('t1'));
    expect((await context('t1', 'everywhere')).status).toBe(400);
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context`)).status).toBe(400);
    expect((await context('nope', 'cloud')).status).toBe(404);
  });

  it('refuses a task whose spec cannot be read, and a task asked for under another project', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.execute(sql`UPDATE task_revisions SET spec = '{"broken": true}'::jsonb WHERE task_id = 't1'`);
    const broken = await context('t1', 'local');
    expect(broken.status).toBe(409);
    expect(broken.body.error.code).toBe('task_spec_unreadable');
    await seedTask(t.db, specFor('t2'));
    await t.db.insert(schema.projects).values({ tenantId: TENANT, projectId: 'proj_other', repository: 'r2', defaultBranch: 'main', classification: 'internal' });
    expect((await context('t2', 'local', undefined, 'proj_other')).status).toBe(404);
  });

  it('a cloud context is refused when the route keeps the task on the device: locked, device only, or unset', async () => {
    await seedTask(t.db, specFor('locked', { classification: 'restricted' }));
    const locked = await context('locked', 'cloud');
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('context_destination_refused');
    expect((await context('locked', 'cloud', 'ONLY_IN_CLOUD')).status).toBe(409);
    expect((await context('locked', 'local')).status).toBe(200);
    await seedTask(t.db, specFor('device'));
    expect((await save('device', { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' })).status).toBe(200);
    expect((await context('device', 'cloud')).status).toBe(409);
    // A one-call override is the owner's choice for that call: it widens the destination unless the lock forbids it.
    expect((await context('device', 'cloud', 'ONLY_IN_CLOUD')).status).toBe(200);
    expect((await context('device', 'cloud', 'SOMEWHERE')).status).toBe(400);
    await onboardingChoice('');
    await seedTask(t.db, specFor('unset'));
    expect((await context('unset', 'cloud')).status).toBe(409);
  });

  it('sizes the input without serving it: counts for the allowed destination, refused like the context', async () => {
    await seedTask(t.db, specFor('t1', { title: 'Search', description: 'Index it.', criteria: [{ id: 'FB-1', text: 'Finds by title' }], requirementIds: ['FB-1'] }));
    const size = await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context-size?destination=cloud`);
    expect(size.status).toBe(200);
    expect(size.body).toEqual({ taskId: 't1', destination: 'cloud', hasChange: false, inputChars: 'Search'.length + 'Index it.'.length + 'Finds by title'.length });
    await seedTask(t.db, specFor('locked', { classification: 'restricted' }));
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/locked/context-size?destination=cloud`)).body.error.code).toBe('context_destination_refused');
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/locked/context-size?destination=local`)).status).toBe(200);
  });
});

describe('fix round 1: a restricted predecessor locks its successors (H5 M4)', () => {
  it('a task downstream of a restricted task is locked for routing, the relay and accept, as the claim judges it', async () => {
    await seedTask(t.db, specFor('up', { classification: 'restricted' }), 'verified');
    await seedTask(t.db, specFor('down', { dependencies: [{ taskId: 'up', revision: 1, condition: 'artifact_verified' }], allowedPaths: ['src'] }));
    const route = await get(h.app, `/v1/projects/${PROJECT}/tasks/down/route`);
    expect(route.body.route.lock).toMatchObject({ label: 'restricted' });
    expect((await post(h.app, `/v1/projects/${PROJECT}/tasks/down/files/list`, {})).body.error.code).toBe('files_restricted');
    expect((await post(h.app, `/v1/projects/${PROJECT}/tasks/down/proposals/accept`, { idempotencyKey: 'k', proposal: {} })).body.error.code).toBe('proposal_restricted');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.tasks.find((x: { taskId: string }) => x.taskId === 'down').route.lock).toMatchObject({ label: 'restricted' });
  });
});

describe('fix round 2: predecessor labels in one pass, failing closed without aborting the read (m3)', () => {
  it('an unreadable predecessor spec locks its successor as secret, and the snapshot and the lock list still answer', async () => {
    await seedTask(t.db, specFor('up'), 'verified');
    await seedTask(t.db, specFor('down', { dependencies: [{ taskId: 'up', revision: 1, condition: 'artifact_verified' }] }));
    await seedTask(t.db, specFor('free'));
    await t.db.execute(sql`UPDATE task_revisions SET spec = '{"broken": true}'::jsonb WHERE task_id = 'up'`);
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.status).toBe(200);
    const lockOf = (id: string) => snap.body.tasks.find((x: { taskId: string }) => x.taskId === id).route.lock;
    expect(lockOf('down')).toMatchObject({ label: 'secret' });
    expect(lockOf('free')).toBeNull();
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/down/route`)).body.route.lock).toMatchObject({ label: 'secret' });
  });
});

describe('fix round 3: a restricted claim keeps a Local only task locked (H5)', () => {
  it('a task with a restricted Brain source is locked on Local only, and its proposal is refused before it is read', async () => {
    await onboardingChoice('ONLY_ON_DEVICE');
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src'] }));
    await brainSource('t1', 'restricted', ['local'], 'note:restricted-claim');
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/route`)).body.route).toMatchObject({ effective: 'ONLY_ON_DEVICE', lock: { label: 'restricted' } });
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context?destination=local`)).body.task.classification).toBe('restricted');
    expect((await post(h.app, `/v1/projects/${PROJECT}/tasks/t1/proposals/accept`, { idempotencyKey: 'k', proposal: {} })).body.error.code).toBe('proposal_restricted');
  });
});
