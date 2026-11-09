import { describe, expect, it } from 'vitest';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task, worker } from '../overview/testing.ts';
import { PIPELINE_COLUMNS, STAGES, buildPipeline, filterRows, type PipelineModel, type PipelineRow } from './model.ts';

const build = (snapshot: Parameters<typeof buildPipeline>[0]): PipelineModel => buildPipeline(snapshot, NOW, NOW);
const row = (m: PipelineModel, id: string): PipelineRow => m.rows.find((r) => r.taskId === id)!;
const why = (m: PipelineModel, id: string) => row(m, id).why;
const causes = (m: PipelineModel, id: string): string[] => why(m, id).reasons.map((r) => r.cause);
const stageOf = (m: PipelineModel, id: string): string => row(m, id).stage;

describe('pipeline table', () => {
  it('table columns per design §6', () => {
    expect(PIPELINE_COLUMNS.map((c) => c.label)).toEqual(['Task and stage', 'Owner', 'State and reason', 'Predecessors', 'Accepted revision', 'Branch or candidate', 'Checks', 'Age', 'Next action']);
    const snapshot = snapshotOf({
      tasks: [task('dep', { status: 'verified', title: 'Dep' }), task('t', { status: 'planned', title: 'Target', dependsOn: ['dep'], enteredStatusAt: iso(90) })],
      workers: [worker('w1', { taskId: 'dep' })],
      checks: { c: { checkId: 'c', taskId: 't', state: 'failed', summary: '3 of 41 failed', updatedAt: iso(2), evidenceRef: 'e' } },
    });
    const r = row(build(snapshot), 't');
    expect(r.title).toBe('Target');
    expect(r.stage).toBe('build');
    expect(r.owner).toEqual({ role: 'backend', workerId: null });
    expect(r.state.label).toBe('Planned');
    expect(r.predecessors).toEqual([{ taskId: 'dep', title: 'Dep', status: 'Verified; awaiting merge', edge: 'met', note: null }]);
    expect(r.accepted).toBeNull();
    expect(r.branch).toBeNull();
    expect(r.checks).toMatchObject({ label: 'Failed', tone: 'danger', detail: '3 of 41 failed' });
    expect(r.age).toBe('1m 30s');
    expect(r.since).toBe(iso(90));
    expect(row(build(snapshot), 'dep')).toMatchObject({ owner: { role: 'backend', workerId: 'w1' }, accepted: 'Rev 1' });
    expect(typeof r.nextAction).toBe('string');
  });

  it('never presents an unknown as an absence: null dependencies are unknown, an empty list is none', () => {
    const m = build(snapshotOf({ tasks: [task('unknown', { dependsOn: null }), task('none', { dependsOn: [] })] }));
    expect(row(m, 'unknown').predecessors).toBeNull();
    expect(row(m, 'none').predecessors).toEqual([]);
    expect(m.edges).toEqual([]);
  });

  it('a missing dependency is named as outside this snapshot, not as met', () => {
    const m = build(snapshotOf({ tasks: [task('t', { status: 'planned', dependsOn: ['ghost'] })] }));
    expect(row(m, 't').predecessors).toEqual([{ taskId: 'ghost', title: 'ghost', status: 'Unknown', edge: 'unknown', note: 'Not in this snapshot' }]);
    expect(row(m, 't').why.reasons[0]).toMatchObject({ cause: 'dependency', unknown: true });
  });

  it('shows run-level candidate evidence only on work it can cover, without inventing a branch', () => {
    const base = snapshotOf({ tasks: [task('done', { status: 'verified' }), task('going', { status: 'running' })] });
    const snapshot = { ...base, runs: { run: { ...base.runs['run']!, latestEvidence: { kind: 'change.proposed', ref: 'evt_1', at: iso(1) } } } };
    const m = build(snapshot);
    expect(row(m, 'done').branch).toBe('Run: pull request proposed');
    expect(row(m, 'going').branch).toBeNull();
    expect(row(build(snapshotOf({ tasks: [task('done', { status: 'verified' })] })), 'done').branch).toBeNull();
  });

  it('marks a superseded task as replaced, and accepts nothing unverified', () => {
    const m = build(snapshotOf({ tasks: [task('old', { status: 'superseded', supersededByRevision: 3 }), task('run', { status: 'running', revision: 2 })] }));
    expect(row(m, 'old').accepted).toBe('Replaced by rev 3');
    expect(row(m, 'run').accepted).toBeNull();
  });

  it('reuses the attention wording for the next action, and stays quiet for running work', () => {
    const m = build(snapshotOf({
      tasks: [
        task('p', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' }),
        task('run', { status: 'running' }),
      ],
    }));
    expect(row(m, 'p').nextAction).toBe('Run it in a local sandbox with a device model only.');
    expect(row(m, 'run').nextAction).toBe('None while it runs.');
  });

  it('counts tasks in the summary, by what is holding them, without a percentage', () => {
    const m = build(snapshotOf({
      tasks: [
        task('p', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' }),
        task('a', { status: 'awaiting_approval' }),
        task('run', { status: 'running' }),
        task('later', { status: 'planned', dependsOn: ['run'] }),
      ],
      approvals: [approval('apr', { taskId: 'a', taskRevision: 1 })],
    }));
    expect(m.summary).toBe('4 tasks: 1 running, 3 held (1 policy, 1 approval, 1 dependency).');
    expect(m.summary).not.toContain('%');
  });
});

describe('why blocked', () => {
  it('"Why blocked?" names dependency, claim, approval, policy or budget', () => {
    const m = build(snapshotOf({
      tasks: [
        task('dep', { status: 'running', title: 'Feedback API' }),
        task('d', { status: 'planned', dependsOn: ['dep'] }),
        task('c', { status: 'blocked', statusReason: 'resource_conflict:repo/main' }),
        task('a', { status: 'awaiting_approval' }),
        task('p', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' }),
        task('b', { status: 'blocked', statusReason: 'budget:exceeds_limit' }),
        task('u', { status: 'blocked', statusReason: 'budget:unknown_cost' }),
      ],
      approvals: [approval('apr', { taskId: 'a', taskRevision: 1, reason: 'allow_documentation_domain' })],
    }));
    expect(causes(m, 'd')).toEqual(['dependency']);
    expect(why(m, 'd').reasons[0]).toMatchObject({ text: 'Waiting on Feedback API (running).', taskIds: ['dep'] });
    expect(causes(m, 'c')).toEqual(['claim']);
    expect(why(m, 'c').reasons[0]!.text).toContain('repo/main');
    expect(causes(m, 'a')).toEqual(['approval']);
    expect(why(m, 'a').reasons[0]!.text).toBe('Waiting for your decision: Allow documentation domain.');
    expect(causes(m, 'p')).toEqual(['policy']);
    expect(why(m, 'p').reasons[0]!.text).toBe('Restricted data may not reach a cloud destination.');
    expect(causes(m, 'b')).toEqual(['budget']);
    expect(why(m, 'b').reasons[0]!.text).toBe('This would exceed the run\'s budget limit.');
    expect(why(m, 'u').reasons[0]!.text).toBe('The cost of this work cannot be established, so it cannot be checked against the budget.');
  });

  it('uses the shared classification: a repair limit is a failed gate and a missing limit is budget, not policy', () => {
    const m = build(snapshotOf({
      tasks: [
        task('r', { status: 'blocked', statusReason: 'repair_budget_exhausted' }),
        task('l', { status: 'ready', placementBlock: 'policy_denied:missing_budget_limit' }),
        task('s', { status: 'ready', placementBlock: 'no_free_slot' }),
      ],
    }));
    expect(causes(m, 'r')).toEqual(['gate']);
    expect(causes(m, 'l')).toEqual(['budget']);
    expect(causes(m, 's')).toEqual(['capacity']);
    expect(why(m, 's').held).toBe(true);
  });

  it('says a dependency is unknown when it is, rather than guessing', () => {
    const m = build(snapshotOf({ tasks: [task('t', { status: 'planned', dependsOn: null })] }));
    expect(causes(m, 't')).toEqual(['dependency']);
    expect(why(m, 't').reasons[0]).toMatchObject({ unknown: true, text: 'Its dependencies are not known yet, so one may be holding it.' });
  });

  it('says so when the data states no cause', () => {
    const m = build(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: null, dependsOn: [] })] }));
    expect(causes(m, 't')).toEqual(['unstated']);
    expect(why(m, 't').reasons[0]!.text).toBe('It is blocked, and the snapshot does not say why.');
  });

  it('lists every cause it knows and names a dependency that can never finish', () => {
    const m = build(snapshotOf({
      tasks: [
        task('old', { status: 'superseded', title: 'Old', supersededByRevision: 2 }),
        task('t', { status: 'blocked', statusReason: 'policy_denied:missing_policy', dependsOn: ['old'] }),
      ],
    }));
    expect(causes(m, 't')).toEqual(['policy', 'dependency']);
    expect(why(m, 't').reasons[1]!.text).toBe('Depends on Old, which was superseded by revision 2 and cannot finish.');
    expect(m.edges).toEqual([{ from: 'old', to: 't', state: 'stale', label: 'Stale: superseded by rev 2' }]);
  });

  it('reads a pending approval past its expiry as expired, never as granted', () => {
    const m = build(snapshotOf({ tasks: [task('a', { status: 'awaiting_approval' })], approvals: [approval('apr', { taskId: 'a', taskRevision: 1, reason: 'allow_x', expiresAt: iso(5) })] }));
    expect(causes(m, 'a')).toEqual(['approval']);
    expect(why(m, 'a').reasons[0]!.text).toBe('A request expired and was not granted: Allow x.');
  });

  it('a failed check holds the task with its summary, and work moving normally is not held', () => {
    const m = build(snapshotOf({
      tasks: [task('f', { status: 'ready' }), task('run', { status: 'running' }), task('ok', { status: 'verified' }), task('p', { status: 'planned', dependsOn: [] })],
      checks: { c: { checkId: 'ci', taskId: 'f', state: 'failed', summary: '3 of 41 tests failed', updatedAt: iso(2), evidenceRef: 'e' } },
    }));
    expect(causes(m, 'f')).toEqual(['gate']);
    expect(why(m, 'f').reasons[0]!.text).toBe('Check failed: 3 of 41 tests failed. A repair attempt is scheduled.');
    expect(why(m, 'run').held).toBe(false);
    expect(why(m, 'ok').held).toBe(false);
    expect(why(m, 'p').held).toBe(false);
  });

  it('a worker waiting on capacity is capacity, and a lost worker is named', () => {
    const m = build(snapshotOf({
      tasks: [task('c', { status: 'running', activeAttemptId: 'a1' }), task('l', { status: 'running', activeAttemptId: 'a2' })],
      workers: [worker('w1', { taskId: 'c', attemptId: 'a1', activity: 'waiting_resource' }), worker('w2', { taskId: 'l', attemptId: 'a2', lastHeartbeatAt: iso(120) })],
    }));
    expect(causes(m, 'c')).toEqual(['capacity']);
    expect(causes(m, 'l')).toEqual(['worker']);
  });

  it('what changes on approval names who becomes eligible, and never implies finishing', () => {
    const m = build(snapshotOf({
      tasks: [
        task('a', { status: 'awaiting_approval', title: 'Gate' }),
        task('free', { status: 'planned', title: 'Free', dependsOn: ['a'] }),
        task('both', { status: 'planned', title: 'Both', dependsOn: ['a', 'other'] }),
        task('other', { status: 'running', title: 'Other' }),
      ],
      approvals: [approval('apr', { taskId: 'a', taskRevision: 1, reason: 'allow_x' })],
    }));
    const approve = row(m, 'a').ifApproved!;
    expect(approve.eligible.map((t) => t.title)).toEqual(['Free']);
    expect(approve.stillWaiting.map((t) => t.title)).toEqual(['Both']);
    expect(approve.text).toBe('Approving lets this task continue. Nothing here is implied to finish.');
    expect(row(m, 'free').ifApproved).toBeNull();
  });
});

describe('stages', () => {
  it('derives a stage per role and keeps every dependency flowing left to right', () => {
    const m = build(snapshotOf({
      tasks: [
        task('brief', { role: 'planner', status: 'verified' }),
        task('gate', { role: 'reviewer', status: 'verified', dependsOn: ['brief'] }),
        task('api', { role: 'backend', status: 'verified', dependsOn: ['gate'] }),
        task('web', { role: 'frontend', dependsOn: ['gate'] }),
        task('int', { role: 'integration', status: 'planned', dependsOn: ['api', 'web'] }),
        task('e2e', { role: 'verification', status: 'planned', dependsOn: ['int'] }),
        task('rev', { role: 'reviewer', status: 'planned', dependsOn: ['e2e'] }),
      ],
    }));
    expect(['brief', 'gate', 'api', 'web', 'int', 'e2e', 'rev'].map((id) => stageOf(m, id))).toEqual(['discovery', 'contract', 'build', 'build', 'integrate', 'verify', 'review']);
    expect(STAGES.map((s) => s.id)).toEqual(['discovery', 'contract', 'build', 'integrate', 'verify', 'review', 'merged']);
    expect(m.stageNote).toContain('inferred');
  });

  it('moves a finished task right only when nothing depends on it', () => {
    const m = build(snapshotOf({
      tasks: [task('solo', { status: 'merged' }), task('next', { status: 'verifying' }), task('held', { status: 'verified' }), task('after', { status: 'running', dependsOn: ['held'] })],
    }));
    expect(stageOf(m, 'solo')).toBe('merged');
    expect(stageOf(m, 'next')).toBe('verify');
    expect(stageOf(m, 'held')).toBe('build');
  });

  it('never lets a role put a dependency to the right of what needs it', () => {
    const m = build(snapshotOf({ tasks: [task('late', { role: 'verification' }), task('needs', { role: 'backend', dependsOn: ['late'] })] }));
    expect(stageOf(m, 'late')).toBe('build');
    expect(stageOf(m, 'needs')).toBe('build');
  });

  it('keeps finished tasks in place while any dependency is unknown', () => {
    const m = build(snapshotOf({ tasks: [task('done', { status: 'verified' }), task('mystery', { status: 'planned', dependsOn: null })] }));
    expect(stageOf(m, 'done')).toBe('build');
  });

  it('an unknown dependency does not turn a final review into a contract gate', () => {
    const m = build(snapshotOf({ tasks: [task('rev', { role: 'reviewer', status: 'planned', dependsOn: [] }), task('mystery', { status: 'planned', dependsOn: null })] }));
    expect(stageOf(m, 'rev')).toBe('review');
  });

  it('groups rows by stage in pipeline order and drops empty stages', () => {
    const m = build(snapshotOf({ tasks: [task('b', {}), task('i', { role: 'integration', status: 'planned', dependsOn: ['b'] })] }));
    expect(m.stages.map((s) => [s.id, s.rows.map((r) => r.taskId)])).toEqual([['build', ['b']], ['integrate', ['i']]]);
  });

  it('keeps tasks of other runs out, and picks the run it is asked for', () => {
    const base = snapshotOf({ tasks: [task('a', { runId: 'run' }), task('b', { runId: 'other' })] });
    const snapshot = { ...base, runs: { ...base.runs, other: { ...base.runs['run']!, runId: 'other' } } };
    expect(buildPipeline(snapshot, NOW, NOW, { runId: 'other' }).rows.map((r) => r.taskId)).toEqual(['b']);
    expect(buildPipeline(snapshot, NOW, NOW).runs).toEqual(['run', 'other']);
  });
});

describe('longest chain', () => {
  const chain = (over: Parameters<typeof task>[1] = {}) => [
    task('a', { status: 'running' }),
    task('b', { status: 'planned', dependsOn: ['a'] }),
    task('c', { status: 'planned', dependsOn: ['b'], ...over }),
    task('solo', { status: 'running' }),
    task('done', { status: 'verified' }),
  ];

  it('critical-path filter', () => {
    const m = build(snapshotOf({ tasks: chain() }));
    expect(m.critical).toMatchObject({ state: 'known', length: 3, label: 'Longest unfinished chain: 3 tasks' });
    expect(m.critical.label).not.toMatch(/critical|estimate/i);
    expect(filterRows(m.rows, m.critical, { criticalOnly: true }).map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
    expect(filterRows(m.rows, m.critical, { criticalOnly: false })).toHaveLength(5);
    expect(row(m, 'a').critical).toBe(true);
    expect(row(m, 'solo').critical).toBe(false);
    expect(row(m, 'done').critical).toBe(false);
  });

  it('is unknown, not confident, when any unfinished task has null dependencies', () => {
    const m = build(snapshotOf({ tasks: chain({ dependsOn: null }) }));
    expect(m.critical.state).toBe('unknown');
    expect(m.critical.label).toBe('Longest chain unknown: 1 task has not reported its dependencies');
    expect(m.rows.every((r) => !r.critical)).toBe(true);
    expect(filterRows(m.rows, m.critical, { criticalOnly: true })).toHaveLength(5);
  });

  it('ignores null dependencies on tasks already finished', () => {
    const m = build(snapshotOf({ tasks: [...chain(), task('old', { status: 'merged', dependsOn: null })] }));
    expect(m.critical.state).toBe('known');
  });

  it('counts a chain through a dependency missing from the snapshot as unknown', () => {
    const m = build(snapshotOf({ tasks: [task('a', { status: 'planned', dependsOn: ['ghost'] })] }));
    expect(m.critical.state).toBe('unknown');
  });

  it('says there is no chain when no unfinished task waits on another, and the filter stays off', () => {
    const m = build(snapshotOf({ tasks: [task('a'), task('b')] }));
    expect(m.critical).toMatchObject({ state: 'none', label: 'No chain: no unfinished task waits on another' });
    expect(m.rows.every((r) => !r.critical)).toBe(true);
    expect(filterRows(m.rows, m.critical, { criticalOnly: true })).toHaveLength(2);
  });

  it('keeps every task on a tying longest chain, with a note that they tie', () => {
    const m = build(snapshotOf({ tasks: [task('a', { status: 'planned' }), task('b', { status: 'planned' }), task('c', { status: 'planned', dependsOn: ['a'] }), task('d', { status: 'planned', dependsOn: ['b'] })] }));
    expect(m.critical).toMatchObject({ state: 'known', length: 2, label: 'Longest unfinished chain: 2 tasks (2 chains tie)' });
    expect(m.rows.every((r) => r.critical)).toBe(true);
  });

  it('marks only the edges along the chain', () => {
    const m = build(snapshotOf({ tasks: chain() }));
    expect(m.edges.filter((e) => e.critical).map((e) => [e.from, e.to])).toEqual([['a', 'b'], ['b', 'c']]);
  });

  it('is unknown when the plan has a cycle', () => {
    const m = build(snapshotOf({ tasks: [task('a', { status: 'planned', dependsOn: ['b'] }), task('b', { status: 'planned', dependsOn: ['a'] })] }));
    expect(m.critical.state).toBe('unknown');
  });
});

describe('plan integrity', () => {
  it('reports a cycle with its path and highlights the edges without scheduling them', () => {
    const m = build(snapshotOf({ tasks: [task('a', { status: 'planned', title: 'A', dependsOn: ['b'] }), task('b', { status: 'planned', title: 'B', dependsOn: ['a'] })] }));
    expect(m.cycle).toEqual({ ids: ['a', 'b', 'a'], text: 'A → B → A' });
    expect(row(m, 'a').inCycle).toBe(true);
    expect(m.edges.filter((e) => e.state === 'cycle')).toHaveLength(2);
  });

  it('a contract change summarises the replanned tasks and what is not reported', () => {
    const base = snapshotOf({
      tasks: [task('web', { status: 'planned', revision: 2, title: 'Web v2' }), task('api', { status: 'running', revision: 1 }), task('old', { status: 'superseded', supersededByRevision: 2, title: 'Old' })],
      approvals: [approval('apr', { taskId: 'api', taskRevision: 1, reason: 'approve_contract_v2' })],
    });
    const m = build({ ...base, runs: { run: { ...base.runs['run']!, planRevision: 2 } } });
    expect(m.replan).toMatchObject({ planRevision: 2, replanned: ['Web v2'], superseded: ['Old'], decisions: ['Approve contract v2'] });
    expect(m.replan!.unreported).toContain('not in this snapshot');
  });

  it('has no replan summary at plan revision 1', () => {
    expect(build(snapshotOf({ tasks: [task('a')] })).replan).toBeNull();
  });
});

describe('fixtures', () => {
  it('no-data is empty, not zero', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('no-data');
    const m = buildPipeline(snapshot, nowMs, nowMs);
    expect(m.empty).toBe(true);
    expect(m.summary).toBeNull();
    expect(m.critical.state).toBe('none');
  });

  it('contract-change names the approval and the replanned dependency', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('contract-change');
    const m = buildPipeline(snapshot, nowMs, nowMs);
    const web = m.rows.find((r) => r.title.includes('contract v2'))!;
    expect(web.why.reasons.map((r) => r.cause)).toEqual(['dependency']);
    expect(web.why.reasons[0]!.text).toBe('Waiting on Approve contract v1 (needs decision).');
    expect(m.simulated).toBe(true);
    expect(m.replan?.planRevision).toBe(2);
  });

  it('policy-block names policy and approval, not a generic block', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('policy-block');
    const m = buildPipeline(snapshot, nowMs, nowMs);
    expect(m.rows.flatMap((r) => r.why.reasons.map((x) => x.cause)).sort()).toEqual(['approval', 'policy']);
  });

  it('failed-ci reads as a failed gate with a repair scheduled', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('failed-ci');
    const m = buildPipeline(snapshot, nowMs, nowMs);
    expect(m.rows[0]!.why.reasons[0]).toMatchObject({ cause: 'gate', label: 'Failed check' });
    expect(m.rows[0]!.state).toEqual({ label: 'Failed check; repair queued', tone: 'danger' });
    expect(m.rows[0]!.rail).toBe('danger');
  });
});
