import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { PROJECT, TENANT, get, makeHarness, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

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
const context = (taskId: string, destination: string) => get(h.app, `/v1/projects/${PROJECT}/tasks/${taskId}/context?destination=${destination}`);

describe('a task context for its agents (H4)', () => {
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

  it('a cloud bundle leaves out a restricted source the local bundle may keep, and the label is the strongest of the task and its sources', async () => {
    await seedTask(t.db, specFor('t1'));
    await brainSource('t1', 'restricted', ['local'], 'note:secret-plan');
    const cloud = (await context('t1', 'cloud')).body;
    expect(cloud.bundle.omissions).toContainEqual({ kind: 'source', id: 'note:secret-plan', reason: 'restricted_for_destination' });
    expect(cloud.task.classification).toBe('restricted');
    const local = (await context('t1', 'local')).body;
    expect(local.bundle.destination).toBe('local');
    expect(local.bundle.omissions).not.toContainEqual({ kind: 'source', id: 'note:secret-plan', reason: 'restricted_for_destination' });
  });

  it('refuses a destination it does not know and a task that does not exist', async () => {
    await seedTask(t.db, specFor('t1'));
    expect((await context('t1', 'everywhere')).status).toBe(400);
    expect((await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/context`)).status).toBe(400);
    expect((await context('nope', 'cloud')).status).toBe(404);
  });
});
