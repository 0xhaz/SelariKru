/**
 * Outbox delivery is AT LEAST ONCE. A claim is a lease: if the consumer dies before `markDelivered`,
 * the lease expires and the row is handed out again. Consumers therefore MUST deduplicate by
 * `eventId` (globally unique) or by their cursor (`sequence` per project), and handlers must be
 * idempotent. Claims within one project are handed out in sequence order and never past an earlier
 * row that another consumer still holds under a live lease.
 */
import type { EventEnvelope } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import type { Executor } from './db.ts';
import { rowToEnvelope } from './events.ts';

export const DEFAULT_LEASE_SECONDS = 30;

export async function claimOutbox(db: Executor, consumer: string, limit: number, leaseSeconds = DEFAULT_LEASE_SECONDS): Promise<EventEnvelope[]> {
  const rows = await db.execute(sql`
    WITH picked AS (
      SELECT o.tenant_id, o.project_id, o.sequence FROM outbox o
      WHERE o.delivered_at IS NULL
        AND (o.claim_expires_at IS NULL OR o.claim_expires_at < now())
        AND NOT EXISTS (
          SELECT 1 FROM outbox p
          WHERE p.tenant_id = o.tenant_id AND p.project_id = o.project_id AND p.sequence < o.sequence
            AND p.delivered_at IS NULL AND p.claim_expires_at >= now() AND p.claimed_by <> ${consumer})
      ORDER BY o.project_id, o.sequence
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE outbox o SET claimed_by = ${consumer}, claim_expires_at = now() + make_interval(secs => ${leaseSeconds}),
        delivery_attempts = o.delivery_attempts + 1
      FROM picked p WHERE o.tenant_id = p.tenant_id AND o.project_id = p.project_id AND o.sequence = p.sequence
      RETURNING o.tenant_id, o.project_id, o.sequence
    )
    SELECT e.* FROM events e JOIN claimed c USING (tenant_id, project_id, sequence)
    ORDER BY e.project_id, e.sequence`);
  return rows.map(rowToEnvelope);
}

/** Marks claimed events delivered. Only the current lease holder may; returns the number updated. */
export async function markDelivered(db: Executor, consumer: string, eventIds: readonly string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  const rows = await db.execute(sql`
    UPDATE outbox SET delivered_at = now()
    WHERE event_id IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})
      AND claimed_by = ${consumer} AND delivered_at IS NULL
    RETURNING event_id`);
  return rows.length;
}

/** Last sequence this consumer has processed for the project; 0 when it has none. */
export async function readCursor(db: Executor, consumer: string, tenantId: string, projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT last_sequence FROM consumer_cursors WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND consumer = ${consumer}`);
  return rows[0] ? Number(rows[0]['last_sequence']) : 0;
}

/** Moves the cursor forward only (a stale or replayed advance is a no-op). Returns the resulting position. */
export async function advanceCursor(db: Executor, consumer: string, tenantId: string, projectId: string, sequence: number): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO consumer_cursors (tenant_id, project_id, consumer, last_sequence) VALUES (${tenantId}, ${projectId}, ${consumer}, ${sequence})
    ON CONFLICT (tenant_id, project_id, consumer) DO UPDATE
      SET last_sequence = GREATEST(consumer_cursors.last_sequence, EXCLUDED.last_sequence), updated_at = now()
    RETURNING last_sequence`);
  return Number(rows[0]!['last_sequence']);
}
