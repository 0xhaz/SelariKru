import { sql } from 'drizzle-orm';
import type { Tx } from './db.ts';

export interface OperationKey {
  tenantId: string;
  projectId: string;
  key: string;
}

/**
 * Idempotent operation. The first caller for a key runs `fn` inside `tx` and its return value (JSON)
 * is stored as the receipt; every later or concurrent caller gets that stored receipt back and `fn`
 * does not run. The primary-key insert decides the winner: a concurrent duplicate blocks on the
 * winner's uncommitted row, then sees the committed receipt. If the winner rolls back (including a
 * throw from `fn`), its receipt disappears and the next caller runs `fn`. Requires READ COMMITTED
 * (the default), and `fn`'s writes share `tx`, so effects and receipt commit together.
 */
export async function recordOperation<T>(tx: Tx, key: OperationKey, fn: () => Promise<T>): Promise<T> {
  const inserted = await tx.execute(sql`
    INSERT INTO operation_receipts (tenant_id, project_id, operation_key, receipt)
    VALUES (${key.tenantId}, ${key.projectId}, ${key.key}, 'null'::jsonb)
    ON CONFLICT (tenant_id, project_id, operation_key) DO NOTHING
    RETURNING operation_key`);
  if (inserted.length === 0) {
    const rows = await tx.execute(sql`
      SELECT receipt FROM operation_receipts
      WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND operation_key = ${key.key}`);
    return rows[0]!['receipt'] as T;
  }
  const receipt = await fn();
  await tx.execute(sql`
    UPDATE operation_receipts SET receipt = ${JSON.stringify(receipt ?? null)}::jsonb
    WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND operation_key = ${key.key}`);
  return receipt;
}
