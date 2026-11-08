import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { Feedback, FeedbackCounts, FeedbackStatus, StatusFilter } from '../contract/api';

interface Row { id: string; title: string; description: string; status: FeedbackStatus; created_at: string }
const toItem = (r: Row): Feedback => ({ id: r.id, title: r.title, description: r.description, status: r.status, createdAt: r.created_at });

let lastMs = 0;
let seq = 0;
/** Fixed-width, so lexical order equals creation order: fb_<13-digit epoch ms><4-digit sequence>. */
export function newId(): string {
  const ms = Date.now();
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  return `fb_${String(ms).padStart(13, '0')}${String(seq).padStart(4, '0')}`;
}

export function listFeedback(db: Database.Database, filter: StatusFilter): { items: Feedback[]; counts: FeedbackCounts } {
  const rows = (filter === 'all'
    ? db.prepare('SELECT * FROM feedback ORDER BY created_at DESC, id DESC').all()
    : db.prepare('SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC, id DESC').all(filter)) as Row[];
  const counts: FeedbackCounts = { all: 0, open: 0, planned: 0, done: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all() as Array<{ status: FeedbackStatus; n: number }>) {
    counts[r.status] = r.n;
    counts.all += r.n;
  }
  return { items: rows.map(toItem), counts };
}

export function insertFeedback(db: Database.Database, title: string, description: string): Feedback {
  const item: Feedback = { id: newId(), title, description, status: 'open', createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO feedback (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)').run(item.id, title, description, item.status, item.createdAt);
  return item;
}

export function updateStatus(db: Database.Database, id: string, status: FeedbackStatus): Feedback | null {
  const info = db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id);
  if (info.changes === 0) return null;
  return toItem(db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as Row);
}

/** Inserts the seed file's items verbatim, only when the table is empty. */
export function seedIfEmpty(db: Database.Database, seedFile: string | undefined): void {
  if (!seedFile) return;
  const n = (db.prepare('SELECT COUNT(*) FROM feedback').pluck().get() as number);
  if (n > 0) return;
  const { items } = JSON.parse(readFileSync(seedFile, 'utf8')) as { items: Feedback[] };
  const ins = db.prepare('INSERT INTO feedback (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => { for (const i of items) ins.run(i.id, i.title, i.description, i.status, i.createdAt); })();
}
