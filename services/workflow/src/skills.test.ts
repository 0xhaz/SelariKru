import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyStackAction, emptyStack, SKILL_LIBRARY, STACK_CATALOG_VERSION, type StackDocument } from '@selarikru/domain';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import type { Scheduler } from './index.ts';
import { CAPS, PROJECT, TENANT, capsWith, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb } from '../test/helpers.ts';

let t: TestDb;
let clock: TestClock;
let s: Scheduler;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  s = makeScheduler(t.db, clock);
});

function pilotStack(): StackDocument {
  let doc = emptyStack();
  const step = (a: Parameters<typeof applyStackAction>[1]) => { const r = applyStackAction(doc, a); if (!r.ok) throw new Error(r.code); doc = r.doc; };
  step({ kind: 'component.upsert', path: '.', name: 'Feedback Board', targets: ['web', 'server'] });
  for (const [category, entryId] of [['frameworks', 'express'], ['frameworks', 'react'], ['testing', 'vitest']] as const) step({ kind: 'item.add', path: '.', category, item: { kind: 'catalog', entryId, version: null } });
  return doc;
}

async function setStack(doc: StackDocument) {
  await t.db.insert(schema.projectStacks).values({ tenantId: TENANT, projectId: PROJECT, revision: 1, catalogVersion: STACK_CATALOG_VERSION, document: doc as unknown as Record<string, unknown>, updatedBy: 'o', updatedAt: clock.now() });
}
async function bind(skillId: string, versionId: string, extra: { roles?: string[]; paths?: string[] } = {}) {
  const desired = { versionId, roles: extra.roles ?? [], paths: extra.paths ?? [] };
  await t.db.insert(schema.projectSkillBindings).values({ tenantId: TENANT, projectId: PROJECT, skillId, field: 'binding', desired, desiredRevision: 1, effective: desired, effectiveRevision: 1, enforcer: 'server', updatedBy: 'o', updatedAt: clock.now(), appliedAt: clock.now() });
}
const bindLibrary = async () => { for (const v of SKILL_LIBRARY) await bind(v.skillId, v.versionId); };
const recordOf = async (attemptId: string) => (await t.db.execute(sql`SELECT record FROM skill_execution_records WHERE attempt_id = ${attemptId}`))[0]?.['record'] as { delivered: { skillId: string; digest: string; versionId: string }[]; omitted: { skillId: string; reason: string }[] } | undefined;

const BACKEND = { role: 'backend', allowedPaths: ['server', 'migrations', 'tests/backend'], acceptanceCheckIds: ['FB-01'] };
const FRONTEND = { role: 'frontend', allowedPaths: ['src', 'tests/frontend'], acceptanceCheckIds: ['FB-08'] };

describe('skills at claim', () => {
  it('two tasks with different roles and paths get different packs, and each attempt records the version and digest of every pack it received', async () => {
    await setStack(pilotStack());
    await bindLibrary();
    await seedTask(t.db, specFor('api', BACKEND));
    await seedTask(t.db, specFor('ui', FRONTEND));
    const a = (await s.claimNext(runner('r1'), capsWith(2)))!;
    const b = (await s.claimNext(runner('r2'), capsWith(2)))!;
    const byTask = Object.fromEntries([a, b].map((l) => [l.taskId, l]));
    expect(byTask['api']!.skills!.map((x) => x.skillId)).toEqual(['express-api-routes', 'feedback-board-conventions', 'vitest-testing-practices']);
    expect(byTask['ui']!.skills!.map((x) => x.skillId)).toEqual(['feedback-board-conventions', 'react-accessibility-checklist', 'vitest-testing-practices']);
    const rec = (await recordOf(byTask['api']!.attemptId))!;
    const lib = SKILL_LIBRARY.find((v) => v.skillId === 'express-api-routes')!;
    expect(rec.delivered.find((d) => d.skillId === 'express-api-routes')).toMatchObject({ versionId: lib.versionId, digest: lib.digest });
    expect(rec.omitted).toEqual([{ skillId: 'react-accessibility-checklist', versionId: 'react-accessibility-checklist@1.0.0', reason: 'not_relevant:role' }]);
  });

  it('with no binding nothing is delivered, and the record says so', async () => {
    await setStack(pilotStack());
    await seedTask(t.db, specFor('api', BACKEND));
    const a = (await s.claimNext(runner('r1'), CAPS))!;
    expect(a.skills).toEqual([]);
    expect(await recordOf(a.attemptId)).toMatchObject({ delivered: [], omitted: [] });
  });

  it('a revoked version blocks the next claim of a task it is relevant to, visibly; a task it is not relevant to still runs; an attempt already running keeps its pinned version', async () => {
    await setStack(pilotStack());
    await bindLibrary();
    await seedTask(t.db, specFor('running', BACKEND));
    const running = (await s.claimNext(runner('r1'), capsWith(3)))!;
    await t.db.insert(schema.skillRevocations).values({ tenantId: TENANT, versionId: 'express-api-routes@1.0.0', reason: 'wrong advice', revokedBy: 'o', revokedAt: clock.now() });
    await seedTask(t.db, specFor('api2', BACKEND));
    await seedTask(t.db, specFor('ui', FRONTEND));
    const out = await s.tryClaim(runner('r2'), capsWith(3));
    expect(out).toMatchObject({ ok: true, lease: { taskId: 'ui' } });
    expect(out.skipped).toContainEqual({ taskId: 'api2', reason: 'skill_blocked:skill_revoked:express-api-routes' });
    const [row] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 'api2'`);
    expect(row!['placement_block']).toBe('skill_revoked:express-api-routes');
    expect((await statusOf(t.db, 'running')).status).toBe('running');
    expect((await recordOf(running.attemptId))!.delivered.map((d) => d.versionId)).toContain('express-api-routes@1.0.0');
    // Unbinding the revoked pack lets the task run, and the block clears.
    await t.db.execute(sql`UPDATE project_skill_bindings SET desired = '{"removed":true}'::jsonb WHERE skill_id = 'express-api-routes'`);
    const again = await s.tryClaim(runner('r3'), capsWith(3));
    expect(again).toMatchObject({ ok: true, lease: { taskId: 'api2' } });
    const [cleared] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 'api2'`);
    expect(cleared!['placement_block']).toBeNull();
  });

  it('an unreviewed staged pack bound by force (never through the route) refuses the claim; agents cannot make it reviewed', async () => {
    await setStack(pilotStack());
    const v = { ...SKILL_LIBRARY[0]!, versionId: 'tp-local@1.0.0+abcdefabcdef', skillId: 'tp-local', origin: 'third_party', scope: 'project', triggers: { entries: [], roles: [], paths: [], actions: [] } };
    await t.db.insert(schema.skillStagedVersions).values({ tenantId: TENANT, projectId: PROJECT, versionId: v.versionId, skillId: v.skillId, version: v as unknown as Record<string, unknown>, scan: {}, blocked: false, stagedBy: 'o', stagedAt: clock.now() });
    await bind(v.skillId, v.versionId);
    await seedTask(t.db, specFor('api', BACKEND));
    expect((await s.tryClaim(runner('r1'), CAPS)).skipped).toContainEqual({ taskId: 'api', reason: 'skill_blocked:skill_not_reviewed:tp-local' });
  });
});
