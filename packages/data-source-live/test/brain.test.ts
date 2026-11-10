import { describe, expect, it } from 'vitest';
import { DataSourceException } from '@selarikru/view-protocol';
import { createLiveDataSource } from '../src/index.ts';

const BRAIN = { projectId: 'p', observedAt: '2026-11-10T08:00:00.000Z', sourceHead: 0, indexLag: 0, compilation: null, sources: [], revocations: [], conflicts: [] };

function source(answer: (url: string, init: RequestInit | undefined) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { calls, ds: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch }) };
}

describe('the live Project Brain reads', () => {
  it('reads the Brain, posts a revoke and a keep to their routes, and reads a missing context bundle as null', async () => {
    const { calls, ds } = source((url) => (url.includes('/context') ? new Response(JSON.stringify({ error: { code: 'attempt_not_found', message: 'no' } }), { status: 404 }) : new Response(JSON.stringify(BRAIN))));
    expect(await ds.getBrain!('p')).toEqual(BRAIN);
    await ds.brainAction!('p', { kind: 'revoke', sourceId: 'criteria:p', reason: 'wrong' });
    await ds.brainAction!('p', { kind: 'keep', conflictId: 'conflict:criterion:FB-03:note:n@1' });
    expect(await ds.getAttemptContext!('p', 'att 1')).toBeNull();
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', 'http://x/v1/projects/p/brain', undefined],
      ['POST', 'http://x/v1/projects/p/brain/sources/criteria%3Ap/revoke', { reason: 'wrong' }],
      ['POST', 'http://x/v1/projects/p/brain/conflicts/conflict%3Acriterion%3AFB-03%3Anote%3An%401/keep', {}],
      ['GET', 'http://x/v1/projects/p/attempts/att%201/context', undefined],
    ]);
  });

  it('refuses a Brain it cannot read, and passes a server refusal on as typed', async () => {
    const bad = source(() => new Response(JSON.stringify({ ...BRAIN, compilation: { nope: true } })));
    await expect(bad.ds.getBrain!('p')).rejects.toBeInstanceOf(DataSourceException);
    const refused = source(() => new Response(JSON.stringify({ error: { code: 'brain_source_revoked', message: 'already' } }), { status: 409 }));
    await expect(refused.ds.brainAction!('p', { kind: 'revoke', sourceId: 's:x', reason: 'r' })).rejects.toBeInstanceOf(DataSourceException);
  });
});
