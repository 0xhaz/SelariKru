import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerLoop } from '../src/loop.ts';
import { gitBackedProjects, parseSlots } from '../src/repos.ts';

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('reporting project checkouts', () => {
  it('names only the projects whose path is a git repository, and warns about the rest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-repos-'));
    const repo = join(dir, 'repo');
    const notGit = join(dir, 'not-git');
    mkdirSync(repo);
    mkdirSync(notGit);
    execFileSync('git', ['init', '-q', repo]);
    const logs: string[] = [];
    const projects = await gitBackedProjects({ real: repo, wrong: notGit, missing: join(dir, 'absent') }, (l) => logs.push(l));
    expect(projects).toEqual(['real']);
    expect(logs.join('\n')).toContain('wrong');
    expect(logs.join('\n')).toContain('missing');
    expect(logs.join('\n')).not.toMatch(/\breal\b/);
  });

  it('the claim reports that list and not every configured path', async () => {
    const claim = vi.fn(async () => ({ lease: null, reason: 'nothing' }));
    const ctl = new AbortController();
    const loop = new RunnerLoop({ api: { claim } as never, runtime: {} as never, pollMs: 1, log: () => undefined, projects: ['real'], attempt: { repos: { real: '/r', wrong: '/w' } } as never, sleep: async () => ctl.abort() } as never);
    await loop.run(ctl.signal);
    expect((claim.mock.calls[0] as unknown[])[1]).toEqual(['real']);
  });
});

describe('slots', () => {
  it('claims for each slot at once, so one runner can hold two workers under the server\'s limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const ctl = new AbortController();
    const claim = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { lease: null, reason: 'nothing' };
    });
    const loop = new RunnerLoop({ api: { claim } as never, runtime: { sweepOrphans: async () => [] } as never, pollMs: 1, log: () => undefined, slots: 2, attempt: { repos: {} } as never, sleep: async () => ctl.abort() } as never);
    await loop.run(ctl.signal);
    expect(peak).toBe(2);
  });
});

describe('--slots', () => {
  it('defaults to two and takes a whole number', () => {
    expect(parseSlots(undefined)).toBe(2);
    expect(parseSlots('1')).toBe(1);
  });
  it.each(['abc', '0', '-1', '1.5', '', '2x'])('%s is a startup error', (raw) => expect(() => parseSlots(raw)).toThrow(/--slots/));
});

