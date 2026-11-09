import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAllowedPaths, computeChanges, readRegularFile, snapshotTree, validateAllowedPaths } from './diff.ts';

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

  it('every added or modified symlink is a violation, however harmless it looks; the two-hop escape no longer slips through', async () => {
    const base = await snapshotTree(dir);
    await symlink('/etc/passwd', join(dir, 'src/passwd'));
    await symlink('b.ts', join(dir, 'src/ok-link'));
    await symlink('..', join(dir, 'src/d'));
    await symlink('d/../canary', join(dir, 'src/x'));
    const res = checkAllowedPaths(await computeChanges(base, dir), ['src']);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.path).sort()).toEqual(['src/d', 'src/ok-link', 'src/passwd', 'src/x']);
    expect(res.violations.every((v) => v.reason === 'symlink')).toBe(true);
  });

  it('a file replaced by a symlink is a modified symlink and is rejected', async () => {
    const base = await snapshotTree(dir);
    await unlink(join(dir, 'src/a.ts'));
    await symlink('/etc/hosts', join(dir, 'src/a.ts'));
    expect(checkAllowedPaths(await computeChanges(base, dir), ['src']).violations.map((v) => v.reason)).toEqual(['symlink']);
  });

  it('readRegularFile never follows a symlink and only reads regular files', async () => {
    await symlink('/etc/hosts', join(dir, 'src/l'));
    await expect(readRegularFile(join(dir, 'src/l'))).rejects.toThrow();
    await expect(readRegularFile(join(dir, 'src'))).rejects.toThrow();
    expect((await readRegularFile(join(dir, 'src/a.ts'))).toString()).toBe('a');
  });

  it('a .git segment in any case is a violation, never silently ignored; the real .git is still ignored', async () => {
    const base = await snapshotTree(dir);
    await put('src/.GIT/config', 'x');
    await put('.Git/hooks/p', 'x');
    await put('.git/hooks/p', 'x');
    const res = checkAllowedPaths(await computeChanges(base, dir), ['src']);
    expect(res.violations.map((v) => v.path).sort()).toEqual(['.Git', 'src/.GIT']);
    expect(res.violations.every((v) => v.reason === 'forbidden_path')).toBe(true);
  });

  it('validateAllowedPaths accepts plain prefixes and rejects absolute, parent, glob, empty, backslash and .git entries', () => {
    expect(validateAllowedPaths(['src', 'docs/a.md', './lib/', 'fixtures/feedback-board'])).toEqual({ ok: true, normalized: ['src', 'docs/a.md', 'lib', 'fixtures/feedback-board'] });
    for (const bad of ['/abs', '../x', 'a/../b', 'src/**', '*.ts', 'a?b', 'a[1]', 'a{b,c}', '', '.', 'a\\b', '.git', 'x/.GIT/y', 'a//b'])
      expect(validateAllowedPaths([bad]).ok, bad).toBe(false);
  });

  it('refuses allowedPaths entries that traverse or are absolute', () => {
    expect(() => checkAllowedPaths([], ['../x'])).toThrow();
    expect(() => checkAllowedPaths([], ['/etc'])).toThrow();
    expect(() => checkAllowedPaths([], ['a/../b'])).toThrow();
  });

  it("applies the Feedback Board shell's own .gitignore: pnpm's store and build output are ignored, real code under a nested dist/ is not", async () => {
    const shellIgnore = await readFile(fileURLToPath(new URL('../../../examples/feedback-board-starter/.gitignore', import.meta.url)));
    await put('.gitignore', shellIgnore.toString());
    const base = await snapshotTree(dir);
    await put('.pnpm-store/v10/files/00/abc', 'store');
    await put('node_modules/p/index.js', 'junk');
    await put('dist/index.html', 'built');
    await put('server/dist/real.ts', 'real code');
    const changes = await computeChanges(base, dir, new Map([['.gitignore', shellIgnore]]));
    expect(changes.map((c) => c.path)).toEqual(['server/dist/real.ts']);
    expect(checkAllowedPaths(changes, ['src']).violations.map((v) => v.reason)).toEqual(['outside_allowed_paths']);
  });
});
