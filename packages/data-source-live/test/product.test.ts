import { describe, expect, it } from 'vitest';
import { DataSourceException } from '@selarikru/view-protocol';
import { createLiveDataSource } from '../src/index.ts';

const VIEW = {
  projectId: 'p', observedAt: '2026-11-10T08:00:00.000Z', notice: 'n', brief: { confirmed: null, latest: null, seed: null, revision: 0 }, plans: [], releases: [], reviews: [], followUps: [],
  requirements: [{ id: 'FB-03', text: null }], mergedRuns: [], trace: [], milestones: [],
};
const UNKNOWN_MEASURE = { value: null, unit: null, provenance: 'unavailable' as const, basis: null };
const PLAN = {
  schemaVersion: 1 as const, requirementIds: ['FB-03'], milestone: null, metric: 'm', baseline: UNKNOWN_MEASURE, target: UNKNOWN_MEASURE, learningQuestion: 'q', windowDays: null, dataSource: null, cohort: null,
  guardrails: [], reviewOwner: 'o', reviewDate: null, decisionOptions: ['iterate' as const], reportLinks: [], confidence: 'unknown' as const,
};

function source(answer: (url: string, method: string) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(url, init?.method ?? 'GET');
  }) as unknown as typeof globalThis.fetch;
  return { calls, ds: createLiveDataSource({ baseUrl: 'http://x', getToken: async () => 't', fetch }) };
}

describe('the live product records', () => {
  it('reads the view, sends each write to its route, and answers with the view the write returned', async () => {
    const { calls, ds } = source((_url, method) => new Response(JSON.stringify(method === 'GET' ? VIEW : { record: {}, redacted: true, product: VIEW })));
    const read = await ds.getProduct!('p');
    expect(read).toMatchObject(VIEW);
    // The server's redaction notice is passed through.
    expect(await ds.productAction!('p', { kind: 'save_plan', recordId: null, expectedRevision: 0, content: PLAN })).toEqual({ product: read, redacted: true });
    await ds.productAction!('p', { kind: 'add_release', content: { schemaVersion: 1, runId: 'r', environment: 'production', configuration: null, releasedOn: '2026-11-12', note: null } });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['http://x/v1/projects/p/product/outcome-plans', 'http://x/v1/projects/p/product/releases']);
    // The unknown baseline goes over the wire as unknown: no number.
    expect((calls[1]!.body as { content: typeof PLAN }).content.baseline).toEqual({ value: null, unit: null, provenance: 'unavailable', basis: null });
  });

  it('passes a refusal on as typed', async () => {
    const refused = source(() => new Response(JSON.stringify({ error: { code: 'product_not_merged', message: 'no' } }), { status: 409 }));
    await expect(refused.ds.productAction!('p', { kind: 'add_release', content: { schemaVersion: 1, runId: 'r', environment: 'e', configuration: null, releasedOn: '2026-11-12', note: null } })).rejects.toBeInstanceOf(DataSourceException);
  });
});
