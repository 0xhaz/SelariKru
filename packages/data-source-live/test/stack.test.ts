import { describe, expect, it } from 'vitest';
import { DataSourceException } from '@selarikru/view-protocol';
import { createLiveDataSource } from '../src/index.ts';

const STACK = { projectId: 'p', revision: 0, detectionRevision: 0, unreadable: false, catalogVersion: '2026-11-10.1', document: { components: [], detection: null }, updatedBy: null, updatedAt: null, native: { ios: false, android: false } };

function source(answer: (url: string) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(url);
  }) as unknown as typeof globalThis.fetch;
  return { calls, ds: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch }) };
}

describe('the live stack settings', () => {
  it('reads the stack and posts an action with the revision it was read at, to the control API only', async () => {
    const { calls, ds } = source(() => new Response(JSON.stringify(STACK)));
    expect(await ds.getStack!('p 1')).toEqual(STACK);
    await ds.stackAction!('p 1', { expectedRevision: 0, action: { kind: 'category.set', path: '.', category: 'payments', state: 'none' } });
    expect(calls).toEqual([
      { url: 'http://x/v1/projects/p%201/stack', method: 'GET', body: undefined },
      { url: 'http://x/v1/projects/p%201/stack', method: 'POST', body: { expectedRevision: 0, action: { kind: 'category.set', path: '.', category: 'payments', state: 'none' } } },
    ]);
  });

  it('refuses a stack it cannot read and passes a refusal on as typed', async () => {
    await expect(source(() => new Response(JSON.stringify({ ...STACK, document: { components: 'x' } }))).ds.getStack!('p')).rejects.toBeInstanceOf(DataSourceException);
    const refused = source(() => new Response(JSON.stringify({ error: { code: 'stack_revision_conflict', message: 'changed' } }), { status: 409 }));
    await expect(refused.ds.stackAction!('p', { expectedRevision: 3, action: { kind: 'component.remove', path: '.' } })).rejects.toBeInstanceOf(DataSourceException);
  });
});
