import type { AiCheckpoint } from '@selarikru/view-protocol';
import { DataSourceException } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { createLiveDataSource } from '../src/index.ts';

type Call = { url: string; method: string; body: unknown };
function source(answers: ((call: Call) => { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const s = createLiveDataSource({
    baseUrl: 'http://x', getToken: async () => 't',
    fetch: (async (url: string, init?: RequestInit) => {
      const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      const a = answers[calls.length - 1]!(call);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
  });
  return { s, calls };
}
const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
  checkpointId: 'ckp_0123456789abcdef', projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'r1', planRevision: 1, stepKind: 'criteria', stage: 'criteria',
  callOverride: null, routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
  inputs: { contextId: 'ctx_1', bundleSha256: null, files: [], inputChars: 10 }, partial: null, stopReason: 'offline', status: 'waiting', routeRecordId: null,
  escalatedAt: null, resumedAs: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...over,
});

describe('live AI step checkpoints (H12)', () => {
  it('saves an internal checkpoint and lists them back, checked against the schema', async () => {
    const live = source([() => ({ status: 201, body: { checkpointId: 'ckp_0123456789abcdef', stored: 'server' } }), () => ({ status: 200, body: { checkpoints: [cp()] } })]);
    await live.s.saveAiCheckpoint!('p', cp());
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/projects/p/ai-checkpoints', method: 'POST', body: cp() });
    expect(await live.s.listAiCheckpoints!('p')).toEqual([cp()]);
  });

  it('never sends a restricted, secret or locked checkpoint: refused before any request', async () => {
    const live = source([]);
    for (const bad of [cp({ labels: ['restricted'] }), cp({ locked: true }), cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'CANARY', classification: 'restricted' }] } })]) {
      await expect(live.s.saveAiCheckpoint!('p', bad)).rejects.toBeInstanceOf(DataSourceException);
    }
    expect(live.calls).toEqual([]);
  });

  it('a listed checkpoint the server should never have kept is dropped', async () => {
    const live = source([() => ({ status: 200, body: { checkpoints: [cp(), cp({ checkpointId: 'ckp_restricted_01', labels: ['restricted'] }), { junk: true }] } })]);
    expect((await live.s.listAiCheckpoints!('p')).map((c) => c.checkpointId)).toEqual(['ckp_0123456789abcdef']);
  });

  it('claims an escalation once; a refusal keeps its reason', async () => {
    const live = source([
      () => ({ status: 200, body: { checkpoint: cp({ escalatedAt: '2026-11-12T00:01:00.000Z' }) } }),
      () => ({ status: 409, body: { error: { code: 'escalation_refused', message: 'no', details: { reason: 'already_escalated' } } } }),
    ]);
    expect((await live.s.claimAiCheckpointEscalation!('p', 'ckp_0123456789abcdef')).escalatedAt).toBe('2026-11-12T00:01:00.000Z');
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/projects/p/ai-checkpoints/ckp_0123456789abcdef/escalation', method: 'POST' });
    await expect(live.s.claimAiCheckpointEscalation!('p', 'ckp_0123456789abcdef')).rejects.toThrow(/escalation_refused/);
  });
});
