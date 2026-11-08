import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskBundle, BundleError, isExcludedPath, REQUIRED_CONTRACT_PATH } from './bundle.ts';

let root: string;
let repo: string;
let sha: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

async function put(rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(join(repo, rel), body);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bundle-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await put('src/app.ts', 'export const a = 1;\n');
  await put('contract/runtime.md', '# runtime contract\n');
  await put('tools/verifier-calibration/mutants/mutants.json', '{"secret":true}');
  await put('Tools/Verifier-Calibration/x.ts', 'case variant');
  await put('packages/y/verifier-calibration/z.ts', 'nested');
  await put('docs/readme.md', 'docs');
  await symlink('../src/app.ts', join(repo, 'src/link.ts'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  sha = git('rev-parse', 'HEAD');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const walk = async (dir: string, base = dir): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
};

describe('task input bundle', () => {
  it('source at the pinned SHA, without tools/verifier-calibration anywhere, with contract/runtime.md', async () => {
    const dest = join(root, 'w');
    const b = await buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: dest, taskFiles: { 'TASK.md': '# task\n' } });
    const files = await walk(dest);
    expect(files).toContain(REQUIRED_CONTRACT_PATH);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('TASK.md');
    expect(files.filter((f) => /verifier-calibration/i.test(f))).toEqual([]);
    expect(b.excluded.length).toBe(3);
    expect(await readFile(join(dest, REQUIRED_CONTRACT_PATH), 'utf8')).toBe('# runtime contract\n');
    // History is not shipped: the calibration directory must not be recoverable from the workspace's git objects either.
    const log = execFileSync('git', ['-C', dest, 'log', '--all', '--name-only', '--format='], { encoding: 'utf8' });
    expect(log).not.toMatch(/verifier-calibration/i);
    expect((await lstat(join(dest, 'src/link.ts'))).isSymbolicLink()).toBe(true);
  });

  it('task files cannot smuggle verifier-calibration in, and cannot replace source files', async () => {
    await expect(
      buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: join(root, 'w1'), taskFiles: { 'tools/verifier-calibration/a.ts': 'x' } }),
    ).rejects.toBeInstanceOf(BundleError);
    await expect(
      buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: join(root, 'w2'), taskFiles: { 'src/app.ts': 'overwritten' } }),
    ).rejects.toBeInstanceOf(BundleError);
    for (const bad of ['../escape.md', '/abs.md', 'a/../../b.md', '.git/config'])
      await expect(buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: join(root, 'w3'), taskFiles: { [bad]: 'x' } })).rejects.toBeInstanceOf(BundleError);
  });

  it('contract/runtime.md is always included, even if the caller tries to exclude it, and a bundle without it is refused', async () => {
    const dest = join(root, 'w');
    await buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: dest, extraExclude: ['contract', 'contract/runtime.md', 'docs'] });
    const files = await walk(dest);
    expect(files).toContain(REQUIRED_CONTRACT_PATH);
    expect(files).not.toContain('docs/readme.md');

    git('rm', '-q', REQUIRED_CONTRACT_PATH);
    git('commit', '-q', '-m', 'drop contract');
    const noContract = git('rev-parse', 'HEAD');
    await expect(buildTaskBundle({ repoPath: repo, baseSha: noContract, destDir: join(root, 'w4') })).rejects.toThrow(/contract\/runtime\.md/);
    // ...unless the task supplies it, so the workspace always has one.
    await buildTaskBundle({ repoPath: repo, baseSha: noContract, destDir: join(root, 'w5'), taskFiles: { [REQUIRED_CONTRACT_PATH]: '# from task\n' } });
    expect(await readFile(join(root, 'w5', REQUIRED_CONTRACT_PATH), 'utf8')).toBe('# from task\n');
  });

  it('rejects a base that is not a full commit id or is not in the repository', async () => {
    for (const bad of ['HEAD', 'main', sha.slice(0, 7), '--upload-pack=x', 'abc'])
      await expect(buildTaskBundle({ repoPath: repo, baseSha: bad, destDir: join(root, 'wx') })).rejects.toBeInstanceOf(BundleError);
    await expect(buildTaskBundle({ repoPath: repo, baseSha: 'f'.repeat(40), destDir: join(root, 'wy') })).rejects.toBeInstanceOf(BundleError);
  });

  it('refuses a destination that already has content', async () => {
    const dest = join(root, 'w');
    await mkdir(dest);
    await writeFile(join(dest, 'old'), 'x');
    await expect(buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: dest })).rejects.toBeInstanceOf(BundleError);
  });
});

describe('git isolation while building', () => {
  it('ignores the user and system git config and templates: no hook from them lands in or runs for the workspace', async () => {
    const tpl = join(root, 'tpl');
    await mkdir(join(tpl, 'hooks'), { recursive: true });
    const marker = join(root, 'HOOK-RAN');
    await writeFile(join(tpl, 'hooks', 'post-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const gcfg = join(root, 'gitconfig');
    await writeFile(gcfg, `[init]\n\ttemplateDir = ${tpl}\n[core]\n\thooksPath = ${join(tpl, 'hooks')}\n`);
    const saved = { g: process.env['GIT_CONFIG_GLOBAL'], s: process.env['GIT_CONFIG_NOSYSTEM'] };
    process.env['GIT_CONFIG_GLOBAL'] = gcfg;
    try {
      const dest = join(root, 'w');
      await buildTaskBundle({ repoPath: repo, baseSha: sha, destDir: dest });
      expect((await readdir(join(dest, '.git', 'hooks')).catch(() => [] as string[])).filter((n) => !n.endsWith('.sample'))).toEqual([]);
      await expect(lstat(marker)).rejects.toThrow();
    } finally {
      if (saved.g === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = saved.g;
    }
  });
});

describe('isExcludedPath', () => {
  it('matches the calibration directory in any case and at any depth', () => {
    for (const p of ['tools/verifier-calibration/a', 'Tools/Verifier-Calibration', 'a/b/verifier-calibration/c.ts', 'verifier-calibration'])
      expect(isExcludedPath(p), p).toBe(true);
    for (const p of ['tools/other/a', 'src/verifier.ts', 'contract/runtime.md', '.git/config', 'a/.git/hooks/x'])
      expect(isExcludedPath(p) , p).toBe(p.includes('.git'));
  });
});
