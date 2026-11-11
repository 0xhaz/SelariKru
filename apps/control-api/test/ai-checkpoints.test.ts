import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import type { AiCheckpoint } from '@selarikru/domain';
import { INTRUDER_TOKEN, PROJECT, RUN, TENANT, bearer, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

/**
 * H12: AI step checkpoints on the server. Owner only and project scoped; only public and internal checkpoints are stored. A restricted, secret or locked one, or
 * one whose call record or served context is restricted, is refused (the H5 backstop's rule), and nothing of it is written anywhere: the canary is never found.
 */
let t: TestDb;
let h: Harness;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE ai_checkpoints, client_reports, agent_contexts CASCADE`);
  await h?.app.close();
  h = makeHarness(t);
  await seedTask(t.db, specFor('t_open', { classification: 'internal' }), 'planned');
  await seedTask(t.db, specFor('t_secret', { classification: 'restricted' }), 'planned');
});

const CANARY = 'CANARY-H12-7f3a9c-PATIENT-LIST';
const HEX = 'a'.repeat(64);
const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
  checkpointId: 'ckp_0123456789abcdef', projectId: PROJECT, taskId: 't_open', taskRevision: 1, runId: RUN, planRevision: 1, stepKind: 'pmAnswer', stage: 'pm_turn',
  callOverride: null, routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
  inputs: { contextId: null, bundleSha256: HEX, files: [], inputChars: 900 }, partial: { issues: [], texts: [{ who: 'owner', text: 'When does the list screen start?', classification: 'internal' }] },
  stopReason: 'offline', status: 'waiting', routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...over,
});
const save = (body: unknown, headers?: Record<string, string>) => post(h.app, `/v1/projects/${PROJECT}/ai-checkpoints`, body, headers);
const list = (headers?: Record<string, string>) => get(h.app, `/v1/projects/${PROJECT}/ai-checkpoints`, headers);

/** Every text and jsonb column of every table, searched for the canary. */
async function canaryFound(): Promise<string[]> {
  const cols = await t.db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND data_type IN ('text', 'jsonb', 'character varying')`);
  const hits: string[] = [];
  for (const c of cols) {
    const [row] = await t.db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${String(c['table_name'])}" WHERE "${String(c['column_name'])}"::text LIKE '%${CANARY}%'`));
    if (Number(row!['n']) > 0) hits.push(`${String(c['table_name'])}.${String(c['column_name'])}`);
  }
  return hits;
}

describe('AI step checkpoints on the server (H12)', () => {
  it('stores an internal checkpoint for the owner and lists it again from the database, so it survives a browser close and a server restart', async () => {
    const r = await save(cp());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await h.app.close();
    h = makeHarness(t);
    const again = await list();
    expect(again.status).toBe(200);
    expect(again.body.checkpoints).toEqual([expect.objectContaining({ checkpointId: 'ckp_0123456789abcdef', status: 'waiting', stopReason: 'offline', partial: cp().partial })]);
  });

  it('canary: a restricted, secret, locked or unlabelled checkpoint is refused and nothing of it reaches any table', async () => {
    const restrictedText = { issues: [], texts: [{ who: 'owner' as const, text: CANARY, classification: 'restricted' as const }] };
    const refusals = [
      await save(cp({ labels: ['restricted'], partial: { issues: [], texts: [{ who: 'owner', text: CANARY, classification: 'internal' }] } })),
      await save(cp({ partial: restrictedText })),
      await save(cp({ locked: true, partial: { issues: [], texts: [{ who: 'owner', text: CANARY, classification: 'internal' }] } })),
      await save(cp({ labels: ['secret'], partial: { issues: [], texts: [{ who: 'owner', text: CANARY, classification: 'internal' }] } })),
      await save({ ...cp({ partial: { issues: [], texts: [{ who: 'owner', text: CANARY, classification: 'internal' }] } }), labels: ['unlabelled'] }),
    ];
    expect(refusals.map((r) => r.status)).toEqual([422, 422, 422, 422, 400]);
    expect(refusals.slice(0, 4).map((r) => r.body.error.code)).toEqual(['checkpoint_restricted', 'checkpoint_restricted', 'checkpoint_restricted', 'checkpoint_restricted']);
    expect(await canaryFound()).toEqual([]);
  });

  it('canary: refused like the H5 backstop when the task is locked, the call record ran locked, or its served context held restricted data', async () => {
    const text = { issues: [], texts: [{ who: 'owner' as const, text: CANARY, classification: 'internal' as const }] };
    // The task is restricted: its lock is in force, whatever the browser labels say.
    const locked = await save(cp({ taskId: 't_secret', partial: text }));
    expect(locked.status).toBe(422);
    expect(locked.body.error).toMatchObject({ code: 'checkpoint_restricted', details: { reason: 'task_locked' } });
    // The call record ran locked.
    await t.db.insert(schema.clientReports).values({ tenantId: TENANT, projectId: PROJECT, reportId: 'rpt_l', subjectKind: 'task', subjectId: 't_open', kind: 'route', trust: 'untrusted', reportedBy: 'owner_uid_1',
      payload: { requestId: 'req_locked', taskRevision: 1, stepKind: 'pmAnswer', status: 'ok', locked: true, inputLabel: 'restricted' } });
    const call = await save(cp({ routeRecordId: 'req_locked', partial: text }));
    expect(call.body.error).toMatchObject({ code: 'checkpoint_restricted', details: { reason: 'locked_call' } });
    // The context the server served held restricted data.
    await t.db.insert(schema.agentContexts).values({ tenantId: TENANT, projectId: PROJECT, contextId: 'ctx_r', taskId: 't_open', revision: 1, destination: 'local', contentLabel: 'restricted', servedAt: new Date() });
    const ctx = await save(cp({ inputs: { contextId: 'ctx_r', bundleSha256: null, files: [], inputChars: null }, partial: text }));
    expect(ctx.body.error).toMatchObject({ code: 'checkpoint_restricted', details: { reason: 'restricted_context' } });
    expect(await canaryFound()).toEqual([]);
    // The table refuses it too, whatever wrote it.
    await expect(t.db.insert(schema.aiCheckpoints).values({ tenantId: TENANT, projectId: PROJECT, checkpointId: 'ckp_direct_write', ownerUid: 'owner_uid_1', taskId: 't_open', status: 'waiting', body: cp({ labels: ['restricted'] }) as never, createdAt: new Date(), updatedAt: new Date() })).rejects.toThrow();
    await expect(t.db.insert(schema.aiCheckpoints).values({ tenantId: TENANT, projectId: PROJECT, checkpointId: 'ckp_direct_write', ownerUid: 'owner_uid_1', taskId: 't_open', status: 'waiting', body: cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'x', classification: 'restricted' }] } }) as never, createdAt: new Date(), updatedAt: new Date() })).rejects.toThrow();
  });

  it('refuses secret-shaped text', async () => {
    const r = await save(cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'use AKIAABCDEFGHIJKLMNOP', classification: 'internal' }] } }));
    expect(r.body.error.code).toBe('checkpoint_secret');
  });

  it('owner only and project scoped: another account, another project, a task of another project', async () => {
    expect((await save(cp(), bearer(INTRUDER_TOKEN))).status).toBe(403);
    expect((await list(bearer(INTRUDER_TOKEN))).status).toBe(403);
    expect((await save(cp({ projectId: 'proj_other' }))).status).toBe(422);
    expect((await save(cp({ taskId: 't_missing' }))).status).toBe(404);
    expect((await get(h.app, '/v1/projects/proj_missing/ai-checkpoints')).status).toBe(404);
  });

  it('a closed checkpoint does not reopen, and escalatedAt can only be set by the escalation route', async () => {
    await save(cp({ escalatedAt: '2026-11-12T00:00:01.000Z' }));
    expect((await list()).body.checkpoints[0].escalatedAt).toBeNull();
    expect((await save(cp({ status: 'sent', resumedAs: 'after_reconnect', updatedAt: '2026-11-12T00:01:00.000Z' }))).status).toBe(200);
    const reopen = await save(cp({ status: 'waiting' }));
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('checkpoint_closed');
  });

  describe('escalation', () => {
    const failed = (over: Partial<AiCheckpoint> = {}) => cp({ checkpointId: 'ckp_escalate_0001', stepKind: 'patch', stage: 'reask', routeMode: 'PREFER_ON_DEVICE', stopReason: 'local_failed_checks', partial: { issues: ['/diff diff_does_not_apply'], texts: [] }, ...over });
    const escalate = (id = 'ckp_escalate_0001') => post(h.app, `/v1/projects/${PROJECT}/ai-checkpoints/${id}/escalation`, {});
    const routeOf = async (mode: string) => expect((await post(h.app, `/v1/projects/${PROJECT}/settings`, { key: RUN, change: { scope: 'run', field: 'route_policy', value: mode }, expectedRevision: 0, idempotencyKey: `k-${mode}` })).status).toBe(200);

    it('happens once, on Local first only: the second ask (a reload, another tab) is refused', async () => {
      await routeOf('PREFER_ON_DEVICE');
      expect((await save(failed())).status).toBe(201);
      const first = await escalate();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.checkpoint.escalatedAt).toEqual(expect.any(String));
      const second = await escalate();
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'escalation_refused', details: { reason: 'already_escalated' } });
      // A later save cannot clear it.
      await save(failed({ escalatedAt: null, updatedAt: '2026-11-12T00:02:00.000Z' }));
      expect((await list()).body.checkpoints[0].escalatedAt).toEqual(first.body.checkpoint.escalatedAt);
    });

    it('is refused on Local only, and for a checkpoint whose step did not fail its local checks', async () => {
      await routeOf('ONLY_ON_DEVICE');
      await save(failed());
      expect((await escalate()).body.error).toMatchObject({ code: 'escalation_refused', details: { reason: 'not_local_first' } });
      await save(cp({ checkpointId: 'ckp_offline_00001' }));
      expect((await escalate('ckp_offline_00001')).body.error).toMatchObject({ code: 'escalation_refused', details: { reason: 'not_failed_checks' } });
    });

    it('is refused when the task became locked after the checkpoint was stored', async () => {
      await routeOf('PREFER_ON_DEVICE');
      await save(failed());
      await t.db.execute(sql`UPDATE projects SET classification = 'restricted' WHERE project_id = ${PROJECT}`);
      expect((await escalate()).body.error).toMatchObject({ code: 'escalation_refused', details: { reason: 'locked' } });
    });
  });
});
