import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies `migrations/*.sql` (drizzle-kit output) in name order, once each, tracked in `schema_migrations`.
 * The target schema is whatever the connection's search_path selects; drizzle-kit's `"public".` qualifiers
 * are stripped so a non-default schema works. A transaction-level advisory lock serialises concurrent runners.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('selarikru_migrate'))`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await tx.execute(sql`SELECT name FROM schema_migrations`)).map((r) => String(r['name'])));
    for (const file of files) {
      if (done.has(file)) continue;
      const text = readFileSync(join(dir, file), 'utf8').replaceAll('"public".', '');
      for (const stmt of text.split('--> statement-breakpoint')) {
        if (stmt.trim()) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(sql`INSERT INTO schema_migrations (name) VALUES (${file})`);
      applied.push(file);
    }
  });
  return applied;
}
