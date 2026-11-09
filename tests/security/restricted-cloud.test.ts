/** Case: restricted data rejected from cloud. Both axes, separately: where the worker runs and where its model calls go. Real plan and claim routes, a real cloud-enrolled runner. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_POLICY } from '@selarikru/workflow/test-helpers';
import type { Policy } from '@selarikru/policy';
import { POLICY_OPS, PROJECT, post, sql, World } from './world.ts';

// The most permissive policy a person could write: `restricted` is listed for the destination. The code must refuse it regardless.
const widest = { ...CLOUD_POLICY, operations: POLICY_OPS, destinations: [{ destination: 'cloud-sandbox-eu', purpose: 'execution', classifications: ['public', 'internal', 'restricted'] }] } as unknown as Policy;
let w: World;
beforeAll(async () => { w = await World.create({ policy: widest }); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const cloudRun = () => w.newRun({ placement: { mode: 'C1', cloudDestination: 'cloud-sandbox-eu' } });
const attempts = () => w.count('attempts');

describe('restricted work and the cloud', () => {
  const deviceModel = (taskId: string, key: string) => post(w.app, `/v1/projects/${PROJECT}/model-assignments`, { scope: 'task', key: taskId, selection: { provider: 'test-device', model: 'device-1' }, expectedRevision: 0, idempotencyKey: key });

  it.each(['restricted', 'secret'] as const)('a %s task placed for cloud is never leased to a cloud runner, even with the destination listed and a device model assigned', async (classification) => {
    const runId = await cloudRun();
    await w.plan(runId, [w.task(runId, 't_r', { execution: 'cloud', role: 'worker', classification })]);
    // With a device model the model-route gate is satisfied, so this is the placement gate alone.
    expect((await deviceModel('t_r', `m-${classification}`)).status).toBe(200);
    const { token } = await w.enrol('cloud');
    const claim = await w.api(token).claim();
    expect(claim.lease).toBeNull();
    expect(await attempts()).toBe(0);
    expect(await w.count('budget_reservations')).toBe(0);
    expect((await w.status('t_r')).status).not.toBe('running');
    expect((await w.status('t_r')).placementBlock).toBe('classification_not_cloud_eligible');
  });

  it('a restricted task on a cloud runner with the default cloud model stops at the model route, before placement', async () => {
    const runId = await cloudRun();
    await w.plan(runId, [w.task(runId, 't_rm', { execution: 'cloud', role: 'worker', classification: 'restricted' })]);
    const { token } = await w.enrol('cloud');
    expect((await w.api(token).claim()).lease).toBeNull();
    expect((await w.status('t_rm')).placementBlock).toMatch(/restricted_requires_device_model/);
    expect(await attempts()).toBe(0);
  });

  it('an internal task in a restricted project takes the project’s label: no cloud lease', async () => {
    await w.t.db.execute(sql`UPDATE projects SET classification = 'restricted'`);
    const runId = await cloudRun();
    await w.plan(runId, [w.task(runId, 't_p', { execution: 'cloud', role: 'worker', classification: 'internal' })]);
    const { token } = await w.enrol('cloud');
    expect((await w.api(token).claim()).lease).toBeNull();
    expect((await w.status('t_p')).placementBlock).toMatch(/classification_not_cloud_eligible|model_blocked|restricted/);
  });

  it('eligible_any restricted work is not handed to a cloud runner either', async () => {
    const runId = await w.newRun({ placement: { mode: 'L1', cloudDestination: 'cloud-sandbox-eu' } });
    await w.plan(runId, [w.task(runId, 't_any', { execution: 'eligible_any', role: 'worker', classification: 'restricted' })]);
    const { token } = await w.enrol('cloud');
    expect((await w.api(token).claim()).lease).toBeNull();
    expect(await attempts()).toBe(0);
  });

  it('restricted work on a local runner still cannot call a cloud model: the attempt never starts', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_m', { classification: 'restricted' })]);
    const raw = await post(w.app, '/v1/runners/claim', {}, { authorization: `Bearer ${w.token}` });
    expect(raw.status).toBe(200);
    expect(raw.body.lease).toBeNull();
    expect(raw.body.skipped).toEqual([expect.objectContaining({ taskId: 't_m', reason: expect.stringContaining('restricted_requires_device_model') })]);
    expect(await attempts()).toBe(0);
    expect((await w.status('t_m')).placementBlock).toMatch(/restricted_requires_device_model/);
  });

  it('control: restricted work with a device model on a local runner does start, so the block above is the model route', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_dev', { classification: 'restricted' })]);
    const assigned = await post(w.app, `/v1/projects/${PROJECT}/model-assignments`, { scope: 'task', key: 't_dev', selection: { provider: 'test-device', model: 'device-1' }, expectedRevision: 0, idempotencyKey: 'a1' });
    expect(assigned.status).toBe(200);
    const lease = await w.claim();
    expect(lease.taskId).toBe('t_dev');
    expect(lease.streamable).toBe(false);
  });

  it('control: internal work does reach the cloud runner under the same policy', async () => {
    const runId = await cloudRun();
    await w.plan(runId, [w.task(runId, 't_ok', { execution: 'cloud', role: 'worker', classification: 'internal' })]);
    const { token } = await w.enrol('cloud');
    expect((await w.api(token).claim()).lease).not.toBeNull();
  });
});
