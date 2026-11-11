import { describe, expect, it } from 'vitest';
import { ErrandQueue } from './errands.ts';

describe('a robot\'s errands run one at a time (H7 fix)', () => {
  it('runs errands in order, a step at a time, and is idle when done', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'plan', linger: 1 }, { to: 'seat' }]);
    q.push([{ to: 'prs', linger: 1 }, { to: 'seat' }]);
    expect(q.current()?.to).toBe('plan');
    q.arrived(0);
    expect(q.current()?.to).toBe('plan');
    q.tick(1.1);
    expect(q.current()?.to).toBe('seat');
    q.arrived(1.1);
    q.tick(1.2);
    expect(q.current()?.to).toBe('prs');
    q.arrived(1.2); q.tick(2.3); q.arrived(2.3); q.tick(2.4);
    expect(q.current()).toBeNull();
  });

  it('a held step waits on the roof until it is released, then the next errand runs', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.push([{ to: 'prs' }]);
    q.arrived(0);
    q.tick(60);
    expect(q.current()).toEqual({ to: 'roofCloud', hold: 'call' });
    q.release('call');
    expect(q.current()?.to).toBe('seat');
    q.arrived(61); q.tick(61);
    expect(q.current()?.to).toBe('prs');
  });

  it('a worker that needs you drops its walks and stays at its desk', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'prs', linger: 1 }, { to: 'seat' }]);
    q.needsYou();
    expect(q.current()?.to).toBe('seat');
    q.arrived(0); q.tick(0.1);
    expect(q.current()).toBeNull();
  });

  it('under reduced motion a robot is placed where its errands end, with nothing walked', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'plan', linger: 1 }, { to: 'seat' }]);
    expect(q.settle()).toBe('seat');
    expect(q.current()).toBeNull();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    expect(q.settle()).toBe('roofCloud');
    expect(q.current()).toEqual({ to: 'roofCloud', hold: 'call' });
  });

  it('round 3: clear() drops everything, held roof steps included, so a loop never leaves a robot on the roof', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.push([{ to: 'prs' }]);
    q.arrived(0);
    q.clear();
    expect(q.current()).toBeNull();
    expect(q.there).toBe(false);
  });

  it('round 3: a held roof step is released when the world says the worker has no cloud call', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.arrived(0);
    q.follow({ cloudCall: false });
    expect(q.current()?.to).toBe('seat');
    const kept = new ErrandQueue();
    kept.push([{ to: 'roofCloud', hold: 'call' }]);
    kept.follow({ cloudCall: true });
    expect(kept.current()).toEqual({ to: 'roofCloud', hold: 'call' });
  });
});
