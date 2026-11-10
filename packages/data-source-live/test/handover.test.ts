import { describe, expect, it } from 'vitest';
import { DataSourceException } from '@selarikru/view-protocol';
import { createLiveDataSource } from '../src/index.ts';

const VIEW = { projectId: 'p', observedAt: '2026-11-10T08:00:00.000Z', notice: 'n', tasks: [], records: [] };

function source(answer: (url: string, method: string) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(url, init?.method ?? 'GET');
  }) as unknown as typeof globalThis.fetch;
  return { calls, ds: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch }) };
}

describe('the live handovers', () => {
  it('reads the view, sends a request and a decision to their routes, and answers with the handovers afterwards', async () => {
    const { calls, ds } = source((url, method) => new Response(JSON.stringify(method === 'GET' ? VIEW : { checkpointId: 'c', state: 'stopping' }), { status: method === 'GET' ? 200 : url.endsWith('/decision') ? 200 : 202 }));
    expect(await ds.getHandovers!('p')).toEqual(VIEW);
    expect(await ds.handoverAction!('p', { kind: 'request', taskId: 'T 1', mode: 'resume', idempotencyKey: 'k1' })).toEqual(VIEW);
    await ds.handoverAction!('p', { kind: 'decide', taskId: 'T1', checkpointId: 'c', choice: 'restart', idempotencyKey: 'k2' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
      ['http://x/v1/projects/p/tasks/T%201/handover', { mode: 'resume', idempotencyKey: 'k1' }],
      ['http://x/v1/projects/p/tasks/T1/handover/decision', { checkpointId: 'c', choice: 'restart', idempotencyKey: 'k2' }],
    ]);
  });

  it('passes a refusal on as typed', async () => {
    const refused = source(() => new Response(JSON.stringify({ error: { code: 'handover_refused', message: 'Restricted or secret work stays on this device.', details: { reason: 'restricted_work' } } }), { status: 403 }));
    await expect(refused.ds.handoverAction!('p', { kind: 'request', taskId: 'T1', mode: 'resume', idempotencyKey: 'k1' })).rejects.toBeInstanceOf(DataSourceException);
  });
});
