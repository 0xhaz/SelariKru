import { describe, expect, it } from 'vitest';
import { HttpRunnerApi } from '../src/api.ts';
import { RunnerLoop } from '../src/loop.ts';
import { RunnerSettings } from '../src/settings.ts';

const CONFIG = (over: Record<string, unknown> = {}) => ({ revision: 4, enabled: true, slots: null, pausedRunIds: [], ...over });

/** A fetch that answers every claim and heartbeat with `config` and records what the runner sent. */
function fakeFetch(config: () => Record<string, unknown>, lease: unknown = null) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push({ path, body: JSON.parse(String(init.body)) });
    const body = path === '/v1/runners/claim' ? { lease, reason: lease ? null : 'no_claimable_task', config: config() } : { cancelRequested: false, config: config() };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, impl };
}

describe('the runner acknowledges the config it has applied', () => {
  it('acknowledges nothing until it has a config, then sends back the revision it applied and the slots it runs', async () => {
    let cfg = CONFIG({ slots: 1 });
    const f = fakeFetch(() => cfg);
    const settings = new RunnerSettings(2, () => undefined);
    const api = new HttpRunnerApi('http://127.0.0.1:1', 'srt_x', f.impl, settings);
    await api.claim();
    expect(f.sent[0]!.body['config']).toEqual({ revision: 0, slots: 2 });
    await api.claim();
    expect(f.sent[1]!.body['config']).toEqual({ revision: 4, slots: 1 });
    cfg = CONFIG({ revision: 5, enabled: false });
    await api.heartbeat({ attemptId: 'a', fence: 1, leaseToken: 't' });
    await api.heartbeat({ attemptId: 'a', fence: 1, leaseToken: 't' });
    expect(f.sent[3]!.body['config']).toEqual({ revision: 5, slots: 0 });
  });

  it('an older config never replaces a newer one, and one it cannot read is ignored', () => {
    const s = new RunnerSettings(2, () => undefined);
    s.apply(CONFIG({ revision: 7, slots: 1 }));
    s.apply(CONFIG({ revision: 6, slots: 2 }));
    expect(s.ack()).toEqual({ revision: 7, slots: 1 });
    s.apply({ revision: 'eight' });
    expect(s.ack()).toEqual({ revision: 7, slots: 1 });
  });

  it('never runs more slots than it was started with, whatever the server allows', () => {
    const s = new RunnerSettings(1, () => undefined);
    s.apply(CONFIG({ slots: 4 }));
    expect(s.ack().slots).toBe(1);
  });

  it('a slot past the limit stops claiming, the first one keeps polling so it hears the next change', () => {
    const s = new RunnerSettings(2, () => undefined);
    expect([s.mayClaim(0), s.mayClaim(1)]).toEqual([true, true]);
    s.apply(CONFIG({ slots: 1 }));
    expect([s.mayClaim(0), s.mayClaim(1)]).toEqual([true, false]);
    s.apply(CONFIG({ revision: 5, enabled: false }));
    expect([s.mayClaim(0), s.mayClaim(1)]).toEqual([true, false]);
  });

  it('logs what changed in its own words only: numbers and run ids, nothing from a worker', () => {
    const lines: string[] = [];
    const s = new RunnerSettings(2, (l) => lines.push(l));
    s.apply(CONFIG({ slots: 1, pausedRunIds: ['run_1'] }));
    expect(lines.join('\n')).toMatch(/config revision 4/);
    expect(lines.join('\n')).toMatch(/1 of 2 slot/);
    expect(lines.join('\n')).toMatch(/paused: run_1/);
  });

  it('in the loop, a slot the owner took away sleeps instead of claiming', async () => {
    const settings = new RunnerSettings(2, () => undefined);
    settings.apply(CONFIG({ slots: 1 }));
    const claims: number[] = [];
    let polls = 0;
    const ctl = new AbortController();
    const api = { claim: async () => { claims.push(polls); return { lease: null, reason: 'none' }; } } as never;
    const loop = new RunnerLoop({ api, runtime: { sweepOrphans: async () => [] } as never, attempt: {} as never, pollMs: 1, slots: 2, projects: [], settings, log: () => undefined, sleep: async () => { polls += 1; if (polls >= 6) ctl.abort(); } });
    await loop.run(ctl.signal);
    // Two slots ran, but only one ever claimed: the other slept on every pass.
    expect(claims.length).toBeLessThan(polls);
    expect(claims.length).toBeGreaterThan(0);
  });
});
