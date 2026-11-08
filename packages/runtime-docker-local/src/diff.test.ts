import { mkdir, mkdtemp, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAllowedPaths, computeChanges, snapshotTree } from './diff.ts';

let dir: string;
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), body);
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diff-'));
  await put('src/a.ts', 'a');
  await put('src/b.ts', 'b');
  await put('contract/runtime.md', 'c');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('post-run diff', () => {
  it('reports added, modified and deleted files against the base snapshot, ignoring build junk and .git', async () => {
    const base = await snapshotTree(dir);
    await put('src/a.ts', 'changed');
    await put('src/new.ts', 'n');
    await unlink(join(dir, 'src/b.ts'));
    await put('.git/hooks/pre-commit', 'evil');
    await put('src/__pycache__/x.pyc', 'junk');
    await put('node_modules/p/index.js', 'junk');
    const changes = await computeChanges(base, dir);
    expect(changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual(['added:src/new.ts', 'deleted:src/b.ts', 'modified:src/a.ts']);
    expect(changes.find((c) => c.path === 'src/new.ts')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('diff outside allowedPaths rejected at completion', async () => {
    const base = await snapshotTree(dir);
    await put('src/a.ts', 'ok');
    await put('contract/runtime.md', 'tampered');
    await put('../outside-note.txt', 'x').catch(() => undefined);
    const changes = await computeChanges(base, dir);
    const res = checkAllowedPaths(changes, ['src']);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.path)).toEqual(['contract/runtime.md']);
    expect(checkAllowedPaths(changes, ['src', 'contract/runtime.md']).ok).toBe(true);
    expect(checkAllowedPaths(changes, ['src/', 'contract']).ok).toBe(true);
  });

  it('empty allowedPaths allows no change at all; no change is fine', async () => {
    const base = await snapshotTree(dir);
    expect(checkAllowedPaths(await computeChanges(base, dir), []).ok).toBe(true);
    await put('src/a.ts', 'changed');
    expect(checkAllowedPaths(await computeChanges(base, dir), []).ok).toBe(false);
  });

  it('prefix matching is by path segment: src does not allow srcx or src-evil', async () => {
    const base = await snapshotTree(dir);
    await put('srcx/a.ts', '1');
    await put('src-evil/a.ts', '1');
    expect(checkAllowedPaths(await computeChanges(base, dir), ['src']).violations.length).toBe(2);
  });

  it('a symlink that escapes the workspace, or a special file, is a violation even inside an allowed path; links are not followed', async () => {
    const base = await snapshotTree(dir);
    await symlink('/etc/passwd', join(dir, 'src/passwd'));
    await symlink('../../../../etc/hosts', join(dir, 'src/up'));
    await symlink('b.ts', join(dir, 'src/ok-link'));
    const changes = await computeChanges(base, dir);
    const res = checkAllowedPaths(changes, ['src']);
    expect(res.violations.map((v) => v.path).sort()).toEqual(['src/passwd', 'src/up']);
    expect(res.violations.every((v) => v.reason === 'symlink_escape')).toBe(true);
  });

  it('refuses allowedPaths entries that traverse or are absolute', () => {
    expect(() => checkAllowedPaths([], ['../x'])).toThrow();
    expect(() => checkAllowedPaths([], ['/etc'])).toThrow();
    expect(() => checkAllowedPaths([], ['a/../b'])).toThrow();
  });
});
