import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, checkWorkerAuthority, type EventEnvelope } from './index.ts';

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

describe('checkWorkerAuthority', () => {
  const as = (kind: string, type: string): EventEnvelope =>
    EventEnvelopeSchema.parse({ ...envelope, type, actor: { kind, id: 'x' } });

  it('worker-sourced approval.granted, change.merged, verification.passed rejected', () => {
    for (const type of ['approval.granted', 'change.merged', 'verification.passed']) {
      const r = checkWorkerAuthority(as('worker', type));
      expect(r.ok, type).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'worker_not_authoritative', eventType: type });
    }
  });
  it('allows worker progress events and authoritative events from proper actors', () => {
    expect(checkWorkerAuthority(as('worker', 'attempt.started')).ok).toBe(true);
    expect(checkWorkerAuthority(as('worker', 'verification.failed')).ok).toBe(true);
    expect(checkWorkerAuthority(as('verifier', 'verification.passed')).ok).toBe(true);
    expect(checkWorkerAuthority(as('human', 'approval.granted')).ok).toBe(true);
    expect(checkWorkerAuthority(as('integration', 'change.merged')).ok).toBe(true);
  });
});
