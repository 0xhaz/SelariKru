/**
 * Rows a restricted attempt wrote before the closed list may still hold a runner's sentence. Nothing rewrites stored data, so every read path that reaches the browser reads
 * a restricted attempt's reasons through the same rule: the snapshot (attempt exit reasons, blocked reasons) and the event stream.
 */
import { sql } from 'drizzle-orm';
import { appendEvent, schema, withTx } from '@selarikru/persistence';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TOKEN, PROJECT, RUN, TENANT, makeHarness, owner, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;
let base: string;
const CANARY = 'RESTRICTED-CANARY';
const OPEN = 'STREAMABLE-WORDS';

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t);
  base = await h.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
});

/** A blocked task whose ended attempt stored `words` in every reason field, the way a runner's free text was stored before the fix. */
async function oldRow(taskId: string, streamable: boolean | null, words: string): Promise<void> {
  await seedTask(t.db, specFor(taskId), 'blocked');
  const attemptId = `att_${taskId}`;
  await t.db.insert(schema.attempts).values({
    tenantId: TENANT, projectId: PROJECT, attemptId, taskId, revision: 1, attemptNumber: 1, outcome: 'failed', exitReason: `could not compute the diff: secret/${words}.md`,
    startedAt: new Date('2026-11-08T06:00:00Z'), endedAt: new Date('2026-11-08T06:05:00Z'), detail: streamable === null ? {} : { terminalStreamable: streamable },
  });
  const ev = (type: 'attempt.failed' | 'task.blocked', payload: Record<string, unknown>) => withTx(t.db, (tx) => appendEvent(tx, {
    schemaVersion: 1, eventId: `evt_${taskId}_${type}`, projectId: PROJECT, runId: RUN, taskId, attemptId, type, sequence: 0, aggregateRevision: 1,
    actor: { kind: 'scheduler', id: 'scheduler' }, occurredAt: '2026-11-08T06:05:00.000Z', receivedAt: '2026-11-08T06:05:00.000Z', causationId: null, traceId: 'trace', payload,
  }));
  await ev('attempt.failed', { fence: 1, reason: `could not compute the diff: secret/${words}.md`, outcome: 'failed' });
  await ev('task.blocked', { fence: 1, reason: `toolchain_unresolved: ${words}`, requestedReason: `please ${words}` });
}

async function streamed(): Promise<string> {
  const ctl = new AbortController();
  const res = await fetch(`${base}/v1/projects/${PROJECT}/events?after=0`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 5000;
  while ((buf.match(/^data: /gm)?.length ?? 0) < 4 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ctl.abort();
  return buf;
}

describe('a restricted attempt stored before the closed list', () => {
  it.each([[false], [null]] as const)('shows no runner words in the snapshot or the event stream (terminalStreamable %s)', async (label) => {
    await oldRow('t_old', label, CANARY);
    await oldRow('t_open', true, OPEN);
    const snap = JSON.stringify((await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json());
    expect(snap).not.toContain(CANARY);
    expect(snap).toContain('reason_withheld');
    // Work cleared for streaming still says what happened.
    expect(snap).toContain(OPEN);

    const stream = await streamed();
    expect(stream).toContain('t_old');
    expect(stream).not.toContain(CANARY);
    expect(stream).toContain(OPEN);
  });

  it.each([[false], [null]] as const)('shows no agent words in an approval stored before T7.4a, open or resolved (terminalStreamable %s)', async (label) => {
    /** An approval requested by the task's attempt, with the agent's own words as its reason, as rows were stored before the fixed sentence. */
    const oldApproval = async (taskId: string, approvalId: string, outcome: 'pending' | 'denied', words: string) => {
      await t.db.insert(schema.approvals).values({
        tenantId: TENANT, projectId: PROJECT, approvalId, runId: RUN, taskId, revision: 1, requester: 'runner_1', actionHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), outcome,
        detail: { operation: 'destructive_data_migration', reason: `drop the patients table holding ${words} rows` }, ...(outcome === 'denied' ? { resolvedAt: new Date('2026-11-08T06:06:00Z'), approver: 'owner' } : {}),
      });
      await withTx(t.db, (tx) => appendEvent(tx, {
        schemaVersion: 1, eventId: `evt_${approvalId}`, projectId: PROJECT, runId: RUN, taskId, attemptId: `att_${taskId}`, type: 'approval.requested', sequence: 0, aggregateRevision: 2,
        actor: { kind: 'scheduler', id: 'scheduler' }, occurredAt: '2026-11-08T06:05:00.000Z', receivedAt: '2026-11-08T06:05:00.000Z', causationId: null, traceId: 'trace',
        payload: { fence: 1, approvalId, operation: 'destructive_data_migration', reason: 'x' },
      }));
    };
    await oldRow('t_old', label, 'OTHER');
    await oldApproval('t_old', 'apr_open', 'pending', CANARY);
    await oldApproval('t_old', 'apr_done', 'denied', CANARY);
    await oldRow('t_open', true, 'OTHER2');
    await oldApproval('t_open', 'apr_open_s', 'pending', OPEN);
    const snap = (await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json() as { approvals: { approvalId: string; reason: string | null }[]; approvalHistory: { approvalId: string; reason: string | null }[] };
    expect(JSON.stringify(snap)).not.toContain(CANARY);
    expect(snap.approvals.find((a) => a.approvalId === 'apr_open')?.reason).toBe('reason_withheld');
    expect(snap.approvalHistory.find((a) => a.approvalId === 'apr_done')?.reason).toBe('reason_withheld');
    expect(snap.approvals.find((a) => a.approvalId === 'apr_open_s')?.reason).toContain(OPEN);
  });

  it('the stored rows themselves are not rewritten', async () => {
    await oldRow('t_old', false, CANARY);
    await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() });
    expect(JSON.stringify(await t.db.execute(sql`SELECT exit_reason FROM attempts`))).toContain(CANARY);
  });
});
