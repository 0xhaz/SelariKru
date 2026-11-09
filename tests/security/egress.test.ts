/**
 * Case: deny an unapproved domain. Grants of network reach are refused at request time (`egress_enforcement_unavailable`), so this exercises that refusal end to end, a grant already issued
 * before that rule, the runtime's own refusal to promise an allowlist, and the separate cloud-destination gate in policy. The sandbox's real network policy is `sbx`'s, outside this repository.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { FakeSbx } from '@selarikru/runtime-docker-local/fake-sbx';
import { CLOUD_POLICY } from '@selarikru/workflow/test-helpers';
import type { Policy } from '@selarikru/policy';
import { POLICY_OPS, PROJECT, signalPath, sql, TENANT, toolWrite, World } from './world.ts';

let w: World;
let cloud: World;
beforeAll(async () => {
  w = await World.create();
  cloud = await World.create({ policy: { ...CLOUD_POLICY, operations: POLICY_OPS } as Policy });
});
afterAll(async () => { await w.destroy(); await cloud.destroy(); });
beforeEach(async () => { await w.reset(); await cloud.reset(); });

const claimCalls = (sbx: FakeSbx, verb: string) => sbx.calls.filter((c) => c[0] === verb);

describe('unapproved network reach', () => {
  it('an agent asking for a new domain is stopped at the request: no approval, no grant, the reason recorded', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_net')]);
    const lease = await w.claim();
    const { report } = await w.runWorker(lease, ({ stream, cwd }) => { stream.push(`${toolWrite(signalPath(cwd), JSON.stringify({ operation: 'new_domain', destination: { kind: 'network_host', host: 'evil.example.com' }, reason: 'exfil' }))}\n`); return false; });
    expect(report).toMatchObject({ outcome: 'blocked', reason: 'egress_enforcement_unavailable' });
    expect(await w.count('approvals')).toBe(0);
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('egress_enforcement_unavailable');
  });

  it('a network grant already in the database stops the attempt before any sandbox exists', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_old')]);
    // A grant issued before requests were refused. No route can create this any more; the scheduler still delivers it.
    await w.t.db.execute(sql`INSERT INTO approvals (tenant_id, project_id, approval_id, run_id, task_id, revision, requester, action_hash, scope_hash, outcome, detail) VALUES (${TENANT}, ${PROJECT}, 'apr_old', ${runId}, 't_old', 1, 'worker', 'ah', 'sh', 'granted', ${JSON.stringify({ operation: 'new_domain', destinationKind: 'network_host', destination: 'evil.example.com', reason: 'r' })}::jsonb)`);

    const lease = await w.claim();
    expect(lease.grants).toEqual([expect.objectContaining({ operation: 'new_domain', destination: { kind: 'network_host', host: 'evil.example.com' } })]);
    const { report, sbx } = await w.runWorker(lease, () => { throw new Error('the agent must not start'); });
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toContain('egress_enforcement_unavailable');
    expect(claimCalls(sbx, 'create')).toEqual([]);
    expect(sbx.streams).toEqual([]);
  });

  it('the runtime reports no egress allowlist and refuses to create a sandbox that needs one', async () => {
    const root = join(w.root, 'rt');
    const ws = join(root, 'attempts', 'a1', 'workspace');
    mkdirSync(ws, { recursive: true });
    const sbx = new FakeSbx();
    const runtime = new SbxRuntimeAdapter(sbx, { home: '/Users/nobody', forbidden: [], attemptsRoot: join(root, 'attempts') });
    expect((await runtime.capabilities()).egressAllowlist).toBe('unsupported');
    await expect(runtime.create({ attemptId: 'a1', taskId: 't1', workspacePath: ws, cpus: 2, memoryMiB: 4096, egressAllowlist: ['api.example.com'] })).rejects.toThrow(/egress/);
    expect(claimCalls(sbx, 'create')).toEqual([]);
  });

  describe('cloud destination (policy level)', () => {
    const start = async (cloudDestination: string) => {
      const runId = await cloud.newRun({ placement: { mode: 'C1', cloudDestination } });
      await cloud.plan(runId, [cloud.task(runId, 't_dest', { execution: 'cloud', role: 'worker' })]);
      return (await cloud.enrol('cloud')).token;
    };
    it('a run pointed at a destination no policy grants never gets a lease, whichever runner asks', async () => {
      const token = await start('unapproved-domain.example');
      const claim = await cloud.api(token).claim();
      expect(claim.lease).toBeNull();
      expect(await cloud.count('attempts')).toBe(0);
      expect(await cloud.count('budget_reservations')).toBe(0);
      expect((await cloud.status('t_dest')).placementBlock).toMatch(/destination/);
      // A local runner cannot pick up cloud-only work by asking.
      expect((await cloud.api().claim()).lease).toBeNull();
    });
    it('control: the destination the policy grants does start, so the refusal above is the destination', async () => {
      const token = await start('cloud-sandbox-eu');
      expect((await cloud.api(token).claim()).lease).not.toBeNull();
    });
  });
});
