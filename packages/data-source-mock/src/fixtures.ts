import { FixtureBuilder, HUMAN, REAPER, VERIFIER, figure, fixtureTime, runnerActor, usageEntry, type Fixture, type FixtureId } from './builder.ts';

/**
 * Ten named scenarios. Each is a stream of real domain event names (so the projection reducers, and later a live source, see the
 * same shapes), a fixed start time, and usage figures with provenance. Nothing here reads a clock or a random source.
 * Where an event payload carries a title, role or dependency list, that is a display hint a live snapshot would otherwise supply.
 */
const R = 'run_demo';
const LOCAL = 'runner_local_1';
const LOCAL2 = 'runner_local_2';
const CLOUD = 'runner_cloud_1';
const ASSISTANT_DEVICE = { mode: 'PREFER_ON_DEVICE', observedSource: 'on_device' } as const;

const tokens = (t: string | null, a: string | null, prov: 'observed' | 'estimated' | 'unavailable', src: string, qty: [string | null, string | null]) => [
  usageEntry(R, t, a, figure('input_tokens', qty[0], prov, src)),
  usageEntry(R, t, a, figure('output_tokens', qty[1], prov, src)),
];

function healthyParallelWork(): Fixture {
  const b = new FixtureBuilder('demo-healthy-parallel-work', R, 101).run();
  b.ready('api', 5, 'Feedback API', 'backend').start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.ready('web', 5, 'Feedback list UI', 'frontend').start('web', 'att_web_1', 7, CLOUD, 'cloud', 'cloud');
  b.beats('api', 'att_api_1', LOCAL, 16, 120, (s) => (s % 40 === 16 ? { activity: 'coding', tool: 'edit_file', summary: 'routes/feedback.ts' } : { activity: 'coding' }));
  b.beats('web', 'att_web_1', CLOUD, 17, 117, (s) => (s % 40 === 17 ? { activity: 'testing', tool: 'run_tests', summary: 'unit: feedback list' } : { activity: 'testing' }));
  b.emit('attempt.completed', 135, { taskId: 'api', attemptId: 'att_api_1', actor: runnerActor(LOCAL), payload: { fence: 1 } });
  b.emit('verification.started', 138, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:api' } });
  b.emit('verification.passed', 160, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:api', summary: '38 of 38 checks passed' } });
  return {
    id: 'healthy-parallel-work', name: 'Healthy parallel work', projectId: b.projectId, startSec: 125, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'Two workers run in parallel, one local sandbox and one cloud sandbox, both calling cloud models. The assistant runs on the device. Different axes.',
    usage: [
      ...tokens('api', 'att_api_1', 'estimated', 'worker_report', ['41200', '9100']),
      usageEntry(R, 'api', 'att_api_1', figure('cost_usd', '0.42', 'estimated', 'rate_card')),
      usageEntry(R, 'api', 'att_api_1', figure('worker_seconds', '119', 'observed', 'controller_clock')),
      ...tokens('web', 'att_web_1', 'estimated', 'worker_report', ['38800', '7700']),
      usageEntry(R, 'web', 'att_web_1', figure('cost_usd', '0.37', 'estimated', 'rate_card')),
      usageEntry(R, 'web', 'att_web_1', figure('worker_seconds', '118', 'observed', 'controller_clock')),
    ],
  };
}

function humanWait(): Fixture {
  const b = new FixtureBuilder('demo-human-wait', R, 202).run();
  b.ready('migrate', 5, 'Add feedback table', 'backend').start('migrate', 'att_mig_1', 6, LOCAL, 'local', 'cloud');
  b.ready('ui', 5, 'Empty states', 'frontend').start('ui', 'att_ui_1', 7, CLOUD, 'cloud', 'cloud');
  b.beats('migrate', 'att_mig_1', LOCAL, 16, 36, () => ({ activity: 'coding' }));
  b.beats('ui', 'att_ui_1', CLOUD, 17, 87, () => ({ activity: 'coding' }));
  b.emit('approval.requested', 40, {
    taskId: 'migrate', attemptId: 'att_mig_1',
    payload: { fence: 1, approvalId: 'apr_docs_domain', scopeHash: 'scope-docs-domain', reason: 'allow_documentation_domain', expiresAt: fixtureTime(3640) },
  });
  b.emit('approval.granted', 150, { taskId: 'migrate', actor: HUMAN, payload: { approvalId: 'apr_docs_domain' } });
  b.ready('migrate', 152, 'Add feedback table', 'backend', { reason: 'approval_granted' });
  return {
    id: 'human-wait', name: 'Human wait', projectId: b.projectId, startSec: 90, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'One task waits for a person to allow a documentation domain. Its worker shows waiting_human; the other keeps working.',
    usage: [usageEntry(R, 'migrate', 'att_mig_1', figure('cost_usd', '0.11', 'estimated', 'rate_card')), usageEntry(R, 'ui', 'att_ui_1', figure('cost_usd', '0.19', 'estimated', 'rate_card'))],
  };
}

function policyBlock(): Fixture {
  const b = new FixtureBuilder('demo-policy-block', R, 303).run();
  b.ready('export', 5, 'Export restricted feedback', 'backend');
  b.emit('placement.blocked', 6, { taskId: 'export', payload: { reason: 'policy_denied:restricted_data_cloud_destination', mode: 'local-first' } });
  b.ready('report', 5, 'Weekly report job', 'backend');
  b.emit('placement.blocked', 7, { taskId: 'report', payload: { reason: 'approval_required:cloud_start', mode: 'local-first' } });
  b.ready('lint', 5, 'Lint cleanup', 'frontend').start('lint', 'att_lint_1', 8, LOCAL, 'local', 'cloud');
  b.beats('lint', 'att_lint_1', LOCAL, 18, 58, () => ({ activity: 'coding' }));
  b.emit('placement.blocked', 100, { taskId: 'report', payload: { reason: 'policy_denied:missing_budget_limit', mode: 'local-first' } });
  return {
    id: 'policy-block', name: 'Policy block', projectId: b.projectId, startSec: 60, events: b.build(), assistant: { mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' },
    description: 'Two tasks cannot be placed: restricted data may not reach the cloud, and a cloud start needs approval. A missing budget blocks, it is never unlimited.',
    usage: [usageEntry(R, 'lint', 'att_lint_1', figure('cost_usd', '0.05', 'estimated', 'rate_card'))],
  };
}

function runnerLoss(): Fixture {
  const b = new FixtureBuilder('demo-runner-loss', R, 404).run();
  b.ready('api', 5, 'Feedback API', 'backend').start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.beats('api', 'att_api_1', LOCAL, 16, 46, () => ({ activity: 'coding', tool: 'edit_file', summary: 'routes/feedback.ts' }));
  b.emit('attempt.failed', 118, { taskId: 'api', attemptId: 'att_api_1', actor: REAPER, payload: { fence: 1, reason: 'lease_expired' } });
  b.ready('api', 120, 'Feedback API', 'backend', { reason: 'infrastructure_retry' });
  b.start('api', 'att_api_2', 124, LOCAL2, 'local', 'cloud', 2, 2);
  return {
    id: 'runner-loss', name: 'Runner loss', projectId: b.projectId, startSec: 110, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'The local runner stopped heartbeating. The worker shows disconnected with its last confirmed activity; it is not shown idle or finished. A new attempt follows.',
    usage: [usageEntry(R, 'api', 'att_api_1', figure('cost_usd', null, 'unavailable', 'lease_reaper')), usageEntry(R, 'api', 'att_api_1', figure('worker_seconds', null, 'unavailable', 'lease_reaper'))],
  };
}

function longBuildStall(): Fixture {
  const b = new FixtureBuilder('demo-long-build-stall', R, 505).run();
  b.ready('web', 5, 'Production build of the web client', 'frontend').start('web', 'att_web_1', 6, LOCAL, 'local', 'cloud');
  b.beats('web', 'att_web_1', LOCAL, 16, 56, (s) => ({ activity: 'testing', ...(s >= 36 ? { tool: 'pnpm -r build', summary: 'long-running command, no output yet', longRunning: true } : {}) }));
  b.beat('web', 'att_web_1', LOCAL, 100, { activity: 'testing', tool: 'pnpm -r build', summary: 'build finished', longRunning: true });
  b.beats('web', 'att_web_1', LOCAL, 110, 130, () => ({ activity: 'testing' }));
  return {
    id: 'long-build-stall', name: 'Long-build stall', projectId: b.projectId, startSec: 95, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'Heartbeats paused for over 30 seconds during a known long build. A suspected stall is not a lost connection and not a failure; the task stays running.',
    usage: [usageEntry(R, 'web', 'att_web_1', figure('cost_usd', '0.09', 'estimated', 'rate_card'))],
  };
}

function contractChange(): Fixture {
  const b = new FixtureBuilder('demo-contract-change', R, 606).run();
  b.ready('api', 5, 'Feedback API', 'backend').start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.ready('web', 5, 'Feedback list UI', 'frontend').start('web', 'att_web_1', 7, CLOUD, 'cloud', 'cloud');
  b.beats('api', 'att_api_1', LOCAL, 16, 136, () => ({ activity: 'coding' }));
  b.beats('web', 'att_web_1', CLOUD, 17, 47, () => ({ activity: 'coding' }));
  b.emit('plan.accepted', 60, { payload: { planRevision: 2, lifecycle: 'running' } });
  b.emit('attempt.failed', 61, { taskId: 'web', attemptId: 'att_web_1', actor: REAPER, payload: { fence: 1, reason: 'superseded_by_plan' } });
  b.emit('task.superseded', 62, { taskId: 'web', payload: { revision: 1, supersededByRevision: 2 } });
  b.emit('task.ready', 63, { taskId: 'web', payload: { revision: 2, title: 'Feedback list UI (contract v2)', role: 'frontend', reason: 'contract_changed' } });
  b.emit('task.ready', 64, { taskId: 'contract', payload: { title: 'Approve contract v2', role: 'reviewer', reason: 'planned' } });
  b.emit('approval.requested', 65, {
    taskId: 'contract', payload: { approvalId: 'apr_contract_v2', scopeHash: 'scope-contract-v2', reason: 'approve_contract_v2', expiresAt: fixtureTime(7265) },
  });
  b.emit('approval.granted', 140, { taskId: 'contract', actor: HUMAN, payload: { approvalId: 'apr_contract_v2' } });
  return {
    id: 'contract-change', name: 'Contract change', projectId: b.projectId, startSec: 120, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'The plan moved to revision 2. The UI task for revision 1 is superseded and revision 2 waits for an approval of contract v2.',
    usage: [usageEntry(R, 'api', 'att_api_1', figure('cost_usd', '0.31', 'estimated', 'rate_card')), usageEntry(R, 'web', 'att_web_1', figure('cost_usd', '0.06', 'estimated', 'rate_card'))],
  };
}

function failedCi(): Fixture {
  const b = new FixtureBuilder('demo-failed-ci', R, 707).run();
  b.ready('api', 5, 'Feedback API', 'backend').start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.beats('api', 'att_api_1', LOCAL, 16, 46, () => ({ activity: 'coding' }));
  b.emit('attempt.completed', 50, { taskId: 'api', attemptId: 'att_api_1', actor: runnerActor(LOCAL), payload: { fence: 1 } });
  b.emit('verification.started', 55, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:lint' } });
  b.emit('verification.passed', 62, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:lint', summary: 'no findings' } });
  b.emit('verification.started', 63, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:unit' } });
  b.emit('verification.failed', 90, { taskId: 'api', actor: VERIFIER, payload: { checkId: 'ci:unit', summary: '3 of 41 tests failed', reason: 'required_check_failed' } });
  b.ready('api', 130, 'Feedback API', 'backend', { reason: 'repair_scheduled' });
  b.start('api', 'att_api_2', 135, LOCAL, 'local', 'cloud', 2, 2);
  return {
    id: 'failed-ci', name: 'Failed CI', projectId: b.projectId, startSec: 100, events: b.build(), assistant: ASSISTANT_DEVICE,
    description: 'The unit-test check failed after the first attempt. The failed check stays visible as evidence; a repair attempt is scheduled by policy, not by the worker.',
    usage: [...tokens('api', 'att_api_1', 'estimated', 'worker_report', ['52000', '11800']), usageEntry(R, 'api', 'att_api_1', figure('cost_usd', '0.58', 'estimated', 'rate_card'))],
  };
}

function expiredApproval(): Fixture {
  const b = new FixtureBuilder('demo-expired-approval', R, 808).run();
  b.ready('deploy-docs', 5, 'Fetch vendor docs', 'research').start('deploy-docs', 'att_docs_1', 6, CLOUD, 'cloud', 'cloud');
  b.beats('deploy-docs', 'att_docs_1', CLOUD, 16, 36, () => ({ activity: 'planning' }));
  b.emit('approval.requested', 40, {
    taskId: 'deploy-docs', attemptId: 'att_docs_1',
    payload: { fence: 1, approvalId: 'apr_vendor_docs', scopeHash: 'scope-vendor-docs', reason: 'allow_vendor_docs_domain', expiresAt: fixtureTime(640) },
  });
  return {
    id: 'expired-approval', name: 'Expired approval', projectId: b.projectId, startSec: 700, events: b.build(), assistant: { mode: 'PREFER_IN_CLOUD', observedSource: 'in_cloud' },
    description: 'An approval request passed its expiry. It reads as expired and the task stays awaiting approval; expiry is an explicit outcome and never a grant.',
    usage: [usageEntry(R, 'deploy-docs', 'att_docs_1', figure('cost_usd', '0.02', 'estimated', 'rate_card'))],
  };
}

function unknownCosts(): Fixture {
  const b = new FixtureBuilder('demo-unknown-costs', R, 909).run();
  b.ready('api', 5, 'Feedback API', 'backend').start('api', 'att_api_1', 6, LOCAL, 'local', 'cloud');
  b.ready('web', 5, 'Feedback list UI', 'frontend').start('web', 'att_web_1', 7, CLOUD, 'cloud', 'unknown');
  b.ready('batch', 5, 'Bulk import', 'backend').start('batch', 'att_batch_1', 8, LOCAL2, 'local', 'cloud');
  b.beats('api', 'att_api_1', LOCAL, 16, 96, () => ({ activity: 'coding' }));
  b.beats('web', 'att_web_1', CLOUD, 17, 97, () => ({ activity: 'coding' }));
  b.beats('batch', 'att_batch_1', LOCAL2, 18, 88, () => ({ activity: 'coding' }));
  b.emit('task.cancelled', 150, { taskId: 'batch', attemptId: 'att_batch_1', actor: REAPER, payload: { reason: 'budget_exhausted', attemptIds: ['att_batch_1'] } });
  b.beats('api', 'att_api_1', LOCAL, 106, 196, () => ({ activity: 'coding' }));
  return {
    id: 'unknown-costs', name: 'Unknown costs', projectId: b.projectId, startSec: 200, events: b.build(), assistant: { mode: null, observedSource: 'unknown' },
    description: 'Some figures are observed, some estimated, some unavailable. Unavailable is unknown, never zero, so run totals stay unknown. One task was stopped for budget.',
    usage: [
      ...tokens('api', 'att_api_1', 'observed', 'provider_response', ['120400', '30210']),
      usageEntry(R, 'api', 'att_api_1', figure('cost_usd', '1.24', 'estimated', 'rate_card')),
      usageEntry(R, 'api', 'att_api_1', figure('worker_seconds', '190', 'observed', 'controller_clock')),
      ...tokens('web', 'att_web_1', 'unavailable', 'harness_report', [null, null]),
      usageEntry(R, 'web', 'att_web_1', figure('cost_usd', null, 'unavailable', 'harness_report')),
      usageEntry(R, 'web', 'att_web_1', figure('worker_seconds', '183', 'observed', 'controller_clock')),
      ...tokens('batch', 'att_batch_1', 'estimated', 'worker_report', ['88000', '9400']),
      usageEntry(R, 'batch', 'att_batch_1', figure('cost_usd', '2.50', 'estimated', 'rate_card')),
      usageEntry(R, 'batch', 'att_batch_1', figure('worker_seconds', null, 'unavailable', 'lease_reaper')),
    ],
  };
}

function noData(): Fixture {
  return {
    id: 'no-data', name: 'No data', projectId: 'demo-no-data', startSec: 0, events: [], usage: [], assistant: { mode: null, observedSource: 'unknown' },
    description: 'A project with no runs, tasks, workers or usage. Empty states render as empty, not as zeros.',
  };
}

export const FIXTURE_IDS = [
  'healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data',
] as const satisfies readonly FixtureId[];

const BUILDERS: Record<FixtureId, () => Fixture> = {
  'healthy-parallel-work': healthyParallelWork, 'human-wait': humanWait, 'policy-block': policyBlock, 'runner-loss': runnerLoss, 'long-build-stall': longBuildStall,
  'contract-change': contractChange, 'failed-ci': failedCi, 'expired-approval': expiredApproval, 'unknown-costs': unknownCosts, 'no-data': noData,
};

/** A fresh copy each call. Fixtures are pure data, so two calls are deeply equal. */
export const buildFixture = (id: FixtureId): Fixture => BUILDERS[id]();
export const buildAllFixtures = (): Fixture[] => FIXTURE_IDS.map(buildFixture);
