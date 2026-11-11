import { describe, expect, it, vi } from 'vitest';
import { createMockDataSource, createSeededClock, fixtureTime, scoped } from '@selarikru/data-source-mock';
import { AGENT_ACTIONS } from './model.ts';
import { createAgents } from './agents.ts';
import { createDemoSdk } from './demo-sdk.ts';

const id = (local: string) => scoped('feature-delivery', local);

async function setup(opts: Parameters<typeof createDemoSdk>[0] = {}) {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const projectId = 'demo-feature-delivery';
  const snapshot = await ds.getSnapshot(projectId);
  const executed: unknown[] = [];
  const agents = createAgents({
    projectId, source: ds, sdk: createDemoSdk(opts), simulated: true,
    execute: async (c) => { executed.push(c); return ds.execute(c); },
    snapshot: () => snapshot,
  });
  return { ds, agents: agents!, executed, projectId };
}

describe('the demo runs every task step through the real adapter, with no live model', () => {
  it.each(AGENT_ACTIONS.map((a) => a.kind))('%s on a task with work on record comes back as a valid proposal, labelled demo data, and its route is reported', async (kind) => {
    const { agents, executed } = await setup();
    const task = kind === 'triage' ? id('web') : id('api');
    const out = await agents.run({ taskId: task, kind, callOverride: null });
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.result.proposal.status).toBe('ok');
    expect(out.result.proposal.validation.status).toBe('passed');
    expect(out.result.proposal.route).toMatchObject({ taskId: task, stepKind: kind });
    expect(out.simulated).toBe(true);
    expect(out.result.reported).toBe('sent');
    expect(executed).toContainEqual(expect.objectContaining({ command: 'route.report', args: expect.objectContaining({ taskId: task }) }));
  });

  it('a cloud route answers from the cloud and a device route from this device', async () => {
    const { agents } = await setup();
    const cloud = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
    const device = await agents.run({ taskId: id('search'), kind: 'criteria', callOverride: null });
    expect(cloud.kind === 'result' && cloud.result.proposal.observedSource).toBe('IN_CLOUD');
    expect(device.kind === 'result' && device.result.proposal.observedSource).toBe('ON_DEVICE');
    const override = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: 'ONLY_ON_DEVICE' });
    expect(override.kind === 'result' && override.result.proposal.observedSource).toBe('ON_DEVICE');
  });

  it('the locked task stays on this device even with a cloud call override, and its result is marked locked', async () => {
    const { agents } = await setup();
    const out = await agents.run({ taskId: id('e2e'), kind: 'criteria', callOverride: 'ONLY_IN_CLOUD' });
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.result.proposal.observedSource).toBe('ON_DEVICE');
    expect(out.result.locked).toBe(true);
    expect(out.result.proposal.route).toMatchObject({ locked: true, effectiveMode: 'ONLY_ON_DEVICE' });
  });

  it('a call in flight says where it is going, and is cleared when it ends', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { agents } = await setup({ beforeGenerate: () => held });
    const seen: string[] = [];
    const off = agents.onInFlight((calls) => seen.push(calls.map((c) => `${c.taskId}:${c.place}`).join(',')));
    const run = agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
    await vi.waitFor(() => expect(seen.at(-1)).toBe(`${id("contract")}:cloud`));
    release();
    await run;
    expect(seen.at(-1)).toBe('');
    off();
  });

  it('reads a task\'s facts for the destination its fresh route allows, and never pulls a bundle to count characters', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const projectId = 'demo-feature-delivery';
    const reads: string[] = [];
    const spied = {
      getTaskRoute: (p: string, t: string) => { reads.push('route'); return ds.getTaskRoute!(p, t); },
      getTaskContext: (p: string, t: string, d: 'local' | 'cloud', o?: string | null) => { reads.push(`context:${d}`); return ds.getTaskContext!(p, t, d, o); },
      getTaskContextSize: (p: string, t: string, d: 'local' | 'cloud') => { reads.push(`size:${d}`); return ds.getTaskContextSize!(p, t, d); },
    };
    const agents = createAgents({ projectId, source: spied, sdk: createDemoSdk(), simulated: true, execute: (c) => ds.execute(c), snapshot: () => null })!;
    expect(await agents.facts(id('e2e'))).toMatchObject({ hasChange: false });
    expect(reads).toEqual(['route', 'size:local']);
    reads.length = 0;
    expect((await agents.facts(id('api'))).hasChange).toBe(true);
    expect(reads).toEqual(['route', 'size:cloud']);
  });
});
