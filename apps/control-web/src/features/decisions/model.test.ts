import { describe, expect, it } from 'vitest';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task } from '../overview/testing.ts';
import { buildDecisions, confirmIsStale, type DecisionAction, type DecisionCardModel, type DecisionOptions } from './model.ts';

const live = { mode: 'live' as const, connection: 'live' as const };
const build = (s: ReturnType<typeof snapshotOf>, over: Partial<DecisionOptions> = {}) => buildDecisions(s, NOW, { ...live, ...over });
const labels = (c: DecisionCardModel) => c.actions.map((a) => a.label);
const action = (c: DecisionCardModel, label: string) => c.actions.find((a) => a.label === label) as DecisionAction;
const BARE = /^(continue|ok|okay|approve|yes|confirm|submit|accept)$/i;

function waiting(operation: string | null, over: Parameters<typeof approval>[1] = {}, taskOver: Parameters<typeof task>[1] = {}) {
  return snapshotOf({
    tasks: [task('t', { status: 'awaiting_approval', aggregateRevision: 4, ...taskOver })],
    approvals: [approval('apr', { taskId: 't', taskRevision: 1, operation, ...over })],
  });
}

describe('approval cards', () => {
  it('buttons name the outcome, no bare Continue', () => {
    for (const op of ['start_cloud_worker', 'repair_within_limits', 'breaking_api_change', 'destructive_data_migration', 'future_op']) {
      for (const a of build(waiting(op)).cards[0]!.actions) expect(a.label, op).not.toMatch(BARE);
    }
    const cloud = build(waiting('start_cloud_worker')).cards[0]!;
    expect(labels(cloud)).toEqual(expect.arrayContaining(['Grant cloud start', 'Deny and block task']));
    expect(action(cloud, 'Grant cloud start')).toMatchObject({ kind: 'command', intent: { command: 'approval.grant', expectedRevision: 4, args: { approvalId: 'apr', scopeHash: 's' } } });
  });

  it('labels a worker reason as worker-supplied and a policy reason as policy', () => {
    const worker = build(waiting('breaking_api_change', { reason: 'Clients on v1 will break.' })).cards[0]!;
    expect(worker.reason).toEqual({ label: expect.stringMatching(/worker-supplied/i), text: 'Clients on v1 will break.', source: 'worker' });
    const policy = build(waiting('start_cloud_worker', { reason: 'configured_require_approval:start_cloud_worker' })).cards[0]!;
    expect(policy.reason).toMatchObject({ source: 'policy', text: 'Starting a cloud worker needs your approval.' });
  });

  it('says a breaking API change is a recorded pause, and never that the system prevents it', () => {
    for (const op of ['breaking_api_change', 'destructive_data_migration']) {
      const card = build(waiting(op)).cards[0]!;
      expect(card.advisory).toMatch(/recorded/i);
      expect(card.advisory).not.toMatch(/prevent|block the change|enforce the/i);
      expect(labels(card).join(' ')).toMatch(/record approval/i);
    }
    expect(build(waiting('start_cloud_worker')).cards[0]!.advisory).toBeNull();
  });

  it('shows the structured destination, and offers no grant for one that cannot take effect', () => {
    const card = build(waiting('new_domain', { destination: 'docs.example.com', reason: 'free text about example.org' })).cards[0]!;
    expect(card.facts).toContainEqual({ label: 'Destination', value: 'docs.example.com', mono: true });
    expect(labels(card)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(grant|allow)/i)]));
    expect(card.note).toMatch(/egress|network/i);
    expect(labels(card)).toContain('Deny and block task');
  });

  it('a request naming no operation cannot be granted, and says why', () => {
    const card = build(waiting(null)).cards[0]!;
    expect(labels(card)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^grant/i)]));
    expect(card.note).toMatch(/names no operation/i);
    expect(labels(card)).toContain('Deny and block task');
  });

  it('changed revision → "This request changed", stays pending', () => {
    const s = waiting('breaking_api_change', { taskRevision: 1 }, { revision: 2, status: 'awaiting_approval' });
    const card = build(s).cards[0]!;
    expect(card.state).toBe('changed');
    expect(card.changed?.title).toBe('This request changed');
    for (const a of card.actions) if (a.kind === 'command') expect(a.disabledReason, a.label).toMatch(/changed/i);
    expect(s.approvals['apr']!.state).toBe('pending');
    expect(labels(card)).toEqual(expect.arrayContaining(['Review the updated task']));
  });

  it('a request whose task moved on is also changed, not silently decidable', () => {
    const card = build(waiting('start_cloud_worker', {}, { status: 'ready' })).cards[0]!;
    expect(card.changed?.title).toBe('This request changed');
    expect(card.state).toBe('changed');
  });

  it('expired approvals can be denied and not granted', () => {
    const expired = waiting('start_cloud_worker', { expiresAt: iso(60) });
    const card = build(expired).cards[0]!;
    expect(card.state).toBe('expired');
    expect(labels(card)).not.toEqual(expect.arrayContaining([expect.stringMatching(/grant/i)]));
    expect(action(card, 'Deny and block task').kind).toBe('command');
    const sweptAway = waiting('start_cloud_worker', { state: 'expired' }, { status: 'blocked', statusReason: 'approval_expired' });
    const swept = build(sweptAway).cards[0]!;
    expect(labels(swept)).toContain('Record denial');
    expect(labels(swept)).not.toEqual(expect.arrayContaining([expect.stringMatching(/grant/i)]));
  });

  it('asks for confirmation that names the consequence on a denial and on an advisory approval, and not on a routine grant', () => {
    const deny = action(build(waiting('start_cloud_worker')).cards[0]!, 'Deny and block task');
    expect(deny.kind === 'command' && deny.confirm?.consequence).toMatch(/blocked/i);
    const record = action(build(waiting('destructive_data_migration')).cards[0]!, 'Record approval of destructive migration');
    expect(record.kind === 'command' && record.confirm?.consequence).toMatch(/does not/i);
    const grant = action(build(waiting('start_cloud_worker')).cards[0]!, 'Grant cloud start');
    expect(grant.kind === 'command' && grant.confirm).toBeNull();
  });
});

describe('policy denials', () => {
  it('denied policy shows no approve button', () => {
    const card = build(snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' })] })).cards[0]!;
    expect(card.kind).toBe('policy_deny');
    expect(labels(card).join(' ')).not.toMatch(/approve|grant|allow/i);
    expect(card.note ?? card.summary).toMatch(/policy|cloud/i);
  });

  it('a policy deny mid-flight is the same card', () => {
    const card = build(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'policy_denied:destination_required' })] })).cards[0]!;
    expect(card.kind).toBe('policy_deny');
    expect(labels(card).join(' ')).not.toMatch(/approve|grant|allow/i);
  });
});

describe('disconnected', () => {
  it.each(['reconnecting', 'dead', 'connecting', 'unavailable'] as const)('disables every command while %s, and says why', (connection) => {
    const m = build(waiting('start_cloud_worker'), { connection });
    expect(m.paused).not.toBeNull();
    for (const a of m.cards[0]!.actions) if (a.kind === 'command') expect(a.disabledReason, a.label).toBe(m.paused);
  });

  it('a live connection pauses nothing', () => {
    const m = build(waiting('start_cloud_worker'));
    expect(m.paused).toBeNull();
    expect(action(m.cards[0]!, 'Grant cloud start').disabledReason).toBeNull();
  });
});

describe('budget stop', () => {
  const stopped = () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'verified', title: 'Verified work' }), task('b', { status: 'cancelled', cancelReason: 'budget_exhausted', title: 'Stopped work' }), task('c', { status: 'planned', title: 'Waiting work', aggregateRevision: 2 })] });
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: { notDelivered: { tasks: [{ taskId: 'b', revision: 1, status: 'cancelled', budgetStopped: true }, { taskId: 'c', revision: 1, status: 'planned', budgetStopped: false }], requirementIds: ['FB-2'], acceptanceCheckIds: ['chk-2'] }, notDeliveredHash: 'shown-hash', deliveredRequirementIds: ['FB-1'], stopped: [{ taskId: 'b', revision: 1 }], stoppingTaskIds: [] } };
    return s;
  };

  it('offers reduced scope, a new run and cancel, and lists what is not delivered', () => {
    const card = build(stopped()).cards.find((c) => c.kind === 'budget_stop')!;
    expect(labels(card)).toEqual(['Accept reduced scope', 'Start a new run', 'Cancel "Waiting work"']);
    expect(card.notDelivered?.tasks.map((t) => t.title)).toEqual(['Stopped work', 'Waiting work']);
    expect(card.notDelivered?.requirementIds).toEqual(['FB-2']);
    expect(card.notDelivered?.acceptanceCheckIds).toEqual(['chk-2']);
    const accept = action(card, 'Accept reduced scope');
    expect(accept.kind === 'command' && accept.confirm?.consequence).toMatch(/not delivered/i);
    expect(accept.kind === 'command' && accept.intent).toMatchObject({ command: 'run.accept_reduced_scope', expectedRevision: 1, args: { runId: 'run', notDeliveredHash: 'shown-hash' } });
  });

  it('stops needing a decision once accepted', () => {
    const s = stopped();
    s.runs['run'] = { ...s.runs['run']!, reducedScope: { decisionId: 'd', runId: 'run', planRevision: 1, notDelivered: s.runs['run']!.scopeAssessment!.notDelivered, deliveredRequirementIds: ['FB-1'], acceptedAt: iso(5), acceptedBy: 'owner', note: null } };
    const m = build(s);
    expect(m.cards.find((c) => c.kind === 'budget_stop')).toBeUndefined();
    expect(m.history[0]).toMatchObject({ outcome: 'Accepted reduced scope' });
  });

  it('an assessment that is not known is not read as nothing undelivered', () => {
    const s = stopped();
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: null };
    const card = build(s).cards.find((c) => c.kind === 'budget_stop')!;
    expect(card.notDelivered).toBeNull();
    expect(action(card, 'Accept reduced scope').disabledReason).toMatch(/not known/i);
  });

  it('a stop still in flight cannot be accepted', () => {
    const s = stopped();
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: { ...s.runs['run']!.scopeAssessment!, stoppingTaskIds: ['b'] } };
    expect(action(build(s).cards.find((c) => c.kind === 'budget_stop')!, 'Accept reduced scope').disabledReason).toMatch(/still stopping/i);
  });
});

describe('blocked work', () => {
  it('a resource conflict offers replan and cancel, not re-verify', () => {
    const card = build(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'resource_conflict:db', aggregateRevision: 3 })] })).cards[0]!;
    expect(card.kind).toBe('blocked');
    expect(labels(card)).toEqual(['Replan in the Assistant', 'Cancel task']);
    expect(action(card, 'Cancel task')).toMatchObject({ intent: { command: 'task.cancel', expectedRevision: 3 } });
  });

  it('verification and assembly-infrastructure blocks offer re-verify, one card per run', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'blocked', statusReason: 'verification_error' }), task('b', { status: 'blocked', statusReason: 'assembly_infrastructure:git_failed' })] });
    const cards = build(s).cards.filter((c) => c.kind === 'reverify');
    expect(cards).toHaveLength(1);
    expect(labels(cards[0]!)).toContain('Re-verify the run');
    expect(action(cards[0]!, 'Re-verify the run')).toMatchObject({ intent: { command: 'run.reverify', expectedRevision: 1, args: { runId: 'run' } } });
  });

  it('a failed rebuild offers re-verify only once main has moved and the automatic retry could not start', () => {
    const blocked = (moved: boolean) => {
      const s = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'reverification_failed', aggregateRevision: 3 })] });
      s.runs['run'] = { ...s.runs['run']!, failedRebuildMainMoved: moved };
      return s;
    };
    const card = build(blocked(true)).cards.find((c) => c.id === 'reverify:run')!;
    expect(card).toMatchObject({ chip: 'Rebuild failed' });
    expect(action(card, 'Re-verify the run')).toMatchObject({ intent: { command: 'run.reverify', args: { runId: 'run' } } });
    expect(card.summary).not.toContain('infrastructure failure');
    expect(build(blocked(false)).cards.find((c) => c.id === 'reverify:run')).toBeUndefined();
  });

  describe('an open pull request main has left behind', () => {
    const left = (lifecycle: 'running' | 'ready_for_review', rebuiltSha: string | null, rebuild: 'building' | 'verifying' | 'verified' | 'failed' | 'conflicted' = rebuiltSha === null ? 'building' : lifecycle === 'ready_for_review' ? 'verified' : 'verifying') => {
      const s = snapshotOf({ tasks: [task('t', { status: lifecycle === 'running' ? 'verifying' : 'verified', aggregateRevision: 4 })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle };
      (s as { changeRequests: unknown[] }).changeRequests = [{ runId: 'run', prNumber: 7, url: 'https://github.com/a/b/pull/7', status: 'open', candidateSha: 'a'.repeat(40), baseRef: 'main', observedHeadSha: 'a'.repeat(40), mergeCommitSha: null, observedAt: iso(0), outOfDate: { reason: 'main_moved', at: iso(0), rebuiltSha, rebuild } }];
      return s;
    };
    const card = (s: ReturnType<typeof left>) => build(s).cards.find((c) => c.id === 'review:run')!;

    it('says it plainly from the moment the rebuild starts, before the run is back in review, and does not offer review', () => {
      const c = card(left('running', null));
      expect(c).toMatchObject({ kind: 'reconciliation', chip: 'Pull request out of date', tone: 'warning' });
      expect(c.title).toBe('Pull request #7 no longer holds the verified code');
      expect(c.summary).toContain('Main moved, so the code is being rebuilt');
      expect(c.summary).toContain('The rebuilt commit does not exist yet.');
      expect(c.note).toContain('Close pull request #7 on GitHub, and open the new one once verification passes');
      expect(`${c.title} ${c.summary}`).not.toMatch(/ready for your review/i);
      expect(c.actions.filter((a) => a.kind === 'command')).toEqual([]);
    });
    it('still does once the rebuilt code has passed, and says which stage it is', () => {
      const c = card(left('ready_for_review', 'c'.repeat(40)));
      expect(c.kind).toBe('reconciliation');
      expect(c.summary).toContain('Main moved, so the code was rebuilt');
      expect(c.summary).toContain('The rebuilt code has passed verification.');
      expect(c.actions.filter((a) => a.kind === 'command')).toEqual([]);
    });
    it('names a failed and a conflicted rebuild as such, and neither says it is being rebuilt', () => {
      const failed = card(left('running', null, 'failed'));
      expect(failed.summary).toContain('the rebuild failed');
      const conflicted = card(left('running', null, 'conflicted'));
      expect(conflicted.summary).toContain('could not be rebuilt: it conflicts with main');
      for (const c of [failed, conflicted]) expect(c.summary).not.toContain('is being rebuilt');
    });
  });

  describe('a record that no longer stands', () => {
    // The shape the snapshot route sends: a run in review, a verified task, and the candidate's evidence.
    const withRecord = (recordValid: boolean, over: { state?: 'passed' | 'failed'; lifecycle?: 'ready_for_review' | 'running' | 'merged' | 'cancelled' | 'failed'; pr?: 'open' | 'closed' | 'stale_candidate'; merged?: boolean } = {}) => {
      const s = snapshotOf({ tasks: [task('t', { status: 'verified', aggregateRevision: 4 })] });
      s.runs['run'] = { ...s.runs['run']!, lifecycle: over.lifecycle ?? 'ready_for_review', criteria: { verified: recordValid ? 1 : 0, total: 1 }, evidence: { candidate: { sha: 'a'.repeat(40), status: 'assembled', live: true, baseSha: 'b'.repeat(40), treeSha: null, target: 'main', recordedAt: '2026-11-09T01:00:00.000Z', recordId: 'ver_1', recordValid, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] }, criteria: [{ criterionId: 'FB-01', description: null, state: over.state ?? 'passed', verified: recordValid, taskIds: ['t'], check: null, candidateSha: null }] } };
      if (over.pr) (s as { changeRequests: unknown[] }).changeRequests = [{ runId: 'run', prNumber: 7, url: 'https://github.com/a/b/pull/7', status: over.pr, candidateSha: 'a'.repeat(40), baseRef: 'main', observedHeadSha: 'a'.repeat(40), mergeCommitSha: over.merged ? 'd'.repeat(40) : null, observedAt: '2026-11-09T01:00:00.000Z' }];
      return s;
    };
    const stale = (s: ReturnType<typeof withRecord>) => build(s).cards.find((c) => c.id === 'reverify:run');

    it('offers re-verify, and replan or cancel as the way out at the limit', () => {
      const card = stale(withRecord(false))!;
      expect(card).toMatchObject({ kind: 'reverify', chip: 'Record no longer valid' });
      expect(action(card, 'Re-verify the run')).toMatchObject({ intent: { command: 'run.reverify', args: { runId: 'run' } }, confirm: null });
      expect(labels(card)).toContain('Replan in the Assistant');
      expect(card.actions.find((a) => a.id === 'cancel:t')).toMatchObject({ intent: { command: 'task.cancel', expectedRevision: 4 } });
    });

    it('is not offered on a valid record, a failed row, or a merged or closed run', () => {
      expect(stale(withRecord(true))).toBeUndefined();
      expect(stale(withRecord(false, { state: 'failed' }))).toBeUndefined();
      for (const lifecycle of ['merged', 'failed', 'cancelled'] as const) expect(stale(withRecord(false, { lifecycle }))).toBeUndefined();
    });

    it('reads as nothing ready: no merge-readiness card, no Open PR action', () => {
      for (const pr of [undefined, 'open', 'closed'] as const) {
        const cards = build(withRecord(false, pr ? { pr } : {})).cards;
        expect(cards.filter((c) => c.kind === 'merge_review')).toEqual([]);
        expect(cards.flatMap((c) => c.actions).filter((a) => a.kind === 'command' && a.intent.command === 'run.open_pull_request')).toEqual([]);
      }
      expect(build(withRecord(true)).cards.filter((c) => c.kind === 'merge_review')).toHaveLength(1);
    });

    it('a stale pull request offers no Open PR while the record does not stand', () => {
      const commands = (s: ReturnType<typeof withRecord>) => build(s).cards.flatMap((c) => c.actions).filter((a) => a.kind === 'command' && a.intent.command === 'run.open_pull_request');
      expect(commands(withRecord(false, { pr: 'stale_candidate' }))).toEqual([]);
      expect(commands(withRecord(true, { pr: 'stale_candidate', lifecycle: 'running' }))).toEqual([]);
      expect(commands(withRecord(true, { pr: 'stale_candidate' }))).toHaveLength(1);
    });

    it('warns before re-verifying with a pull request open', () => {
      expect(action(stale(withRecord(false, { pr: 'open' }))!, 'Re-verify the run')).toMatchObject({ confirm: { title: 'Re-verify while pull request #7 is open?', consequence: expect.stringMatching(/held as stale until the verdict\. A passing verdict then records the merge/) } });
    });

    it('the cancel confirmation on the stale card says the candidate is retired, other parts are re-judged and a repair may start', () => {
      const text = (stale(withRecord(false))!.actions.find((a) => a.id === 'cancel:t') as { confirm: { consequence: string } }).confirm.consequence;
      expect(text).toMatch(/retires this candidate/);
      expect(text).toMatch(/other verified parts go back for a new verdict/);
      expect(text).toMatch(/may start a repair worker/);
    });

    it('a stale pull request that already merged does not say merging it would ship', () => {
      const card = (merged: boolean) => build(withRecord(true, { pr: 'stale_candidate', merged })).cards.find((c) => c.kind === 'reconciliation')!;
      expect(card(true).consequence).toMatch(/was merged on GitHub/);
      expect(card(true).consequence).not.toMatch(/would ship/);
      expect(card(false).consequence).toMatch(/would ship/);
    });
  });

  it('demo mode says why replan is off rather than linking to a dead end', () => {
    const card = buildDecisions(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'resource_conflict:db' })] }), NOW, { mode: 'mock', connection: 'live' }).cards[0]!;
    expect(action(card, 'Replan in the Assistant').disabledReason).toMatch(/demo/i);
  });
});

describe('merge readiness', () => {
  const ready = (over: Partial<import('@selarikru/view-protocol').ChangeRequestView> | null, tasks = [task('a', { status: 'verified' })]) => {
    const s = snapshotOf({ tasks, criteria: { verified: 2, total: 2 } });
    s.runs['run'] = { ...s.runs['run']!, lifecycle: 'ready_for_review' };
    if (over) s.changeRequests = [{ runId: 'run', prNumber: 12, url: 'https://github.com/acme/app/pull/12', status: 'open', candidateSha: 'c'.repeat(40), baseRef: 'main', observedHeadSha: 'c'.repeat(40), mergeCommitSha: null, observedAt: iso(30), outOfDate: null, ...over }];
    return s;
  };

  it('a run whose plan gained unfinished work offers no pull request, even if its lifecycle has not caught up yet', () => {
    for (const status of ['planned', 'ready', 'running', 'blocked'] as const) {
      const tasks = [task('a', { status: 'verified' }), task('b', { status })];
      expect(build(ready(null, tasks)).cards.filter((c) => c.kind === 'merge_review'), status).toEqual([]);
      expect(build(ready({}, tasks)).cards.filter((c) => c.kind === 'merge_review'), status).toEqual([]);
      expect(JSON.stringify(build(ready({ status: 'stale_candidate' }, tasks)).cards)).not.toContain('run.open_pull_request');
    }
  });

  it('merge card links to GitHub and offers no merge action', () => {
    const card = build(ready({})).cards[0]!;
    expect(card.kind).toBe('merge_review');
    expect(action(card, 'Open pull request #12 on GitHub')).toMatchObject({ kind: 'link', href: 'https://github.com/acme/app/pull/12', external: true });
    expect(labels(card).join(' ')).not.toMatch(/\bmerge\b/i);
    expect(JSON.stringify(card.actions)).not.toMatch(/"command":"[^"]*merge/i);
  });

  it('never links to something that is not a GitHub pull request', () => {
    const card = build(ready({ url: 'https://evil.example/pull/12' })).cards[0]!;
    expect(action(card, 'Open pull request #12 on GitHub').disabledReason).toMatch(/valid GitHub/i);
  });

  it('a simulated pull request does not pretend to link to GitHub', () => {
    const card = buildDecisions(ready({}), NOW, { mode: 'mock', connection: 'live' }).cards[0]!;
    expect(action(card, 'Open pull request #12 on GitHub').disabledReason).toMatch(/simulated/i);
  });

  it('offers a draft pull request when none exists, naming the blocker when there is undelivered work', () => {
    expect(action(build(ready(null)).cards[0]!, 'Open draft pull request')).toMatchObject({ kind: 'command', intent: { command: 'run.open_pull_request' }, disabledReason: null });
    const s = ready(null, [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: 'budget_exhausted' })]);
    const card = build(s).cards.find((c) => c.kind === 'merge_review')!;
    expect(action(card, 'Open draft pull request').disabledReason).toMatch(/reduced scope/i);
  });

  it('merged_sha_mismatch is its own danger card, with the SHAs, and no merge language', () => {
    const card = build(ready({ status: 'merged_sha_mismatch', observedHeadSha: 'e'.repeat(40), mergeCommitSha: 'd'.repeat(40) })).cards[0]!;
    expect(card.kind).toBe('reconciliation');
    expect(card.tone).toBe('danger');
    expect(card.title).toMatch(/does not match/i);
    expect(card.details).toContainEqual({ label: 'Verified candidate', value: 'c'.repeat(40) });
  });

  it('a stale candidate can open a new draft pull request', () => {
    const card = build(ready({ status: 'stale_candidate' })).cards[0]!;
    expect(card.kind).toBe('reconciliation');
    expect(labels(card)).toContain('Open draft pull request');
  });
});

describe('fingerprints and the queue', () => {
  it('a new revision or scope changes the fingerprint, a clock tick does not', () => {
    const a = buildDecisions(waiting('start_cloud_worker'), NOW, live).cards[0]!;
    const later = buildDecisions(waiting('start_cloud_worker'), NOW + 5000, live).cards[0]!;
    expect(later.fingerprint).toBe(a.fingerprint);
    const rescoped = buildDecisions(waiting('start_cloud_worker', { scopeHash: 'other' }), NOW, live).cards[0]!;
    expect(rescoped.fingerprint).not.toBe(a.fingerprint);
    const revised = buildDecisions(waiting('start_cloud_worker', {}, { aggregateRevision: 9 }), NOW, live).cards[0]!;
    expect(revised.fingerprint).not.toBe(a.fingerprint);
  });

  it('expired requests sort after live ones, and the queue counts what is waiting', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'awaiting_approval' }), task('b', { status: 'awaiting_approval' })], approvals: [approval('old', { taskId: 'a', taskRevision: 1, operation: 'start_cloud_worker', expiresAt: iso(9) }), approval('live', { taskId: 'b', taskRevision: 1, operation: 'start_cloud_worker' })] });
    const m = build(s);
    expect(m.cards.map((c) => c.id)).toEqual(['decision:live', 'decision:old']);
    expect(m.waiting).toBe(2);
  });

  it('every fixture produces cards a person can read, with no bare button', async () => {
    for (const id of ['policy-block', 'human-wait', 'expired-approval', 'contract-change', 'decision-queue', 'changed-request', 'budget-stop', 'integration-blocked', 'merge-review', 'merged-sha-mismatch', 'merge-flow'] as const) {
      const { snapshot, nowMs } = await fixtureSnapshot(id);
      const m = buildDecisions(snapshot, nowMs, { mode: 'mock', connection: 'live' });
      expect(m.cards.length, id).toBeGreaterThan(0);
      for (const c of m.cards) for (const a of c.actions) expect(a.label, `${id}/${c.id}`).not.toMatch(BARE);
    }
  });
});

/** Built the way `GET /v1/projects/:id/snapshot` builds it: a stopped task carries no cancel reason, and the run's assessment says what stopped. */
function realShape() {
  const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: null, title: 'Stopped' })] });
  s.runs['run'] = { ...s.runs['run']!, scopeAssessment: { notDelivered: { tasks: [{ taskId: 'b', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: ['FB-2'], acceptanceCheckIds: [] }, notDeliveredHash: 'h1', deliveredRequirementIds: ['FB-1'], stopped: [{ taskId: 'b', revision: 1 }], stoppingTaskIds: [] } };
  return s;
}

describe('a snapshot shaped like the real route', () => {
  it('keeps the budget card with no cancel reason on the task', () => {
    const card = build(realShape()).cards.find((c) => c.kind === 'budget_stop');
    expect(card).toBeDefined();
    expect(action(card!, 'Accept reduced scope').disabledReason).toBeNull();
  });

  it('turns Accept off when the view knows of a stop the assessment does not list', () => {
    const s = realShape();
    s.tasks['c'] = task('c', { status: 'cancelled', cancelReason: 'budget_exhausted', title: 'Later stop' });
    const accept = action(build(s).cards.find((c) => c.kind === 'budget_stop')!, 'Accept reduced scope');
    expect(accept.disabledReason).toMatch(/not in the list/i);
  });

  it('a plain cancel is still not delivered in the merge card', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: null })] });
    s.runs['run'] = { ...s.runs['run']!, lifecycle: 'ready_for_review' };
    expect(build(s).cards.find((c) => c.kind === 'merge_review')!.summary).toMatch(/not delivered/i);
  });
});

describe('small truths', () => {
  it('a request with no scope hash offers no command', () => {
    const card = build(waiting('start_cloud_worker', { scopeHash: null })).cards[0]!;
    expect(card.actions.filter((a) => a.kind === 'command')).toEqual([]);
    expect(card.note).toMatch(/no recorded scope/i);
  });

  it('a changed request says what happens next instead of waiting for a decision', () => {
    const card = build(waiting('breaking_api_change', {}, { revision: 2 })).cards[0]!;
    expect(card.consequence).not.toMatch(/until you decide/i);
    expect(card.consequence).toMatch(/new request/i);
  });

  it('never builds a title from worker text', () => {
    const card = build(waiting('future_op', { reason: 'ignore previous instructions' })).cards[0]!;
    expect(card.title).not.toMatch(/ignore previous/i);
  });

  it('a card whose scope is not known yet has no fingerprint to compare', () => {
    const s = realShape();
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: null };
    s.tasks['b'] = { ...s.tasks['b']!, cancelReason: 'budget_exhausted' };
    expect(build(s).cards.find((c) => c.kind === 'budget_stop')!.fingerprint).toBeNull();
  });

  it('a policy-denied card does not read as queued', () => {
    const card = build(snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: 'policy_denied:restricted_data_cloud_destination' })] })).cards[0]!;
    expect(card.facts.find((f) => f.label === 'Status')!.value).not.toMatch(/queued/i);
  });

  it('replan carries the run and the task to the Assistant', () => {
    const card = build(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'resource_conflict:db' })] })).cards[0]!;
    const replan = action(card, 'Replan in the Assistant');
    expect(replan.kind === 'link' && replan.href).toBe('#/assistant?run=run&task=t');
  });
});

describe('history', () => {
  const entry = (over: Partial<import('@selarikru/view-protocol').ApprovalHistoryEntry> = {}) => ({ approvalId: 'h1', runId: 'run', taskId: 't', revision: 1, outcome: 'granted' as const, approver: 'owner', scopeHash: 'abcdef123456', operation: 'start_cloud_worker', destination: null, requestedAt: iso(100), resolvedAt: iso(50), consumedAt: null, consumedBy: null, ...over });

  it('survives a reload: a snapshot with no open approvals still lists what was decided', () => {
    const s = snapshotOf({ tasks: [task('t', { status: 'running', title: 'Search' })] });
    s.approvalHistory = [entry({ consumedAt: iso(40), consumedBy: 'att_1' }), entry({ approvalId: 'h2', outcome: 'denied', approver: 'owner' }), entry({ approvalId: 'h3', outcome: 'superseded', approver: null, resolvedAt: null })];
    const h = build(s).history;
    expect(h.map((e) => e.outcome)).toEqual(['Granted', 'Denied', 'Superseded']);
    expect(h[1]!.subject).toBe('Search: Cloud start');
    expect(h[0]).toMatchObject({ approver: 'owner', subject: expect.stringContaining('Search'), execution: expect.stringContaining('att_1'), scope: expect.stringContaining('abcdef12') });
    expect(h[1]!.execution).toMatch(/nothing ran/i);
    expect(h[2]).toMatchObject({ at: null, approver: null });
  });

  it('a session decision the server has not reported says the result is not known', () => {
    const s = waiting('start_cloud_worker', { state: 'granted', resolvedAt: iso(5) }, { status: 'ready' });
    const [e] = build(s).history;
    expect(e).toMatchObject({ outcome: 'Granted', approver: null, execution: expect.stringMatching(/not reported/i) });
  });

  it('prefers the server record over the session copy, and does not list an open card', () => {
    const s = waiting('start_cloud_worker', { state: 'granted', resolvedAt: iso(5) }, { status: 'ready' });
    s.approvalHistory = [entry({ approvalId: 'apr', approver: 'owner' })];
    expect(build(s).history).toHaveLength(1);
    expect(build(s).history[0]!.approver).toBe('owner');
    const open = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'approval_expired' })], approvals: [approval('apr', { taskId: 't', taskRevision: 1, state: 'expired', operation: 'start_cloud_worker' })] });
    open.approvalHistory = [entry({ approvalId: 'apr', outcome: 'expired' })];
    expect(build(open).history).toEqual([]);
  });
});

describe('carried follow-ups', () => {
  const history = (approvals: Parameters<typeof approval>[1][], approvalHistory: ReturnType<typeof snapshotOf>['approvalHistory'] = []) => build({ ...snapshotOf({ approvals: approvals.map((a) => approval(a?.approvalId ?? 'x', a)) }), approvalHistory }).history;
  it('an expired or superseded row never says the approver is not reported yet', () => {
    const entry = { runId: 'r', taskId: null, revision: 1, approver: null, scopeHash: 's', operation: null, destination: null, requestedAt: iso(0), resolvedAt: iso(1), consumedAt: null, consumedBy: null };
    const rows = history([], [{ ...entry, approvalId: 'a', outcome: 'expired' }, { ...entry, approvalId: 'b', outcome: 'superseded' }, { ...entry, approvalId: 'c', outcome: 'denied' }]);
    expect(rows.find((h) => h.id === 'a')!.attribution).toBe('Expired with no decision');
    expect(rows.find((h) => h.id === 'b')!.attribution).toBe('Replaced before a decision');
    expect(rows.find((h) => h.id === 'c')!.attribution).toBe('Approver not reported yet');
    const local = history([{ approvalId: 'd', state: 'superseded', resolvedAt: iso(2) }]);
    expect(local.find((h) => h.id === 'd')!.attribution).toBe('Replaced before a decision');
    expect(history([], [{ ...entry, approvalId: 'e', outcome: 'granted', approver: 'owner' }])[0]!.attribution).toBe('By owner');
  });

  it('a confirmation is stale once its action is disabled, even when the fingerprint is the same', () => {
    const card = { id: 'c', fingerprint: 'f' } as DecisionCardModel;
    const on = { kind: 'command', disabledReason: null } as Extract<DecisionAction, { kind: 'command' }>;
    expect(confirmIsStale('live', card, on, 'f')).toBe(false);
    expect(confirmIsStale('live', card, { ...on, disabledReason: 'A task stopped that is not in the list below yet.' }, 'f')).toBe(true);
    expect(confirmIsStale('live', card, on, 'other')).toBe(true);
    expect(confirmIsStale('reconnecting', card, on, 'f')).toBe(true);
    expect(confirmIsStale('live', null, on, 'f')).toBe(true);
    expect(confirmIsStale('live', card, null, 'f')).toBe(true);
  });

  it('merge evidence leaves deliberately cancelled tasks out of the count and names them', () => {
    const base = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'verified' }), task('c', { status: 'cancelled', cancelReason: 'cancel_requested' })] });
    const snap = { ...base, runs: { run: { ...base.runs['run']!, lifecycle: 'ready_for_review' as const } } };
    const card = build(snap).cards.find((c) => c.kind === 'merge_review')!;
    expect(card.summary).toContain('2 of 2 tasks verified');
    expect(card.summary).toMatch(/1 deliberately cancelled task is not counted/);
  });
});

describe('a budget refusal on a task', () => {
  it('becomes a Decisions card with what to do', () => {
    const cards = build(snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: 'budget:exceeds_limit' })] })).cards;
    const card = cards.find((c) => c.id === 'placement:t')!;
    expect(card.summary).toMatch(/exceed/i);
    expect(card.facts.find((f) => f.label === 'Next')!.value).toMatch(/start a new run/i);
  });
});

describe('after the run budget is spent', () => {
  const START = { kind: 'command', intent: { command: 'run.start_new', expectedRevision: 0, args: { projectId: 'p', title: 'Follow-up run' } } };
  const cases: [string, ReturnType<typeof snapshotOf>][] = [
    ['repair budget exhausted', snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'repair_budget_exhausted' })] })],
    ['repair limit exhausted', snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'repair_limit_exhausted' })] })],
    ['a budget refusal', snapshotOf({ tasks: [task('t', { status: 'ready', placementBlock: 'budget:exceeds_limit' })] })],
  ];
  it.each(cases)('%s offers a new run and cancel, not a replan that would be refused', (_n, snap) => {
    const card = build(snap).cards.find((c) => c.id === 'placement:t')!;
    expect(labels(card)).toEqual(['Start a new run', 'Cancel task']);
    expect(action(card, 'Start a new run')).toMatchObject(START);
    expect(action(card, 'Start a new run').disabledReason).toBeNull();
    expect(card.facts.find((f) => f.label === 'Next')!.value).toMatch(/start a new run/i);
    expect(card.consequence + card.summary).not.toMatch(/replan/i);
  });
  it('says what it costs: the amount, and that it comes on top of what was spent', () => {
    const s = cases[0]![1];
    s.runs['run'] = { ...s.runs['run']!, budgetLimitUsd: 25 };
    const a = action(build(s).cards.find((c) => c.id === 'placement:t')!, 'Start a new run');
    expect(a.kind === 'command' && a.confirm?.consequence).toMatch(/\$25/);
    expect(a.kind === 'command' && a.confirm?.consequence).toMatch(/in addition to/i);
  });
  it('does not state an amount it does not know', () => {
    const fresh = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'repair_budget_exhausted' })] });
    const a = action(build(fresh).cards.find((c) => c.id === 'placement:t')!, 'Start a new run');
    expect(a.kind === 'command' && a.confirm?.consequence).not.toMatch(/\$/);
  });
  it('is disabled, with a reason, once a newer run with no tasks exists, so a second click cannot start another', () => {
    const s = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'repair_budget_exhausted' })] });
    s.runs['run_new'] = { ...s.runs['run']!, runId: 'run_new', lifecycle: 'planning', planRevision: 0 };
    for (const snap of [s]) {
      const card = build(snap).cards.find((c) => c.id === 'placement:t')!;
      expect(action(card, 'Start a new run').disabledReason).toMatch(/new run.*no plan|no plan.*new run/i);
    }
    // Once that run has tasks it is real work, and the block is no longer the way forward only there.
    const planned = snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'repair_budget_exhausted' })] });
    expect(action(build(planned).cards.find((c) => c.id === 'placement:t')!, 'Start a new run').disabledReason).toBeNull();
  });
  it('is enabled under demo data, where the mock mirrors it', () => {
    const card = build(cases[0]![1], { mode: 'mock' }).cards.find((c) => c.id === 'placement:t')!;
    expect(action(card, 'Start a new run').disabledReason).toBeNull();
  });
  it('is held while the connection is not live', () => {
    const card = build(cases[0]![1], { connection: 'reconnecting' } as Partial<DecisionOptions>).cards.find((c) => c.id === 'placement:t')!;
    expect(action(card, 'Start a new run').disabledReason).not.toBeNull();
  });
  it('a budget stop offers accept, a new run and cancel, and no replan', () => {
    const s = snapshotOf({ tasks: [task('b', { status: 'cancelled', cancelReason: 'budget_exhausted', title: 'Stopped work' })] });
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: { notDelivered: { tasks: [{ taskId: 'b', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: [], acceptanceCheckIds: [] }, notDeliveredHash: 'h', deliveredRequirementIds: [], stopped: [{ taskId: 'b', revision: 1 }], stoppingTaskIds: [] } };
    const card = build(s).cards.find((c) => c.kind === 'budget_stop')!;
    expect(labels(card)).toEqual(['Accept reduced scope', 'Start a new run']);
    expect(action(card, 'Start a new run')).toMatchObject(START);
  });
  it('other blocks keep their replan', () => {
    expect(labels(build(snapshotOf({ tasks: [task('t', { status: 'blocked', statusReason: 'resource_conflict:db' })] })).cards[0]!)).toContain('Replan in the Assistant');
  });
});

