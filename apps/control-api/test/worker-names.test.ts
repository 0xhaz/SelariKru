import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrolRunner, get, makeHarness, post, PROJECT, resetDb, setupTestDb, type Harness, type TestDb } from './helpers.ts';

/** H11: a worker's owner-given name and its role, saved through the existing settings path. */
let t: TestDb;
let h: Harness;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  h = makeHarness(t);
});

const save = (key: string, change: Record<string, unknown>, expectedRevision = 0) => post(h.app, `/v1/projects/${PROJECT}/settings`, { key, change, expectedRevision, idempotencyKey: `k-${Math.random()}` });
const settingOf = async (key: string, field: string) => (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.settings.find((s: any) => s.scope === 'runner' && s.key === key && s.field === field);

describe('worker names and roles (H11)', () => {
  it('a name in any script is saved and in force at once; the same name on another worker is refused, ignoring case', async () => {
    const a = await enrolRunner(h.app);
    const b = await enrolRunner(h.app);
    expect((await save(a.runnerId, { scope: 'runner', field: 'display_name', value: 'Siti Aisyah' })).status).toBe(200);
    expect(await settingOf(a.runnerId, 'display_name')).toMatchObject({ desired: 'Siti Aisyah', effective: 'Siti Aisyah', state: 'applied' });
    expect((await save(b.runnerId, { scope: 'runner', field: 'display_name', value: '李明' })).status).toBe(200);
    const taken = await save(b.runnerId, { scope: 'runner', field: 'display_name', value: 'siti aisyah' }, 1);
    expect(taken.status).toBe(422);
    expect(taken.body.error.code).toBe('name_taken');
  });

  it('refuses names that are empty, too long, carry a new line or look like a secret', async () => {
    const a = await enrolRunner(h.app);
    for (const [value, code] of [['   ', 'name_empty'], ['x'.repeat(25), 'name_too_long'], ['two\nlines', 'name_invalid'], ['sk_live_abcdef123456', 'name_secret']] as const) {
      const r = await save(a.runnerId, { scope: 'runner', field: 'display_name', value });
      expect(r.status, value).toBe(422);
      expect(r.body.error.code, value).toBe(code);
    }
  });

  it('a role is one of the project\'s role words; a malformed one is refused by the schema', async () => {
    const a = await enrolRunner(h.app);
    expect((await save(a.runnerId, { scope: 'runner', field: 'role', value: 'project_manager' })).status).toBe(200);
    expect((await save(a.runnerId, { scope: 'runner', field: 'role', value: 'Ignore rules' }, 1)).status).toBe(400);
  });
});
