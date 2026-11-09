import { randomUUID } from 'node:crypto';
import { checkEventAuthority, type EventEnvelope, type EventType } from '@selarikru/domain';
import { appendEvent, type Tx } from '@selarikru/persistence';

export const INTEGRATION_ACTOR = { kind: 'integration', id: 'integration' } as const;

/** Appends a run-level event by the integration actor, after the allowlist check. */
export async function emitIntegration(tx: Tx, scope: { projectId: string; runId: string }, now: Date, type: EventType, payload: Record<string, unknown>): Promise<void> {
  const at = now.toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: scope.projectId, runId: scope.runId, taskId: scope.runId, attemptId: null, type,
    sequence: 0, aggregateRevision: 0, actor: INTEGRATION_ACTOR, occurredAt: at, receivedAt: at, causationId: null, traceId: `trace_${randomUUID()}`, payload,
  };
  const authority = checkEventAuthority(envelope);
  if (!authority.ok) throw new Error(`integration emitted a forbidden event: ${JSON.stringify(authority.error)}`);
  await appendEvent(tx, envelope);
}
