import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every network primitive a browser or Node offers is replaced by a stub that records the call and throws. */
function stubNetwork(): { calls: string[] } {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error(`network use: ${name}`);
  };
  vi.stubGlobal('fetch', trap('fetch'));
  vi.stubGlobal('XMLHttpRequest', class { constructor() { trap('XMLHttpRequest')(); } });
  vi.stubGlobal('WebSocket', class { constructor() { trap('WebSocket')(); } });
  vi.stubGlobal('EventSource', class { constructor() { trap('EventSource')(); } });
  vi.stubGlobal('navigator', { sendBeacon: trap('sendBeacon') });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('mock module makes zero network calls', () => {
  it('the stubs can fail: any use throws and is recorded', async () => {
    const { calls } = stubNetwork();
    expect(() => fetch('http://127.0.0.1')).toThrow('network use: fetch');
    const g = globalThis as unknown as { XMLHttpRequest: new () => unknown; navigator: { sendBeacon(u: string): boolean } };
    expect(() => new g.XMLHttpRequest()).toThrow('network use: XMLHttpRequest');
    expect(() => new WebSocket('ws://127.0.0.1')).toThrow('network use: WebSocket');
    expect(() => new EventSource('http://127.0.0.1')).toThrow('network use: EventSource');
    expect(() => g.navigator.sendBeacon('x')).toThrow('network use: sendBeacon');
    expect(calls).toEqual(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']);
  });

  it('importing and exercising every fixture, command and terminal touches none of them', async () => {
    const { calls } = stubNetwork();
    vi.resetModules();
    const mod = await import('../src/index.ts');
    const ds = mod.createDemoDataSource();
    const received: unknown[] = [];
    for (const p of ds.listProjects()) {
      const snap = await ds.getSnapshot(p.projectId);
      const stop = ds.subscribe(p.projectId, snap.meta.cursor, (e) => received.push(e), (err) => { throw new Error(err.message); });
      for (const t of Object.values(snap.tasks)) {
        await ds.execute({ command: 'task.cancel', expectedRevision: t.aggregateRevision, idempotencyKey: `${p.projectId}:${t.taskId}`, args: { taskId: t.taskId } });
      }
      for (const a of Object.values(snap.approvals)) {
        await ds.execute({ command: 'approval.deny', expectedRevision: 0, idempotencyKey: `${p.projectId}:${a.approvalId}`, args: { approvalId: a.approvalId, scopeHash: a.scopeHash ?? 'x' } });
      }
      for (const at of Object.values(snap.attempts)) {
        const ch = await ds.openTerminal({ taskId: at.taskId, attemptId: at.attemptId, expectedRevision: 0 });
        ch.onLine(() => {});
        ch.close();
      }
      ds.clock.advance(600_000);
      await Promise.resolve();
      stop();
    }
    ds.disconnect();
    expect(received.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('no source file imports a network, process or runtime client', () => {
    const dirs = [join(import.meta.dirname, '../src'), join(import.meta.dirname, '../../view-protocol/src')];
    const banned = /from\s+['"](node:(http|https|net|tls|dgram|child_process|dns|worker_threads)|undici|ws|axios|node-fetch|firebase[^'"]*|@selarikru\/(runtime|inference|integrations|harness|persistence|control)[^'"]*)['"]/;
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
        expect(readFileSync(join(dir, f), 'utf8'), `${dir}/${f}`).not.toMatch(banned);
        expect(readFileSync(join(dir, f), 'utf8'), `${dir}/${f}`).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
      }
    }
  });
});
