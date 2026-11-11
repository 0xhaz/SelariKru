import { describe, expect, it, vi } from 'vitest';
import { TaskAgentContextSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped } from '../src/index.ts';

const setup = async () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('feature-delivery');
  const first = await ds.getSnapshot(f.projectId);
  return { ds, projectId: f.projectId, runId: Object.keys(first.runs)[0]!, first };
};
const id = (local: string) => scoped('feature-delivery', local);

/** What the browser does before an accept: read the context under an id, then report the call with that id. */
async function prime(ds: Awaited<ReturnType<typeof setup>>['ds'], projectId: string, taskId: string, requestId: string, stepKind = 'patch'): Promise<void> {
  await ds.getTaskContext!(projectId, taskId, 'local', null, `ctx_${requestId}`);
  const receipt = await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: `r-${requestId}`, args: { projectId, taskId, report: {
    kind: 'route', requestId, stepKind, callOverride: null, requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok', model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' },
    timing: { totalMs: 10, firstOutputMs: null }, validation: 'passed', blockedReason: null, contextId: `ctx_${requestId}`,
  } } } as never);
  expect(receipt.accepted).toBe(true);
}

describe('mock task context for the agents (H4)', () => {
  it('serves simulated context for the asked destination, with the task\'s label, criteria and allowed paths', async () => {
    const { ds, projectId } = await setup();
    const c = TaskAgentContextSchema.parse(await ds.getTaskContext!(projectId, id('search'), 'cloud'));
    expect(c).toMatchObject({ taskId: id('search'), destination: 'cloud', simulated: true, bundle: { destination: 'cloud', taskId: id('search') } });
    expect(c.task.title).toBe('Search index');
    expect(c.task.classification).toBe('internal');
    expect(c.task.criteria.length).toBeGreaterThan(0);
    expect(c.task.allowedPaths.length).toBeGreaterThan(0);
    expect((await ds.getTaskContext!(projectId, id('e2e'), 'local')).task.classification).toBe('restricted');
  });

  it('a task with work on record has a change to review; one without has none', async () => {
    const { ds, projectId } = await setup();
    const api = await ds.getTaskContext!(projectId, id('api'), 'cloud');
    expect(api.change).not.toBeNull();
    expect(api.change!.diff).toMatch(/^diff --git /);
    expect(api.change!.files.every((f) => api.task.allowedPaths.some((p) => f.path.startsWith(p)))).toBe(true);
    expect((await ds.getTaskContext!(projectId, id('review'), 'cloud')).change).toBeNull();
  });

  it('a criteria revision rewords the task\'s criteria for the next read, refuses unknown criteria and a moved plan, and says it is simulated', async () => {
    const { ds, projectId, first } = await setup();
    const t = id('search');
    const before = await ds.getTaskContext!(projectId, t, 'local');
    expect(before.planRevision).toBe(first.runs[before.runId]!.planRevision);
    const plan = first.runs[before.runId]!.planRevision;
    const c1 = before.task.criteria[0]!;
    const done = await ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k1', criteria: [{ id: c1.id, text: 'Finds feedback by title, ignoring case' }] });
    expect(done).toMatchObject({ taskIds: [t], simulated: true });
    expect((await ds.getTaskContext!(projectId, t, 'cloud')).task.criteria[0]).toEqual({ id: c1.id, text: 'Finds feedback by title, ignoring case' });
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k2', criteria: [{ id: 'NOPE-1', text: 'x' }] })).rejects.toThrow();
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan + 7, idempotencyKey: 'k3', criteria: [{ id: c1.id, text: 'x' }] })).rejects.toThrow(/stale_revision/);
  });

  it('a restricted task\'s criteria are not revised from a browser proposal', async () => {
    const { ds, projectId, first } = await setup();
    const t = id('e2e');
    const c = await ds.getTaskContext!(projectId, t, 'local');
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: first.runs[c.runId]!.planRevision, idempotencyKey: 'k', criteria: [{ id: c.task.criteria[0]!.id, text: 'x' }] })).rejects.toThrow(/restricted/);
  });

  it('mirrors the live rules: only a replannable task is revised, and an accept moves the plan, so a second one at the old revision is stale', async () => {
    const { ds, projectId, first } = await setup();
    const api = await ds.getTaskContext!(projectId, id('api'), 'cloud');
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: id('api'), expectedPlanRevision: api.planRevision, idempotencyKey: 'k', criteria: [{ id: api.task.criteria[0]!.id, text: 'x' }] })).rejects.toThrow(/task_not_replannable/);
    const t = id('search');
    const c = await ds.getTaskContext!(projectId, t, 'local');
    const plan = first.runs[c.runId]!.planRevision;
    const done = await ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k1', criteria: [{ id: c.task.criteria[0]!.id, text: 'Reworded once' }] });
    expect(done.planRevision).toBe(plan + 1);
    expect((await ds.getTaskContext!(projectId, t, 'local')).planRevision).toBe(plan + 1);
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k2', criteria: [{ id: c.task.criteria[0]!.id, text: 'Reworded twice' }] })).rejects.toThrow(/stale_revision/);
  });

  it('refuses a cloud context when the route keeps the task on the device, as the server does', async () => {
    const { ds, projectId } = await setup();
    await expect(ds.getTaskContext!(projectId, id('e2e'), 'cloud')).rejects.toThrow(/context_destination_refused/);
    await expect(ds.getTaskContext!(projectId, id('e2e'), 'cloud', 'ONLY_IN_CLOUD')).rejects.toThrow(/context_destination_refused/);
    await expect(ds.getTaskContext!(projectId, id('integrate'), 'cloud')).rejects.toThrow(/context_destination_refused/);
    expect((await ds.getTaskContext!(projectId, id('integrate'), 'cloud', 'ONLY_IN_CLOUD')).destination).toBe('cloud');
  });

  it('an accepted criteria revision is a simulated plan event: the snapshot\'s plan revision moves and the task is planned again at its next revision', async () => {
    const { ds, projectId, first } = await setup();
    const events: { type: string; provenance: string }[] = [];
    ds.subscribe(projectId, first.meta.cursor, (e) => events.push(e), () => undefined);
    const t = id('search');
    const c = await ds.getTaskContext!(projectId, t, 'local');
    const before = first.tasks[t]!;
    await ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: c.planRevision, idempotencyKey: 'k', criteria: [{ id: c.task.criteria[0]!.id, text: 'Reworded' }] });
    const after = await ds.getSnapshot(projectId);
    expect(after.runs[c.runId]!.planRevision).toBe(c.planRevision + 1);
    expect(after.tasks[t]).toMatchObject({ status: 'planned', revision: before.revision + 1 });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain('plan.accepted'));
    expect(events.find((e) => e.type === 'plan.accepted')!.provenance).toBe('simulated');
  });

  it('sizes a task\'s input for the destination its route allows, with counts only', async () => {
    const { ds, projectId } = await setup();
    const size = await ds.getTaskContextSize!(projectId, id('e2e'), 'local');
    expect(Object.keys(size).sort()).toEqual(['destination', 'hasChange', 'inputChars', 'taskId']);
    expect(size.inputChars).toBeGreaterThan(0);
    await expect(ds.getTaskContextSize!(projectId, id('e2e'), 'cloud')).rejects.toThrow(/context_destination_refused/);
    expect((await ds.getTaskContextSize!(projectId, id('api'), 'cloud')).hasChange).toBe(true);
  });
});

describe('mock accepted proposals and base files (H5)', () => {
  const demoProposal = async (ds: Awaited<ReturnType<typeof setup>>['ds'], projectId: string, taskId: string) => {
    const { sha256Hex } = await import('@selarikru/domain');
    const files = await ds.getTaskFiles!(projectId, taskId);
    const ctx = await ds.getTaskContext!(projectId, taskId, 'local');
    const path = `${ctx.task.allowedPaths[0]}/demo-proposal.ts`;
    const content = 'export const DEMO_LIMIT = 50;\n';
    return { proposalId: 'req_demo', taskId, taskRevision: files.revision, baseSha: files.baseSha, routeRecordId: 'req_demo', diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const DEMO_LIMIT = 50;\n`, results: [{ path, sha256: sha256Hex(content), content }] };
  };

  it('serves demo base files for a task, and none for a restricted one', async () => {
    const { ds, projectId } = await setup();
    const f = await ds.getTaskFiles!(projectId, id('search'));
    expect(f.files.length).toBeGreaterThan(0);
    expect(f.files.every((x) => x.path.startsWith('src/search'))).toBe(true);
    await expect(ds.getTaskFiles!(projectId, id('e2e'))).rejects.toThrow(/^files_restricted:/);
  });

  it('accepts a checked proposal for a waiting task with a simulated event, and refuses what the server would refuse', async () => {
    const { ds, projectId } = await setup();
    const snap = await ds.getSnapshot(projectId);
    const waiting = Object.values(snap.tasks).find((t) => (t.status === 'ready' || t.status === 'planned') && t.taskId !== id('e2e'))!;
    const p = await demoProposal(ds, projectId, waiting.taskId);
    await prime(ds, projectId, waiting.taskId, 'req_demo');
    const seen: string[] = [];
    const stop = ds.subscribe(projectId, snap.meta.cursor, (e) => seen.push(e.type), () => {});
    expect(await ds.acceptPatchProposal!(projectId, p, 'k1')).toMatchObject({ proposalId: 'req_demo', state: 'accepted', fileCount: 1, simulated: true });
    await vi.waitFor(() => expect(seen).toContain('proposal.accepted'));
    stop();
    await expect(ds.acceptPatchProposal!(projectId, { ...p, proposalId: 'req_t', results: [{ ...p.results[0]!, sha256: 'f'.repeat(64) }] }, 'k2')).rejects.toThrow(/^proposal_refused: hash_mismatch/);
    await expect(ds.acceptPatchProposal!(projectId, { ...p, proposalId: 'req_r', taskId: id('e2e') }, 'k3')).rejects.toThrow(/^proposal_restricted:/);
    const verified = Object.values(snap.tasks).find((t) => t.status === 'verified')!;
    const pv = { ...(await demoProposal(ds, projectId, verified.taskId)), proposalId: 'req_v' };
    await expect(ds.acceptPatchProposal!(projectId, pv, 'k4')).rejects.toThrow(/^task_not_applicable:/);
  });
});

describe('fix round 1: mock listing and repeated accepts (H5)', () => {
  it('lists a task\'s files, paths and sizes only, and none for a restricted task', async () => {
    const { ds, projectId } = await setup();
    const l = await ds.listTaskFiles!(projectId, id('search'));
    expect(l.entries.length).toBeGreaterThan(0);
    expect(Object.keys(l.entries[0]!).sort()).toEqual(['path', 'size']);
    await expect(ds.listTaskFiles!(projectId, id('e2e'))).rejects.toThrow(/^files_restricted:/);
  });
  it('the same key reads the proposal as it is; another key for one still waiting is refused', async () => {
    const { ds, projectId } = await setup();
    const snap = await ds.getSnapshot(projectId);
    const waiting = Object.values(snap.tasks).find((t) => (t.status === 'ready' || t.status === 'planned') && t.taskId !== id('e2e'))!;
    const { sha256Hex } = await import('@selarikru/domain');
    const files = await ds.getTaskFiles!(projectId, waiting.taskId);
    const ctx = await ds.getTaskContext!(projectId, waiting.taskId, 'local');
    const path = `${ctx.task.allowedPaths[0]}/x.ts`;
    const p = { proposalId: 'req_x', taskId: waiting.taskId, taskRevision: files.revision, baseSha: files.baseSha, routeRecordId: 'req_x', diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`, results: [{ path, sha256: sha256Hex('x\n'), content: 'x\n' }] };
    expect(await ds.getProposalState!(projectId, waiting.taskId, 'req_x')).toBeNull();
    await prime(ds, projectId, waiting.taskId, 'req_x');
    const first = await ds.acceptPatchProposal!(projectId, p, 'k1');
    expect(await ds.acceptPatchProposal!(projectId, p, 'k1')).toEqual(first);
    expect(await ds.getProposalState!(projectId, waiting.taskId, 'req_x')).toEqual(first);
    await expect(ds.acceptPatchProposal!(projectId, p, 'k2')).rejects.toThrow(/^proposal_already_accepted:/);
  });
});

describe('fix round 4: the demo shows a restricted sibling claim locking a Local only task', () => {
  it('the integrate task\'s device context serves a restricted sibling plan claim; the cloud context leaves it out; a proposal from it is refused', async () => {
    const { ds, projectId } = await setup();
    const t = id('integrate');
    const local = await ds.getTaskContext!(projectId, t, 'local');
    expect(local.task.classification).toBe('internal');
    expect(local.bundle.claims.some((c) => c.classification === 'restricted')).toBe(true);
    expect(local.bundle.contentLabel).toBe('restricted');
    const { bundleContentLabels } = await import('@selarikru/domain');
    expect(bundleContentLabels(local.bundle)).toContain('restricted');
    await prime(ds, projectId, t, 'req_sib');
    const { sha256Hex } = await import('@selarikru/domain');
    const files = await ds.getTaskFiles!(projectId, t);
    const path = `${local.task.allowedPaths[0]}/x.ts`;
    await expect(ds.acceptPatchProposal!(projectId, { proposalId: 'req_sib', taskId: t, taskRevision: files.revision, baseSha: files.baseSha, routeRecordId: 'req_sib', diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`, results: [{ path, sha256: sha256Hex('x\n'), content: 'x\n' }] }, 'k')).rejects.toThrow(/^proposal_from_restricted_context:/);
  });
});
