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
 * (the default). ALL effects of the operation belong inside `fn`, using `tx`: only they commit or roll back
 * together with the receipt; anything done outside `fn` is not protected by it. A SQL NULL receipt column
 * is the in-flight placeholder and is never visible after commit.
 */
export async function recordOperation<T>(tx: Tx, key: OperationKey, fn: () => Promise<T>): Promise<T> {
  // A savepoint: if anything below throws (even if the caller catches it and commits the outer tx), the
  // placeholder row and every write `fn` made are rolled back, so no incomplete receipt can survive.
  return tx.transaction(async (sp) => {
    const inserted = await sp.execute(sql`
      INSERT INTO operation_receipts (tenant_id, project_id, operation_key, receipt)
      VALUES (${key.tenantId}, ${key.projectId}, ${key.key}, NULL)
      ON CONFLICT (tenant_id, project_id, operation_key) DO NOTHING
      RETURNING operation_key`);
    if (inserted.length === 0) {
      const rows = await sp.execute(sql`
        SELECT receipt FROM operation_receipts
        WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND operation_key = ${key.key}`);
      return rows[0]!['receipt'] as T;
    }
    const receipt = await fn();
    await sp.execute(sql`
      UPDATE operation_receipts SET receipt = ${JSON.stringify(receipt ?? null)}::jsonb
      WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND operation_key = ${key.key}`);
    return receipt;
  });
}

/** `recordOperation` for onboarding, whose receipts have no `projects` row to hang from. `scope` is the setup's id. Same guarantees. */
export async function recordOnboardingOperation<T>(tx: Tx, key: { tenantId: string; scope: string; key: string }, fn: () => Promise<T>): Promise<T> {
  return tx.transaction(async (sp) => {
    const inserted = await sp.execute(sql`
      INSERT INTO onboarding_receipts (tenant_id, scope_key, operation_key, receipt)
      VALUES (${key.tenantId}, ${key.scope}, ${key.key}, NULL)
      ON CONFLICT (tenant_id, scope_key, operation_key) DO NOTHING
      RETURNING operation_key`);
    if (inserted.length === 0) {
      const rows = await sp.execute(sql`
        SELECT receipt FROM onboarding_receipts
        WHERE tenant_id = ${key.tenantId} AND scope_key = ${key.scope} AND operation_key = ${key.key}`);
      return rows[0]!['receipt'] as T;
    }
    const receipt = await fn();
    await sp.execute(sql`
      UPDATE onboarding_receipts SET receipt = ${JSON.stringify(receipt ?? null)}::jsonb
      WHERE tenant_id = ${key.tenantId} AND scope_key = ${key.scope} AND operation_key = ${key.key}`);
    return receipt;
  });
}
