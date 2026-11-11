/**
 * The whole path with real sockets: browser client, real API on a throwaway schema, real runner WebSocket, the bridge, a fake PTY. Only the shell itself is a stand-in, because the guest helper
 * and `sbx exec -i` were checked against a real sandbox separately.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '@selarikru/control-api';
import { API_POLICY, ORIGIN, OWNER_TOKEN, enrolRunner, fakeVerifier, seedTask, setupTestDb, specFor, testConfig, resetDb, PROJECT, type TestDb } from '@selarikru/control-api/test-helpers';
import type { ControlShell, ControlShellEvent, RuntimeAdapter, SandboxHandle } from '@selarikru/protocol';
import { createScheduler } from '@selarikru/workflow';
import { TEST_CATALOG, POLICY, testClock } from '@selarikru/workflow/test-helpers';
import { ControlBridge, wsControlConnector } from '../src/control.ts';

class FakePty implements ControlShell {
  readonly inputs: Array<{ seq: number; data: string }> = [];
  private readonly waiters: ((v: IteratorResult<ControlShellEvent>) => void)[] = [];
  private readonly queue: ControlShellEvent[] = [];
  closed = false;
  readonly events: AsyncIterable<ControlShellEvent> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { const e = this.queue.shift(); if (e) resolve({ value: e, done: false }); else this.waiters.push(resolve); }) }) };
  emit(e: ControlShellEvent): void { const w = this.waiters.shift(); if (w) w({ value: e, done: false }); else this.queue.push(e); }
  input(seq: number, data: string): void { this.inputs.push({ seq, data }); }
  async close(): Promise<void> { this.closed = true; const w = this.waiters.shift(); if (w) w({ value: undefined, done: true }); }
}

let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); await resetDb(t.db); });
afterAll(async () => { await t.close(); });

const wait = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out');
};

describe('control mode end to end', () => {
  it('a typed line travels browser to API to runner to shell, is audited, and the output comes back through the terminal channel', async () => {
    const clock = testClock();
    const config = testConfig();
    const policy = { ...API_POLICY, operations: { ...API_POLICY.operations, terminal_control: 'allow' as const } };
    const app = buildApp({ config, db: t.db, verifier: fakeVerifier, now: clock.now, policy, scheduler: createScheduler({ codingWorkers: 'claude_code', catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: POLICY }), catalog: TEST_CATALOG });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const shell = new FakePty();
    let bridge: ControlBridge | null = null;
    try {
      await seedTask(t.db, specFor('t1'), 'ready');
      const runner = await enrolRunner(app, 'local');
      const claim = await app.inject({ method: 'POST', url: '/v1/runners/claim', headers: { authorization: `Bearer ${runner.token}` }, payload: {} });
      const lease = claim.json().lease as { attemptId: string; fence: number; leaseToken: string; streamable: boolean; controllable: boolean };
      expect(lease.streamable).toBe(true);
      expect(lease.controllable).toBe(true);
      const ref = { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken };
      await app.inject({ method: 'POST', url: '/v1/runners/terminal', headers: { authorization: `Bearer ${runner.token}` }, payload: { lease: ref, seq: 0, lines: [], dropped: 0, ended: false } });

      const handle: SandboxHandle = { sandboxId: 'sb', attemptId: lease.attemptId, taskId: 't1', workspacePath: '/ws' };
      const opened: string[] = [];
      bridge = new ControlBridge({ connect: wsControlConnector(base, runner.token)(ref), runtime: { openControlShell: async (_h: SandboxHandle, sid: string) => { opened.push(sid); shell.emit({ kind: 'echo', on: true }); return shell; } } as unknown as RuntimeAdapter, handle, log: () => undefined, limits: { flushMs: 1, promptMs: 20 } });
      bridge.start();

      // The bridge is connected once a ticket can be minted.
      await wait(() => true);
      let ticket: { status: number; body: { ticket: string } } | null = null;
      for (let i = 0; i < 100 && (ticket === null || ticket.status !== 201); i += 1) {
        const r = await app.inject({ method: 'POST', url: `/v1/projects/${PROJECT}/attempts/${lease.attemptId}/terminal/control-tickets`, headers: { authorization: `Bearer ${OWNER_TOKEN}`, origin: ORIGIN }, payload: { idempotencyKey: `k${i}` } });
        ticket = { status: r.statusCode, body: r.json() };
        if (ticket.status !== 201) await new Promise((res) => setTimeout(res, 20));
      }
      expect(ticket!.status).toBe(201);

      const frames: Array<Record<string, unknown>> = [];
      const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/projects/${PROJECT}/attempts/${lease.attemptId}/terminal/control`, { origin: ORIGIN });
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });
      ws.send(JSON.stringify({ type: 'auth', ticket: ticket!.body.ticket }));
      await wait(() => frames.some((f) => f['type'] === 'ready'));
      expect(opened).toHaveLength(1);

      ws.send(JSON.stringify({ type: 'input', seq: 1, text: 'echo hello' }));
      await wait(() => shell.inputs.length === 1);
      expect(shell.inputs[0]).toEqual({ seq: 1, data: 'echo hello\r' });
      shell.emit({ kind: 'ack', seq: 1, echo: true });
      shell.emit({ kind: 'output', text: 'echo hello\nhello\n$ ' });
      await wait(() => frames.some((f) => f['type'] === 'ack' && f['seq'] === 1 && f['disposition'] === 'recorded'));

      const res = await fetch(`${base}/v1/projects/${PROJECT}/attempts/${lease.attemptId}/terminal`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
      const reader = res.body!.getReader();
      let text = '';
      const until = Date.now() + 2000;
      while (!text.includes('hello') && Date.now() < until) {
        const r = await reader.read();
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
      await reader.cancel();
      expect(text).toContain('[shell] hello');
      const rows = await t.db.execute(sql`SELECT text, disposition, seq FROM control_inputs`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ text: 'echo hello', disposition: 'recorded' });

      ws.send(JSON.stringify({ type: 'leave' }));
      await wait(() => frames.some((f) => f['type'] === 'ended' && f['reason'] === 'left'));
      await wait(() => shell.closed);
      const [marked] = await t.db.execute(sql`SELECT human_intervened_at FROM attempts WHERE attempt_id = ${lease.attemptId}`);
      expect(marked!['human_intervened_at']).not.toBeNull();
      ws.close();
    } finally {
      await bridge?.shutdown();
      await app.close();
    }
  });
});
