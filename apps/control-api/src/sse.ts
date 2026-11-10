import { readEventsAfter } from '@selarikru/persistence';
import { restrictedStoredPayload } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError, invalidRequest } from './errors.ts';
import { requireProject } from './store.ts';

const BATCH = 500;

function parseCursor(raw: unknown): number {
  if (raw === undefined || raw === '') return 0;
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) throw invalidRequest('cursor must be a non-negative integer');
  return Number(s);
}

/**
 * Replayable SSE. Authentication is the Authorization header only (clients use fetch streaming), so no credential
 * ever appears in a URL. Events are sent in sequence order starting after the cursor; the counter row serialises
 * appenders per project, so a committed sequence N+1 is never visible before N and polling cannot skip an event.
 */
export function registerEventStream(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  app.get('/v1/projects/:id/events', { onRequest: [ctx.owner] }, async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    const query = req.query as Record<string, unknown>;
    await requireProject(db, config.tenantId, projectId);
    const after = parseCursor(query['after'] ?? req.headers['last-event-id']);

    const seq = await db.execute(sql`SELECT last_sequence FROM project_sequences WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId}`);
    const head = Number(seq[0]?.['last_sequence'] ?? 0);
    if (after > head) throw new AppError(409, 'cursor_ahead', 'the cursor is beyond the end of the stream; resynchronise from a snapshot', { cursor: head });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...ctx.corsHeaders(req.corsOrigin),
    });
    raw.write(': stream open\n\n');

    let closed = false;
    let wake: (() => void) | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      ctx.openStreams.delete(close);
      wake?.();
      raw.end();
    };
    ctx.openStreams.add(close);
    req.raw.on('close', close);
    if (ctx.lifecycle.closing) close();

    const write = async (chunk: string): Promise<void> => {
      if (!raw.write(chunk) && !closed) await new Promise<void>((res) => raw.once('drain', () => res()));
    };
    const sleep = (ms: number) => new Promise<void>((res) => {
      const timer = setTimeout(res, ms);
      wake = () => { clearTimeout(timer); res(); };
    });

    /** Which of these attempts the claim did not clear for streaming. A missing label counts as restricted. */
    const restrictedAttemptsOf = async (ids: readonly (string | null)[]): Promise<ReadonlySet<string>> => {
      const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
      if (wanted.length === 0) return new Set();
      const rows = await db.execute(sql`SELECT attempt_id FROM attempts WHERE tenant_id = ${config.tenantId} AND project_id = ${projectId} AND attempt_id IN (${sql.join(wanted.map((id) => sql`${id}`), sql`, `)}) AND coalesce(detail ->> 'terminalStreamable' = 'true', false) = false`);
      return new Set(rows.map((r) => String(r['attempt_id'])));
    };

    let cursor = after;
    let lastWrite = Date.now();
    try {
      while (!closed) {
        const batch = await readEventsAfter(db, config.tenantId, projectId, cursor, BATCH);
        const restricted = await restrictedAttemptsOf(batch.map((e) => e.attemptId));
        for (const e of batch) {
          // A restricted attempt's reasons are read through the closed list: events from before it may hold a runner's sentence, and stored rows are never rewritten.
          const shown = e.attemptId !== null && restricted.has(e.attemptId) ? { ...e, payload: restrictedStoredPayload(e.payload) } : e;
          await write(`id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(shown)}\n\n`);
          cursor = e.sequence;
          lastWrite = Date.now();
        }
        if (batch.length === BATCH) continue;
        if (Date.now() - lastWrite >= config.sse.keepAliveMs) {
          await write(': keepalive\n\n');
          lastWrite = Date.now();
        }
        await sleep(config.sse.pollIntervalMs);
      }
    } catch (e) {
      app.log.error(e);
    } finally {
      close();
    }
  });
}
