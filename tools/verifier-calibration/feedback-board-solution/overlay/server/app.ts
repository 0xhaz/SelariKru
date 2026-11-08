import type Database from 'better-sqlite3';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_STATUSES, type FeedbackStatus, type StatusFilter } from '../contract/api';
import { insertFeedback, listFeedback, updateStatus } from './store';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const fail = (res: express.Response, status: number, code: string, message: string, fields?: Record<string, string>) =>
  res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}) } });
const points = (s: string) => [...s].length; // Unicode code points, no normalization

export function createApp(db?: Database.Database): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => { res.status(200).json({ status: 'ok' }); });

  if (db) {
    const store = db;
    app.get('/api/feedback', (req, res) => {
      const q = req.query.status;
      const filter = q === undefined ? 'all' : q;
      if (typeof filter !== 'string' || !(filter === 'all' || (FEEDBACK_STATUSES as readonly string[]).includes(filter))) {
        return fail(res, 400, 'invalid_status', 'status must be one of all, open, planned, done', { status: 'invalid' });
      }
      res.json(listFeedback(store, filter as StatusFilter));
    });

    app.post('/api/feedback', (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      const fields: Record<string, string> = {};
      let title = '';
      let description = '';
      if (typeof body?.title !== 'string') fields.title = 'Title must be text.';
      else {
        title = body.title.trim();
        if (points(title) < 3 || points(title) > 120) fields.title = 'Title must be 3 to 120 characters.';
      }
      if (body?.description !== undefined) {
        if (typeof body.description !== 'string') fields.description = 'Description must be text.';
        else {
          description = body.description.trim();
          if (points(description) > 1000) fields.description = 'Description must be at most 1,000 characters.';
        }
      }
      if (Object.keys(fields).length > 0) return fail(res, 400, 'validation_failed', Object.values(fields).join(' '), fields);
      res.status(201).json({ item: insertFeedback(store, title, description) });
    });

    app.patch('/api/feedback/:id', (req, res) => {
      const status = (req.body as { status?: unknown } | undefined)?.status;
      if (typeof status !== 'string' || !(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
        return fail(res, 400, 'validation_failed', 'Status must be open, planned or done.', { status: 'invalid' });
      }
      const item = updateStatus(store, req.params.id, status as FeedbackStatus);
      if (!item) return fail(res, 404, 'not_found', 'Feedback item not found.');
      res.json({ item });
    });
  }

  app.use('/api', (_req, res) => { fail(res, 404, 'not_found', 'Not found.'); });

  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(join(DIST, 'index.html')) : next()));
  }

  // malformed JSON and other body errors are the client's fault
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    fail(res, status, status === 500 ? 'internal_error' : 'bad_request', status === 500 ? 'Internal error.' : 'Malformed request body.');
  });
  return app;
}
