import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate';

/** Default database path. Override with FEEDBACK_DB_PATH (use ':memory:' for tests). */
export const DEFAULT_DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../data/feedback.sqlite');

export function openDatabase(path: string = process.env.FEEDBACK_DB_PATH ?? DEFAULT_DB_PATH): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}
