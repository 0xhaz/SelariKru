import { describe, expect, it } from 'vitest';
import { DataSourceException } from '@selarikru/view-protocol';
import { createLiveDataSource } from '../src/index.ts';

const VIEW = { projectId: 'p', catalog: [], bindings: [], roles: ['backend'] };

function source(answer: (url: string, method: string) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(url, init?.method ?? 'GET');
  }) as unknown as typeof globalThis.fetch;
  return { calls, ds: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch }) };
}

describe('the live skill library', () => {
  it('reads the library, sends each action to its route, and reads the library again', async () => {
    const { calls, ds } = source((url, method) => new Response(JSON.stringify(method === 'GET' && url.endsWith('/skills') ? VIEW : {})));
    expect(await ds.getSkills!('p')).toEqual({ ...VIEW, paths: [], waitingForRunnerUpdate: [], history: [] });
    await ds.skillAction!('p', { kind: 'intake', path: '/packs/style' });
    await ds.skillAction!('p', { kind: 'review', versionId: 'tp-x@1.0.0', acknowledgeFindings: true });
    await ds.skillAction!('p', { kind: 'revoke', versionId: 'tp-x@1.0.0', reason: 'wrong' });
    await ds.skillAction!('p', { kind: 'bind', skillId: 'tp-x', expectedRevision: 2, binding: null });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { url: 'http://x/v1/projects/p/skills/intake', method: 'POST', body: { path: '/packs/style' } },
      { url: 'http://x/v1/projects/p/skills/review', method: 'POST', body: { versionId: 'tp-x@1.0.0', acknowledgeFindings: true } },
      { url: 'http://x/v1/projects/p/skills/revoke', method: 'POST', body: { versionId: 'tp-x@1.0.0', reason: 'wrong' } },
      { url: 'http://x/v1/projects/p/skills/bindings', method: 'POST', body: { skillId: 'tp-x', expectedRevision: 2, binding: null } },
    ]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(5);
  });

  it('reads an attempt record, and passes a refusal on as typed', async () => {
    const att = { attemptId: 'a 1', record: null, revoked: [] };
    expect(await source(() => new Response(JSON.stringify(att))).ds.getAttemptSkills!('p', 'a 1')).toEqual({ ...att, confirmedAt: null });
    const refused = source(() => new Response(JSON.stringify({ error: { code: 'skill_not_reviewed', message: 'no' } }), { status: 409 }));
    await expect(refused.ds.skillAction!('p', { kind: 'bind', skillId: 'x', expectedRevision: 0, binding: null })).rejects.toBeInstanceOf(DataSourceException);
  });
});
