import type Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Applies `migrations/*.sql` in lexical filename order, once each.
 * The baseline ships no migration files, so nothing but the bookkeeping table is created.
 */
export function runMigrations(db: Database.Database, dir: string = MIGRATIONS_DIR): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  const applied: string[] = [];
  for (const name of names) {
    if (done.has(name)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
    applied.push(name);
  }
  return applied;
}
