import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditMounts, assertSafeWorkspace, UnsafeWorkspaceError } from './guards.ts';
import { assertSafeSbxArgs, UnsafeSbxCommandError } from './sbx.ts';
import { sandboxName } from './names.ts';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'guards-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace guard', () => {
  it('home directory and Docker socket not mounted', async () => {
    const home = homedir();
    const opts = { home, forbidden: ['/repo/selarikru'], attemptsRoot: null };
    for (const p of [home, join(home, '.claude'), join(home, '.claude', 'projects'), join(home, '.ssh'), join(home, '.aws'), '/', '/var/run/docker.sock', '/var/run', join(home, '..')])
      await expect(assertSafeWorkspace(p, opts), p).rejects.toBeInstanceOf(UnsafeWorkspaceError);
    // the SelariKru repository, or anything containing or inside it
    await expect(assertSafeWorkspace('/repo/selarikru', opts)).rejects.toBeInstanceOf(UnsafeWorkspaceError);
    await expect(assertSafeWorkspace('/repo/selarikru/apps', opts)).rejects.toBeInstanceOf(UnsafeWorkspaceError);
    await expect(assertSafeWorkspace('/repo', opts)).rejects.toBeInstanceOf(UnsafeWorkspaceError);
  });

  it('accepts a per-attempt directory under the runner work root, and rejects one outside it or behind a symlink', async () => {
    const attempts = join(root, 'attempts');
    await mkdir(join(attempts, 'a1', 'workspace'), { recursive: true });
    const opts = { home: '/Users/nobody', forbidden: [], attemptsRoot: attempts };
    await expect(assertSafeWorkspace(join(attempts, 'a1', 'workspace'), opts)).resolves.toBe(join(attempts, 'a1', 'workspace'));
    await mkdir(join(root, 'elsewhere'));
    await expect(assertSafeWorkspace(join(root, 'elsewhere'), opts)).rejects.toBeInstanceOf(UnsafeWorkspaceError);
    await symlink(join(root, 'elsewhere'), join(attempts, 'link'));
    await expect(assertSafeWorkspace(join(attempts, 'link'), opts)).rejects.toBeInstanceOf(UnsafeWorkspaceError);
  });

  it('mount audit accepts only the single workspace bind mount', () => {
    const ws = '/w/a1/workspace';
    expect(auditMounts([`${ws}:${ws}`], ws, { home: '/Users/h' })).toEqual([]);
    expect(auditMounts([`${ws}:${ws}`, '/Users/h:/home/agent'], ws, { home: '/Users/h' }).length).toBe(1);
    expect(auditMounts([`${ws}:${ws}`, '/var/run/docker.sock:/var/run/docker.sock'], ws, { home: '/Users/h' }).length).toBe(1);
    expect(auditMounts([`${ws}:${ws}`, '/Users/h/.claude:/home/agent/.claude:ro'], ws, { home: '/Users/h' }).length).toBe(1);
    expect(auditMounts([`${ws}:${ws}`, '/x/agent-skills:/home/agent/.claude/skills:ro'], ws, { home: '/Users/h' }).length).toBe(1);
    expect(auditMounts([], ws, { home: '/Users/h' }).length).toBe(1);
  });
});

describe('sbx command allow-list', () => {
  const ours = sandboxName('tenant_a:runner_1', 't1', 'a1');
  it('allows only our verbs on our sandboxes', () => {
    expect(() => assertSafeSbxArgs(['ls', '--json'])).not.toThrow();
    expect(() => assertSafeSbxArgs(['stop', ours])).not.toThrow();
    expect(() => assertSafeSbxArgs(['rm', '--force', ours])).not.toThrow();
    expect(() => assertSafeSbxArgs(['exec', '-w', '/w', ours, 'claude'])).not.toThrow();
    expect(() => assertSafeSbxArgs(['create', '--name', ours, 'claude', '/w'])).not.toThrow();
  });
  it('refuses reset, prune, policy, settings, daemon, cloud, and any sandbox that is not ours', () => {
    for (const a of [['reset'], ['prune'], ['policy', 'init', 'allow-all'], ['settings', 'set', 'x', 'y'], ['daemon', 'stop'], ['--cloud', 'ls'], ['attach', ours], ['move', ours],
      ['stop', 'hq-askwell-jim'], ['rm', '--force', 'hq-askwell-jim'], ['rm', '--force', ours, 'hq-askwell-jim'], ['exec', 'hq-askwell-jim', 'sh'], ['exec', '-w', '/w', 'selarikru-spike-a', 'sh'],
      ['create', '--name', 'hq-askwell-x', 'claude', '/w'], ['create', '--name', 'selarikru-t12345678-a87654321', 'claude', '/w'], ['stop', ours, 'hq-askwell-jim'], ['rm', ours]])
      expect(() => assertSafeSbxArgs(a), a.join(' ')).toThrow(UnsafeSbxCommandError);
  });
});
