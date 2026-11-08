import { describe, expect, it } from 'vitest';
import { EVENT_ACTOR_ALLOWLIST, EVENT_TYPES, EventEnvelopeSchema, checkEventAuthority, type EventEnvelope } from './index.ts';

const envelope = {
  schemaVersion: 1,
  eventId: 'evt_example_001',
  projectId: 'proj_demo',
  runId: 'run_billing',
  taskId: 'task_backend',
  attemptId: 'attempt_02',
  type: 'verification.failed',
  sequence: 128,
  aggregateRevision: 6,
  actor: { kind: 'verifier', id: 'ci_adapter' },
  occurredAt: '2026-11-08T06:00:00Z',
  receivedAt: '2026-11-08T06:00:01Z',
  causationId: 'evt_example_000',
  traceId: 'trace_demo',
  payload: { candidateSha: 'sha', checkId: 'c', evidenceArtifactId: 'a' },
};
const parse = (o: unknown) => EventEnvelopeSchema.safeParse(o);

describe('EventEnvelopeSchema', () => {
  it('accepts the architecture example', () => {
    expect(parse(envelope).success).toBe(true);
  });
  it('unknown schemaVersion rejected', () => {
    expect(parse({ ...envelope, schemaVersion: 2 }).success).toBe(false);
    expect(parse({ ...envelope, schemaVersion: '1' }).success).toBe(false);
    const { schemaVersion: _omit, ...rest } = envelope;
    expect(parse(rest).success).toBe(false);
  });
  it('rejects unknown fields, bad actors, bad timestamps, bad sequence', () => {
    expect(parse({ ...envelope, extra: 1 }).success).toBe(false);
    expect(parse({ ...envelope, actor: { kind: 'robot', id: 'x' } }).success).toBe(false);
    expect(parse({ ...envelope, actor: { kind: 'worker', id: 'x', token: 's' } }).success).toBe(false);
    expect(parse({ ...envelope, occurredAt: 'yesterday' }).success).toBe(false);
    expect(parse({ ...envelope, sequence: -1 }).success).toBe(false);
    expect(parse({ ...envelope, type: 'made.up' }).success).toBe(false);
  });
  it('allows null attempt and causation ids', () => {
    expect(parse({ ...envelope, attemptId: null, causationId: null }).success).toBe(true);
  });
});

describe('checkEventAuthority', () => {
  const as = (kind: string, type: string): EventEnvelope =>
    EventEnvelopeSchema.parse({ ...envelope, type, actor: { kind, id: 'x' } });
  const denied = (kind: string, type: string) => {
    const r = checkEventAuthority(as(kind, type));
    expect(r.ok, `${kind} ${type}`).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'actor_not_permitted', eventType: type, actorKind: kind });
  };

  it('worker-sourced approval.granted, change.merged, verification.passed rejected', () => {
    for (const t of ['approval.granted', 'change.merged', 'verification.passed']) denied('worker', t);
  });
  it('workers cannot emit scheduler, plan, denial or verification verdict events', () => {
    for (const t of ['task.ready', 'task.cancelled', 'task.superseded', 'plan.accepted', 'approval.denied', 'verification.failed']) denied('worker', t);
  });
  it('only a human may emit task.cancel_requested', () => {
    expect(checkEventAuthority(as('human', 'task.cancel_requested')).ok).toBe(true);
    for (const k of ['worker', 'verifier', 'scheduler', 'system', 'integration']) denied(k, 'task.cancel_requested');
  });
  it('verifier and scheduler cannot merge or grant approvals', () => {
    for (const k of ['verifier', 'scheduler', 'system']) {
      denied(k, 'change.merged');
      denied(k, 'approval.granted');
    }
    denied('human', 'change.merged');
    denied('integration', 'approval.granted');
    denied('human', 'verification.passed');
  });
  it('allows each event from its designated actor', () => {
    for (const [type, kinds] of Object.entries(EVENT_ACTOR_ALLOWLIST)) {
      for (const k of kinds!) expect(checkEventAuthority(as(k, type)).ok, `${k} ${type}`).toBe(true);
    }
    expect(checkEventAuthority(as('worker', 'attempt.started')).ok).toBe(true);
    expect(checkEventAuthority(as('verifier', 'verification.passed')).ok).toBe(true);
    expect(checkEventAuthority(as('human', 'approval.granted')).ok).toBe(true);
    expect(checkEventAuthority(as('integration', 'change.merged')).ok).toBe(true);
  });
  it('every event type has an allowlist entry, and a missing entry is denied', () => {
    for (const t of EVENT_TYPES) expect(EVENT_ACTOR_ALLOWLIST[t], t).toBeDefined();
    const ev = as('system', 'run.created');
    const saved = EVENT_ACTOR_ALLOWLIST['run.created'];
    delete (EVENT_ACTOR_ALLOWLIST as Record<string, unknown>)['run.created'];
    try { expect(checkEventAuthority(ev).ok).toBe(false); }
    finally { (EVENT_ACTOR_ALLOWLIST as Record<string, unknown>)['run.created'] = saved; }
  });
  it('placement.decided and placement.blocked are emitted by the scheduler only', () => {
    for (const type of ['placement.decided', 'placement.blocked']) {
      expect(EVENT_ACTOR_ALLOWLIST[type as 'placement.decided'], type).toEqual(['scheduler']);
      expect(checkEventAuthority(as('scheduler', type)).ok).toBe(true);
      for (const k of ['worker', 'human', 'verifier', 'system'] as const) expect(checkEventAuthority(as(k, type)).ok, `${k} ${type}`).toBe(false);
    }
  });
});
