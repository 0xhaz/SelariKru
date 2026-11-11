import { describe, expect, it } from 'vitest';
import { createPlayback } from './playback.ts';

/** A fake real-time clock: the test moves it, and scheduled ticks fire in order. */
function fakeTimer() {
  let now = 0;
  const jobs: { at: number; every: number; fn: () => void }[] = [];
  return {
    now: () => now,
    every: (fn: () => void, ms: number) => { const job = { at: now + ms, every: ms, fn }; jobs.push(job); return () => { jobs.splice(jobs.indexOf(job), 1); }; },
    run(ms: number) { const end = now + ms; for (;;) { const next = jobs.filter((j) => j.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; now = next.at; next.at += next.every; next.fn(); } now = end; },
  };
}

describe('demo playback on a real clock (H7 fix)', () => {
  it('advances the demo by real time times the speed while playing, and not at all while paused', () => {
    const timer = fakeTimer();
    let virtual = 0;
    const play = createPlayback({ advance: (ms) => { virtual += ms; }, remaining: () => 5, restart: () => undefined, every: timer.every, now: timer.now, playing: true });
    timer.run(1000);
    expect(virtual).toBe(1000);
    play.setSpeed(4);
    timer.run(1000);
    expect(virtual).toBe(5000);
    play.pause();
    timer.run(5000);
    expect(virtual).toBe(5000);
    expect(play.state()).toEqual({ playing: false, speed: 4 });
    play.play();
    timer.run(250);
    expect(virtual).toBe(6000);
    play.stop();
  });

  it('loops back to the start once the script has nothing left, after a short rest', () => {
    const timer = fakeTimer();
    let left = 2;
    let restarts = 0;
    createPlayback({ advance: () => { left = Math.max(0, left - 1); }, remaining: () => left, restart: () => { restarts += 1; left = 2; }, every: timer.every, now: timer.now, playing: true, restMs: 3000 });
    timer.run(1000);
    expect(left).toBe(0);
    expect(restarts).toBe(0);
    timer.run(3500);
    expect(restarts).toBe(1);
  });

  it('starts paused when asked (reduced motion, tests)', () => {
    const timer = fakeTimer();
    let virtual = 0;
    const play = createPlayback({ advance: (ms) => { virtual += ms; }, remaining: () => 1, restart: () => undefined, every: timer.every, now: timer.now, playing: false });
    timer.run(2000);
    expect(virtual).toBe(0);
    expect(play.state().playing).toBe(false);
  });
});
