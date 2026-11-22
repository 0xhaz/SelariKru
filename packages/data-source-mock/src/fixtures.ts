import type { ChangeRequestView } from '@selarikru/view-protocol';
import { DEMO_ASSIGNMENT, FixtureBuilder, HUMAN, INTEGRATION, REAPER, figure, fixtureTime, scoped, type Fixture, type FixtureId } from './builder.ts';

/**
 * Ten named scenarios. Each is a stream of real domain events (the payload fields the services emit today), a fixed start time, usage
 * figures with provenance, and what the server would add to a snapshot (task titles and dependencies, approval ids and expiries, heartbeat
 * times). Heartbeats are never events. Nothing reads a clock or a random source. Every fixture is checked against the domain state machine
 * and the 2-concurrent limit by a test.
 */
const LOCAL = 'runner_local_1';
const LOCAL2 = 'runner_local_2';
const CLOUD = 'runner_cloud_1';
const ASSISTANT_DEVICE = { mode: 'PREFER_ON_DEVICE', observedSource: 'on_device' } as const;
/** The Project Manager, as the services record it on a delegation (H11). */
const PM_AGENT = { kind: 'agent', id: 'pm' } as const;

function done(b: FixtureBuilder, f: Omit<Fixture, 'projectId' | 'events' | 'tasks' | 'approvals' | 'silences'>): Fixture {
  return { ...f, projectId: b.projectId, events: b.buildEvents(), tasks: b.taskSeeds, approvals: b.approvalSeeds, silences: b.silences, budgetStopping: b.budgetStopping };
}
const tokens = (b: FixtureBuilder, t: string, a: string, prov: 'observed' | 'estimated' | 'unavailable', src: string, qty: [string | null, string | null]) => [
  b.use(t, a, figure('input_tokens', qty[0], prov, src)),
  b.use(t, a, figure('output_tokens', qty[1], prov, src)),
];

function healthyParallelWork(): Fixture {
  const b = new FixtureBuilder('healthy-parallel-work', 101);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 3 }).task('web', { title: 'Feedback list UI', role: 'frontend', criteria: 2 });
  b.plan(1, ['api', 'web']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud').ready('web', 5).start('web', 'att_web_1', 7, CLOUD, 'cloud', 'cloud');
  b.complete('api', 'att_api_1', 135, LOCAL).verdict('api', 'att_api_1', 160, 'passed', { checkId: 'ci:api', summary: '38 of 38 checks passed' });
  return done(b, {
    id: 'healthy-parallel-work', name: 'Healthy parallel work', startSec: 125, assistant: ASSISTANT_DEVICE,
    description: 'Two workers run in parallel, one local sandbox and one cloud sandbox, both calling cloud models. The assistant runs on the device. Different axes.',
    usage: [
      ...tokens(b, 'api', 'att_api_1', 'estimated', 'worker_report', ['41200', '9100']),
      b.use('api', 'att_api_1', figure('cost_usd', '0.42', 'estimated', 'rate_card')),
      b.use('api', 'att_api_1', figure('worker_seconds', '119', 'observed', 'controller_clock')),
      ...tokens(b, 'web', 'att_web_1', 'estimated', 'worker_report', ['38800', '7700']),
      b.use('web', 'att_web_1', figure('cost_usd', '0.37', 'estimated', 'rate_card')),
      b.use('web', 'att_web_1', figure('worker_seconds', '118', 'observed', 'controller_clock')),
    ],
  });
}

function humanWait(): Fixture {
  const b = new FixtureBuilder('human-wait', 202);
  b.task('migrate', { title: 'Add feedback table', role: 'backend', criteria: 2 }).task('ui', { title: 'Empty states', role: 'frontend', criteria: 3 });
  b.approval('apr_docs_domain', { task: 'migrate', scopeHash: 'scope-docs-domain', reason: 'Backfilling rewrites every row of the feedback table.', expiresAtSec: 3640, operation: 'destructive_data_migration' });
  b.plan(1, ['migrate', 'ui']).ready('migrate', 5).start('migrate', 'att_mig_1', 6, LOCAL, 'local', 'cloud').ready('ui', 5).start('ui', 'att_ui_1', 7, CLOUD, 'cloud', 'cloud');
  b.emit('approval.requested', 40, { task: 'migrate', attempt: 'att_mig_1', payload: { fence: 1, reason: 'Backfilling rewrites every row of the feedback table.', operation: 'destructive_data_migration' } });
  // A grant releases the task to `ready` by itself; the scheduler then claims it again.
  b.emit('approval.granted', 150, { task: 'migrate', actor: HUMAN, payload: { approvalId: b.id('apr_docs_domain'), scopeHash: 'scope-docs-domain', actionHash: 'action-docs-domain' } });
  b.start('migrate', 'att_mig_2', 155, LOCAL, 'local', 'cloud', 2);
  return done(b, {
    id: 'human-wait', name: 'Human wait', startSec: 90, assistant: ASSISTANT_DEVICE,
    description: 'One task waits for a person to record a decision on a destructive migration. Its worker shows waiting_human; the other keeps working.',
    usage: [b.use('migrate', 'att_mig_1', figure('cost_usd', '0.11', 'estimated', 'rate_card')), b.use('ui', 'att_ui_1', figure('cost_usd', '0.19', 'estimated', 'rate_card'))],
  });
}

function policyBlock(): Fixture {
  const b = new FixtureBuilder('policy-block', 303);
  b.task('export', { title: 'Export restricted feedback', role: 'backend', criteria: 2 }).task('report', { title: 'Weekly report job', role: 'backend', criteria: 1 }).task('lint', { title: 'Lint cleanup', role: 'frontend', criteria: 1 });
  b.plan(1, ['export', 'report', 'lint']).ready('export', 5).ready('report', 5).ready('lint', 5).start('lint', 'att_lint_1', 8, LOCAL, 'local', 'cloud');
  b.emit('placement.blocked', 6, { task: 'export', payload: { reason: 'policy_denied:restricted_data_cloud_destination', mode: 'local-first' } });
  b.emit('placement.blocked', 7, { task: 'report', payload: { reason: 'approval_required:cloud_start', mode: 'local-first' } });
  b.emit('placement.blocked', 100, { task: 'report', payload: { reason: 'policy_denied:missing_budget_limit', mode: 'local-first' } });
  return done(b, {
    id: 'policy-block', name: 'Policy block', startSec: 60, assistant: { mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' },
    description: 'Two tasks cannot be placed: restricted data may not reach the cloud, and a cloud start needs approval. A missing budget blocks, it is never unlimited.',
    usage: [b.use('lint', 'att_lint_1', figure('cost_usd', '0.05', 'estimated', 'rate_card'))],
  });
}

function runnerLoss(): Fixture {
  const b = new FixtureBuilder('runner-loss', 404);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 3 });
  b.plan(1, ['api']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.silence('att_api_1', 46, null); // the runner stops answering; nothing is emitted until the lease reaper acts
  // The reaper's two events, as the service writes them: the attempt is interrupted, then the task is ready again.
  b.emit('attempt.failed', 112, { task: 'api', attempt: 'att_api_1', actor: REAPER, payload: { fence: 1, reason: 'lease_expired', outcome: 'interrupted' } });
  b.emit('task.ready', 112, { task: 'api', attempt: 'att_api_1', bump: false, payload: { reason: 'lease_expired' } });
  b.start('api', 'att_api_2', 124, LOCAL2, 'local', 'cloud', 2);
  return done(b, {
    id: 'runner-loss', name: 'Runner loss', startSec: 108, assistant: ASSISTANT_DEVICE,
    description: 'The local runner stopped answering. The worker shows disconnected with no activity invented; it is not shown idle or finished. The lease reaper then interrupts the attempt and a new one follows.',
    usage: [b.use('api', 'att_api_1', figure('cost_usd', null, 'unavailable', 'lease_reaper')), b.use('api', 'att_api_1', figure('worker_seconds', null, 'unavailable', 'lease_reaper'))],
  });
}

function longBuildStall(): Fixture {
  const b = new FixtureBuilder('long-build-stall', 505);
  b.task('web', { title: 'Production build of the web client', role: 'frontend' });
  b.plan(1, ['web']).ready('web', 5).start('web', 'att_web_1', 6, LOCAL, 'local', 'cloud');
  b.silence('att_web_1', 56, 100); // no heartbeat for 44 s, then it resumes
  b.complete('web', 'att_web_1', 130, LOCAL);
  return done(b, {
    id: 'long-build-stall', name: 'Long-build stall', startSec: 95, assistant: ASSISTANT_DEVICE, reportsActivity: false,
    description: 'No heartbeat for over 30 seconds, probably during a long build. That is a suspected stall: not a lost connection and not a failure. The task stays running; the heartbeat resumes later.',
    usage: [b.use('web', 'att_web_1', figure('cost_usd', '0.09', 'estimated', 'rate_card'))],
  });
}

function contractChange(): Fixture {
  const b = new FixtureBuilder('contract-change', 606);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 2 }).task('contract', { title: 'Approve contract v1', role: 'reviewer', criteria: 1 })
    .task('web', { title: 'Feedback list UI', role: 'frontend', dependsOn: ['contract'], criteria: 3 })
    .task('web', { title: 'Feedback list UI (contract v2)', role: 'frontend', dependsOn: ['contract'], revision: 2, planRevision: 2, criteria: 3 });
  b.approval('apr_contract_v2', { task: 'contract', scopeHash: 'scope-contract-v2', reason: 'The contract renames a field that clients depend on.', expiresAtSec: 7265, operation: 'breaking_api_change' });
  b.plan(1, ['api', 'contract', 'web']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud').ready('contract', 5).start('contract', 'att_con_1', 7, CLOUD, 'cloud', 'cloud');
  b.emit('approval.requested', 40, { task: 'contract', attempt: 'att_con_1', payload: { fence: 1, reason: 'The contract renames a field that clients depend on.', operation: 'breaking_api_change' } });
  // The revised plan is a single event. Nothing says which tasks changed except the ids; the snapshot carries the new revision.
  b.plan(2, ['web'], 60);
  b.emit('approval.granted', 140, { task: 'contract', actor: HUMAN, payload: { approvalId: b.id('apr_contract_v2'), scopeHash: 'scope-contract-v2', actionHash: 'action-contract-v2' } });
  b.start('contract', 'att_con_2', 150, CLOUD, 'cloud', 'cloud', 2);
  return done(b, {
    id: 'contract-change', name: 'Contract change', startSec: 120, assistant: ASSISTANT_DEVICE,
    description: 'The plan moved to revision 2 and the UI task was replanned at revision 2. The contract task waits for a person to approve contract v2.',
    usage: [b.use('api', 'att_api_1', figure('cost_usd', '0.31', 'estimated', 'rate_card')), b.use('contract', 'att_con_1', figure('cost_usd', '0.06', 'estimated', 'rate_card'))],
  });
}

function failedCi(): Fixture {
  const b = new FixtureBuilder('failed-ci', 707);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 4 });
  b.plan(1, ['api']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.complete('api', 'att_api_1', 50, LOCAL).verdict('api', 'att_api_1', 90, 'failed', { checkId: 'ci:unit', summary: '3 of 41 tests failed' });
  b.start('api', 'att_api_2', 135, LOCAL, 'local', 'cloud', 2);
  return done(b, {
    id: 'failed-ci', name: 'Failed CI', startSec: 100, assistant: ASSISTANT_DEVICE,
    description: 'The unit-test check failed. The failed check stays visible as evidence and the first attempt is recorded as failed. Policy scheduled a repair, so the task is ready again; the worker did not decide that.',
    usage: [...tokens(b, 'api', 'att_api_1', 'estimated', 'worker_report', ['52000', '11800']), b.use('api', 'att_api_1', figure('cost_usd', '0.58', 'estimated', 'rate_card'))],
  });
}

function expiredApproval(): Fixture {
  const b = new FixtureBuilder('expired-approval', 808);
  b.task('docs', { title: 'Vendor API client', role: 'backend', criteria: 1 });
  b.approval('apr_vendor_docs', { task: 'docs', scopeHash: 'scope-vendor-docs', reason: 'The client changes its public response shape.', expiresAtSec: 640, operation: 'breaking_api_change' });
  b.plan(1, ['docs']).ready('docs', 5).start('docs', 'att_docs_1', 6, CLOUD, 'cloud', 'cloud');
  b.emit('approval.requested', 40, { task: 'docs', attempt: 'att_docs_1', payload: { fence: 1, reason: 'The client changes its public response shape.', operation: 'breaking_api_change' } });
  return done(b, {
    id: 'expired-approval', name: 'Expired approval', startSec: 700, assistant: { mode: 'PREFER_IN_CLOUD', observedSource: 'in_cloud' },
    description: 'An approval request passed its expiry. It reads as expired and the task stays awaiting approval; expiry is an explicit outcome and never a grant.',
    usage: [b.use('docs', 'att_docs_1', figure('cost_usd', '0.02', 'estimated', 'rate_card'))],
  });
}

function unknownCosts(): Fixture {
  const b = new FixtureBuilder('unknown-costs', 909);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 3 }).task('web', { title: 'Feedback list UI', role: 'frontend', criteria: 2 }).task('batch', { title: 'Bulk import', role: 'backend', criteria: 2 });
  b.plan(1, ['api', 'web', 'batch']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud').ready('web', 5).start('web', 'att_web_1', 7, CLOUD, 'cloud', 'unknown');
  // Two slots are taken, so `batch` is ready but waits; it starts when `web` ends its attempt.
  b.ready('batch', 5);
  b.complete('web', 'att_web_1', 60, CLOUD).verdict('web', 'att_web_1', 70, 'passed', { checkId: 'ci:web', summary: 'all checks passed' });
  b.start('batch', 'att_batch_1', 62, LOCAL2, 'local', 'cloud');
  b.emit('task.cancelled', 150, { task: 'batch', attempt: 'att_batch_1', actor: REAPER, payload: { reason: 'budget_exhausted', attemptId: b.id('att_batch_1'), cause: 'budget_exhausted' } });
  b.complete('api', 'att_api_1', 230, LOCAL);
  return done(b, {
    id: 'unknown-costs', name: 'Unknown costs', startSec: 200, assistant: { mode: null, observedSource: 'unknown' },
    description: 'Some figures are observed, some estimated, some unavailable. Unavailable is unknown, never zero, so run totals stay unknown. One task was stopped for budget.',
    usage: [
      ...tokens(b, 'api', 'att_api_1', 'observed', 'provider_response', ['120400', '30210']),
      b.use('api', 'att_api_1', figure('cost_usd', '1.24', 'estimated', 'rate_card')),
      b.use('api', 'att_api_1', figure('worker_seconds', '190', 'observed', 'controller_clock')),
      ...tokens(b, 'web', 'att_web_1', 'unavailable', 'harness_report', [null, null]),
      b.use('web', 'att_web_1', figure('cost_usd', null, 'unavailable', 'harness_report')),
      b.use('web', 'att_web_1', figure('worker_seconds', '53', 'observed', 'controller_clock')),
      ...tokens(b, 'batch', 'att_batch_1', 'estimated', 'worker_report', ['88000', '9400']),
      b.use('batch', 'att_batch_1', figure('cost_usd', '2.50', 'estimated', 'rate_card')),
      b.use('batch', 'att_batch_1', figure('worker_seconds', null, 'unavailable', 'lease_reaper')),
    ],
  });
}

function noData(): Fixture {
  return {
    id: 'no-data', name: 'No data', projectId: 'demo-no-data', startSec: 0, modelCatalog: { status: 'none', detail: 'No runner has reported an installed harness, so no model can be assigned or started.', projectDefault: null, codingWorkers: 'off', providers: [] }, events: [], usage: [], assistant: { mode: null, observedSource: 'unknown' }, tasks: [], approvals: [], silences: {},
    description: 'A project with no runs, tasks, workers or usage. Empty states render as empty, not as zeros.',
  };
}

function mergeFlow(): Fixture {
  const b = new FixtureBuilder('merge-flow', 1111);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 3, requirements: ['FB-01', 'FB-02', 'FB-03'] }).task('web', { title: 'Feedback list UI', role: 'frontend', criteria: 2, requirements: ['FB-04', 'FB-05'] });
  b.plan(1, ['api', 'web']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud').ready('web', 5).start('web', 'att_web_1', 7, CLOUD, 'cloud', 'cloud');
  // The candidate is assembled before anything judges it: verification runs on the assembled commit.
  b.complete('api', 'att_api_1', 40, LOCAL).complete('web', 'att_web_1', 45, CLOUD).emit('candidate.assembled', 47, { actor: INTEGRATION, payload: { candidateId: 'cand_1' } });
  b.verdict('api', 'att_api_1', 50, 'passed', { checkId: 'ci:api', summary: 'all checks passed' });
  // The last verdict makes the run ready for review in the same transaction, with no event: the snapshot says so.
  b.verdict('web', 'att_web_1', 55, 'passed', { checkId: 'ci:web', summary: 'all checks passed' });
  b.emit('change.proposed', 65, { actor: INTEGRATION, payload: { prNumber: 12, url: 'https://github.com/selarikru-demo/feedback-board/pull/12' } });
  // A merge seen on GitHub: a run-level event, then one per verified task. The run's `merged` follows with no event of its own.
  const merged = { prNumber: 12, url: 'https://github.com/selarikru-demo/feedback-board/pull/12', candidateSha: 'c'.repeat(40), mergeCommitSha: 'd'.repeat(40) };
  b.emit('change.merged', 100, { actor: INTEGRATION, payload: merged });
  b.emit('change.merged', 100, { task: 'api', actor: INTEGRATION, payload: merged });
  b.emit('change.merged', 100, { task: 'web', actor: INTEGRATION, payload: merged });
  return done(b, {
    id: 'merge-flow', name: 'Merge flow', startSec: 70, assistant: ASSISTANT_DEVICE,
    description: 'Every task is verified, so the run is ready for review. A human merges on GitHub; the merge is observed and the run becomes merged.',
    usage: [b.use('api', 'att_api_1', figure('cost_usd', '0.20', 'estimated', 'rate_card')), b.use('web', 'att_web_1', figure('cost_usd', '0.18', 'estimated', 'rate_card'))],
    changeRequests: [changeRequest(b)],
  });
}

const CANDIDATE = 'c'.repeat(40);
const PR_URL = 'https://github.com/selarikru-demo/feedback-board/pull/12';
const changeRequest = (b: FixtureBuilder, over: Partial<ChangeRequestView> = {}): ChangeRequestView => ({
  runId: b.runId, prNumber: 12, url: PR_URL, status: 'open', candidateSha: CANDIDATE, baseRef: 'main', observedHeadSha: CANDIDATE, mergeCommitSha: null, observedAt: fixtureTime(66), outOfDate: null, ...over,
});

/** Approvals a person can act on. Cloud starts wait at claim with no attempt, as the scheduler does; worker requests interrupt their attempt. */
function decisionQueue(): Fixture {
  const b = new FixtureBuilder('decision-queue', 1313);
  b.task('search', { title: 'Search index', role: 'backend', criteria: 2 }).task('contract', { title: 'Renewal API contract', role: 'backend', dependsOn: ['search'], criteria: 2 })
    .task('migrate', { title: 'Backfill feedback tables', role: 'backend', criteria: 2 }).task('ui', { title: 'Feedback list UI', role: 'frontend', dependsOn: ['contract'], criteria: 3 });
  b.approval('apr_cloud', { task: 'search', scopeHash: 'scope-cloud-search', reason: 'configured_require_approval:start_cloud_worker', expiresAtSec: 2100, operation: 'start_cloud_worker' });
  b.approval('apr_breaking', { task: 'contract', scopeHash: 'scope-breaking-renewal', reason: 'The renewal response needs nextRenewalAt as a required field, so clients on v1 fail validation.', expiresAtSec: 3000, operation: 'breaking_api_change' });
  b.approval('apr_migration', { task: 'migrate', scopeHash: 'scope-migration', reason: 'Backfilling drops the legacy feedback_old table once rows are copied.', expiresAtSec: 3600, operation: 'destructive_data_migration' });
  b.plan(1, ['search', 'contract', 'migrate', 'ui']).ready('search', 3).ready('contract', 4).ready('migrate', 5);
  b.emit('approval.requested', 8, { task: 'search', payload: { reason: 'configured_require_approval:start_cloud_worker', operation: 'start_cloud_worker' } });
  b.start('contract', 'att_contract_1', 10, LOCAL, 'local', 'cloud').emit('approval.requested', 45, { task: 'contract', attempt: 'att_contract_1', payload: { fence: 1, reason: 'The renewal response needs nextRenewalAt as a required field, so clients on v1 fail validation.', operation: 'breaking_api_change' } });
  b.start('migrate', 'att_migrate_1', 11, LOCAL2, 'local', 'cloud').emit('approval.requested', 60, { task: 'migrate', attempt: 'att_migrate_1', payload: { fence: 1, reason: 'Backfilling drops the legacy feedback_old table once rows are copied.', operation: 'destructive_data_migration' } });
  return done(b, {
    id: 'decision-queue', name: 'Decision queue', startSec: 120, assistant: ASSISTANT_DEVICE,
    description: 'Three requests wait for a person: a cloud start, a breaking API change and a destructive data migration. The last two are advisory pauses.',
    usage: [b.use('contract', 'att_contract_1', figure('cost_usd', '0.12', 'estimated', 'rate_card'))],
  });
}

function changedRequest(): Fixture {
  const b = new FixtureBuilder('changed-request', 1414);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 2 }).task('api', { title: 'Feedback API (contract v2)', role: 'backend', revision: 2, planRevision: 2, criteria: 2 });
  b.approval('apr_changed', { task: 'api', scopeHash: 'scope-api-v1', reason: 'The list endpoint renames its pagination fields.', expiresAtSec: 3600, operation: 'breaking_api_change' });
  b.plan(1, ['api']).ready('api', 2).start('api', 'att_api_1', 3, LOCAL, 'local', 'cloud');
  b.emit('approval.requested', 20, { task: 'api', attempt: 'att_api_1', payload: { fence: 1, reason: 'The list endpoint renames its pagination fields.', operation: 'breaking_api_change' } });
  b.plan(2, ['api'], 60);
  return done(b, {
    id: 'changed-request', name: 'Changed request', startSec: 90, assistant: ASSISTANT_DEVICE,
    description: 'A worker asked for approval at task revision 1, then the plan moved the task to revision 2. The request stays pending and cannot be decided as it stands.',
    usage: [],
  });
}

function budgetStop(): Fixture {
  const b = new FixtureBuilder('budget-stop', 1515);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 2, requirements: ['FB-01', 'FB-02'], checks: ['chk-api'] })
    .task('search', { title: 'Search index', role: 'backend', criteria: 2, requirements: ['FB-03'], checks: ['chk-search-1', 'chk-search-2'] })
    .task('web', { title: 'Search results UI', role: 'frontend', dependsOn: ['search'], criteria: 1, requirements: ['FB-04'], checks: ['chk-web-1'] })
    .task('docs', { title: 'Public changelog', role: 'docs', criteria: 1, requirements: ['FB-05'], checks: ['chk-docs-1'] });
  b.plan(1, ['api', 'search', 'web', 'docs']).ready('api', 3).start('api', 'att_api_1', 4, LOCAL, 'local', 'cloud').ready('search', 4).start('search', 'att_search_1', 5, CLOUD, 'cloud', 'cloud');
  b.complete('api', 'att_api_1', 40, LOCAL).verdict('api', 'att_api_1', 55, 'passed', { checkId: 'ci:api', summary: '38 of 38 checks passed' });
  b.emit('task.cancelled', 70, { task: 'search', attempt: 'att_search_1', actor: REAPER, payload: { reason: 'budget_exhausted', attemptId: b.id('att_search_1'), cause: 'budget_exhausted' } });
  // A second stop lands later and takes a while: a client that opens the fixture before 85 s sees it in flight.
  b.ready('docs', 41).start('docs', 'att_docs_1', 42, LOCAL, 'local', 'cloud').stopping('docs', 75);
  b.emit('task.cancelled', 85, { task: 'docs', attempt: 'att_docs_1', actor: REAPER, payload: { reason: 'budget_exhausted', attemptId: b.id('att_docs_1'), cause: 'budget_exhausted' } });
  return done(b, {
    id: 'budget-stop', name: 'Budget stop', startSec: 90, assistant: ASSISTANT_DEVICE,
    description: 'The run budget ran out while the search index was being built. The API is verified; the search index, its dependent UI and the changelog are not delivered.',
    usage: [b.use('search', 'att_search_1', figure('cost_usd', '2.50', 'estimated', 'rate_card')), b.use('api', 'att_api_1', figure('cost_usd', '0.42', 'estimated', 'rate_card'))],
  });
}

function integrationBlocked(): Fixture {
  const b = new FixtureBuilder('integration-blocked', 1616);
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 2 }).task('web', { title: 'Feedback list UI', role: 'frontend', criteria: 2 }).task('docs', { title: 'Public changelog', role: 'docs', criteria: 1 });
  b.plan(1, ['api', 'web', 'docs']).ready('api', 2).start('api', 'att_api_1', 3, LOCAL, 'local', 'cloud').complete('api', 'att_api_1', 25, LOCAL).emit('task.blocked', 26, { task: 'api', payload: { reason: 'resource_conflict:port:5432' } });
  b.ready('web', 31).start('web', 'att_web_1', 32, LOCAL, 'local', 'cloud').complete('web', 'att_web_1', 50, LOCAL);
  b.ready('docs', 33).start('docs', 'att_docs_1', 34, LOCAL2, 'local', 'cloud').complete('docs', 'att_docs_1', 51, LOCAL2);
  b.emit('task.blocked', 70, { task: 'web', payload: { reason: 'verification_error' } });
  b.emit('task.blocked', 71, { task: 'docs', payload: { reason: 'assembly_infrastructure:git_failed' } });
  return done(b, {
    id: 'integration-blocked', name: 'Integration blocked', startSec: 90, assistant: ASSISTANT_DEVICE,
    description: 'A worker hit a resource conflict, and the verifier and the assembly step could not finish. No worker needs to redo the finished work.',
    usage: [],
  });
}

function reviewable(b: FixtureBuilder): void {
  b.task('api', { title: 'Feedback API', role: 'backend', criteria: 3, requirements: ['FB-01', 'FB-02', 'FB-03'] }).task('web', { title: 'Feedback list UI', role: 'frontend', criteria: 2, requirements: ['FB-04', 'FB-05'] });
  b.plan(1, ['api', 'web']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud').ready('web', 5).start('web', 'att_web_1', 7, CLOUD, 'cloud', 'cloud');
  b.complete('api', 'att_api_1', 40, LOCAL).complete('web', 'att_web_1', 45, CLOUD).emit('candidate.assembled', 47, { actor: INTEGRATION, payload: { candidateId: 'cand_1' } });
  b.verdict('api', 'att_api_1', 50, 'passed', { checkId: 'ci:api', summary: 'all checks passed' });
  b.verdict('web', 'att_web_1', 55, 'passed', { checkId: 'ci:web', summary: 'all checks passed' });
}

function mergeReview(): Fixture {
  const b = new FixtureBuilder('merge-review', 1717);
  reviewable(b);
  return done(b, {
    id: 'merge-review', name: 'Ready, no pull request', startSec: 70, assistant: ASSISTANT_DEVICE,
    description: 'Every task is verified and the candidate is assembled. A person opens the draft pull request; merging stays on GitHub.',
    usage: [],
  });
}

function mergedShaMismatch(): Fixture {
  const b = new FixtureBuilder('merged-sha-mismatch', 1818);
  reviewable(b);
  b.emit('change.proposed', 65, { actor: INTEGRATION, payload: { prNumber: 12, url: PR_URL } });
  return done(b, {
    id: 'merged-sha-mismatch', name: 'Merged SHA mismatch', startSec: 90, assistant: ASSISTANT_DEVICE,
    description: 'GitHub reports the pull request merged, but the merged head is not the commit that was verified, so no merge is recorded.',
    usage: [], changeRequests: [changeRequest(b, { status: 'merged_sha_mismatch', observedHeadSha: 'a'.repeat(40), mergeCommitSha: 'd'.repeat(40), observedAt: fixtureTime(85) })],
  });
}

function featureDelivery(): Fixture {
  const b = new FixtureBuilder('feature-delivery', 1212);
  b.task('brief', { title: 'Write feature brief', role: 'planner' }).task('contract', { title: 'Approve API contract', role: 'reviewer', dependsOn: ['brief'] })
    .task('api', { title: 'Feedback API', role: 'backend', dependsOn: ['contract'] }).task('web', { title: 'Feedback list UI', role: 'frontend', dependsOn: ['contract'] })
    .task('search', { title: 'Search index', role: 'backend', dependsOn: ['contract'] })
    .task('integrate', { title: 'Integrate feedback board', role: 'integration', dependsOn: ['api', 'web', 'search'] })
    .task('e2e', { title: 'End-to-end checks', role: 'verification', dependsOn: ['integrate'] }).task('review', { title: 'Merge review', role: 'reviewer', dependsOn: ['e2e'] });
  b.plan(1, ['brief', 'contract', 'api', 'web', 'search', 'integrate', 'e2e', 'review']);
  b.ready('brief', 2).start('brief', 'att_brief_1', 3, LOCAL, 'local', 'cloud').complete('brief', 'att_brief_1', 30, LOCAL).verdict('brief', 'att_brief_1', 40, 'passed', { checkId: 'ci:brief', summary: 'brief accepted' });
  b.ready('contract', 41).start('contract', 'att_contract_1', 42, LOCAL, 'local', 'cloud').complete('contract', 'att_contract_1', 70, LOCAL).verdict('contract', 'att_contract_1', 80, 'passed', { checkId: 'ci:contract', summary: 'contract v1 accepted' });
  b.ready('api', 81).start('api', 'att_api_1', 82, LOCAL, 'local', 'cloud').ready('web', 81).start('web', 'att_web_1', 83, LOCAL2, 'local', 'cloud').ready('search', 81);
  b.emit('placement.blocked', 90, { task: 'search', payload: { reason: 'approval_required:cloud_start', mode: 'local-first' } });
  b.complete('api', 'att_api_1', 150, LOCAL).verdict('api', 'att_api_1', 170, 'passed', { checkId: 'ci:api', summary: '38 of 38 checks passed' });
  // The list UI's first attempt failed a check, so the demo can ask an agent to explain it; the repair attempt is running.
  b.complete('web', 'att_web_1', 110, LOCAL2).verdict('web', 'att_web_1', 115, 'failed', { checkId: 'ci:web', summary: '2 of 24 checks failed: the feedback list is not sorted newest first' });
  b.start('web', 'att_web_2', 120, LOCAL2, 'local', 'cloud', 2);
  // P1: after the scene opens, the Project Manager is seen at work. Plan revision 2 is accepted (it lists the later stages again, unchanged), then the PM
  // delegates the search index to the backend worker that is free, under the server's rule (same role, a ready task). The scheduler then records the
  // same placement block again: the search index still waits for its cloud start. That last event keeps the loop going while the PM walks.
  b.plan(2, ['integrate', 'e2e', 'review'], 204);
  b.emit('task.delegated', 207, { task: 'search', actor: PM_AGENT, payload: { workerId: LOCAL, planRevision: 2, revision: 1 } });
  b.emit('placement.blocked', 245, { task: 'search', payload: { reason: 'approval_required:cloud_start', mode: 'local-first' } });
  return done(b, {
    id: 'feature-delivery', name: 'Feature delivery', startSec: 200, assistant: ASSISTANT_DEVICE, budgetLimitUsd: 25,
    // Every route mode is in use: the run default is Local first from onboarding; the contract runs Cloud only, the API Cloud first, the integration Local only, and
    // the end-to-end checks read restricted data, so their AI steps are locked to the device (a planned local task, never one headed to a cloud worker). The list
    // UI fell back to the cloud once; the integration's last source is unknown.
    routes: {
      runDefault: 'PREFER_ON_DEVICE',
      tasks: {
        [scoped('feature-delivery', 'brief')]: { inputChars: 900, observed: { sec: 20, stepKind: 'brief', source: 'ON_DEVICE', totalMs: 2400 } },
        [scoped('feature-delivery', 'contract')]: { override: 'ONLY_IN_CLOUD', inputChars: 4200, observed: { sec: 60, stepKind: 'criteria', source: 'IN_CLOUD', totalMs: 1300 } },
        [scoped('feature-delivery', 'api')]: { override: 'PREFER_IN_CLOUD', inputChars: 12000, observed: { sec: 120, stepKind: 'patch', source: 'IN_CLOUD', totalMs: 3100 } },
        [scoped('feature-delivery', 'web')]: { inputChars: 2600, observed: { sec: 130, stepKind: 'patch', source: 'IN_CLOUD', totalMs: 2900 } },
        [scoped('feature-delivery', 'search')]: { inputChars: 1800 },
        [scoped('feature-delivery', 'e2e')]: { label: 'restricted', inputChars: 1500, observed: { sec: 95, stepKind: 'criteria', source: 'ON_DEVICE', totalMs: 1700 } },
        [scoped('feature-delivery', 'integrate')]: { override: 'ONLY_ON_DEVICE', inputChars: 9000, observed: { sec: 150, stepKind: 'review', source: 'UNKNOWN', totalMs: 4100 }, restrictedSiblingClaim: 'Plan: partner billing migration (restricted)' },
        [scoped('feature-delivery', 'review')]: { inputChars: 700 },
      },
    },
    description: 'A plan across stages: a brief and contract are verified, the API is done, the list UI failed a check and its repair is running in a local sandbox, and the search index is set to run in the cloud, so it waits for approval to start a cloud worker. Later tasks wait on it.',
    usage: [b.use('api', 'att_api_1', figure('cost_usd', '0.42', 'estimated', 'rate_card')), b.use('web', 'att_web_1', figure('cost_usd', '0.37', 'estimated', 'rate_card'))],
  });
}

export const FIXTURE_IDS = [
  'healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data',
] as const satisfies readonly FixtureId[];

function benchmarkTrial(): Fixture {
  const b = new FixtureBuilder('benchmark-trial', 1313);
  // The trial's one model: the coding worker's when coding workers are on (the mock swaps it in); none with them off.
  b.pinnedModel = { ...DEMO_ASSIGNMENT };
  b.task('api', { title: 'Benchmark API task', role: 'backend', criteria: 1 });
  b.plan(1, ['api']).ready('api', 5).start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  return done(b, { id: 'benchmark-trial', name: 'Benchmark trial', startSec: 60, assistant: ASSISTANT_DEVICE, description: 'A benchmark trial: every attempt uses its one pinned model, and overrides are refused.', usage: [] });
}

const BUILDERS: Record<FixtureId, () => Fixture> = {
  'benchmark-trial': benchmarkTrial,
  'healthy-parallel-work': healthyParallelWork, 'human-wait': humanWait, 'policy-block': policyBlock, 'runner-loss': runnerLoss, 'long-build-stall': longBuildStall,
  'merge-flow': mergeFlow, 'feature-delivery': featureDelivery, 'decision-queue': decisionQueue, 'changed-request': changedRequest, 'budget-stop': budgetStop, 'integration-blocked': integrationBlocked, 'merge-review': mergeReview, 'merged-sha-mismatch': mergedShaMismatch, 'contract-change': contractChange, 'failed-ci': failedCi, 'expired-approval': expiredApproval, 'unknown-costs': unknownCosts, 'no-data': noData,
};

/** A fresh copy each call. Fixtures are pure data, so two calls are deeply equal. */
export const buildFixture = (id: FixtureId): Fixture => BUILDERS[id]();
export const buildAllFixtures = (): Fixture[] => FIXTURE_IDS.map(buildFixture);
/** The ten named fixtures plus the extras. This is what the demo source serves by default. */
export const EXTRA_FIXTURE_IDS = ['benchmark-trial', 'merge-flow', 'feature-delivery', 'decision-queue', 'changed-request', 'budget-stop', 'integration-blocked', 'merge-review', 'merged-sha-mismatch'] as const satisfies readonly FixtureId[];
export const buildDemoFixtures = (): Fixture[] => [...buildAllFixtures(), ...EXTRA_FIXTURE_IDS.map(buildFixture)];
