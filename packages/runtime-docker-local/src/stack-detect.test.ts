import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StackDetectionReportSchema } from '@selarikru/protocol';
import { readStackDetection } from './stack-detect.ts';

let root: string;
let repo: string;
let sha: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
async function put(rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(join(repo, rel), body);
}
/** Every file under a directory, recursively, so a marker written anywhere is found. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const MARK = 'PWNED';
const evil = (where: string) => `node -e "require('fs').writeFileSync('${where}','x')"`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stack-detect-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const markAt = join(root, MARK);
  // A hostile manifest: every lifecycle script would write a marker if anything ran it.
  await put('package.json', JSON.stringify({
    name: 'fixture', packageManager: 'pnpm@9.12.2',
    scripts: { preinstall: evil(markAt), postinstall: evil(markAt), prepare: evil(markAt), build: `vite build && ${evil(markAt)}`, test: 'vitest run' },
    dependencies: { react: '19.3.1', stripe: '17.0.0' }, devDependencies: { vite: '8.3.6', vitest: '5.1.0' },
  }));
  await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  await put('services/api/requirements.txt', 'fastapi==0.115.0\n');
  await put('node_modules/next/package.json', JSON.stringify({ dependencies: { next: '1' } }));
  // Outside the repository: a manifest a symlink inside it points at. Following the link would detect Next.js.
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
  await mkdir(join(repo, 'apps', 'web'), { recursive: true });
  await symlink('../../../outside/package.json', join(repo, 'apps/web/package.json'));
  await symlink('/etc', join(repo, 'etc-link'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  sha = git('rev-parse', 'HEAD');
  // A hook that would fire on checkout, and a working-tree change after the commit: neither may matter.
  await writeFile(join(repo, '.git/hooks/post-checkout'), `#!/bin/sh\n${evil(markAt)}\n`);
  await chmod(join(repo, '.git/hooks/post-checkout'), 0o755);
  await put('services/api/requirements.txt', 'django==5\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('static stack detection from git objects', () => {
  it('reads manifests at the commit as data: entries with evidence, build and test proposals, and nothing runs', async () => {
    const r = await readStackDetection(repo, sha);
    expect(r.commit).toBe(sha);
    const ids = r.items.map((i) => `${i.componentPath}:${i.entryId}`);
    expect(ids).toEqual(expect.arrayContaining(['.:react', '.:stripe', '.:vite', '.:vitest', '.:pnpm', 'services/api:fastapi']));
    expect(r.items.find((i) => i.entryId === 'react')).toMatchObject({ version: '19.3.1', evidence: { path: 'package.json', detail: 'dependencies.react 19.3.1' } });
    // The commit is read, not the working tree.
    expect(ids).not.toContain('services/api:django');
    expect(r.commands.map((c) => `${c.kind}:${c.command}`)).toEqual(['build:pnpm run build', 'test:pnpm run test']);
    expect(r.commands[0]!.body).toContain('vite build');
    // No script, hook or package manager ran.
    expect((await walk(root)).filter((p) => p.endsWith(MARK))).toEqual([]);
  });

  it('never follows a symlink, in or out of the repository, and never reads a vendored tree', async () => {
    const r = await readStackDetection(repo, sha);
    expect(r.items.find((i) => i.entryId === 'nextjs')).toBeUndefined();
    expect(r.items.some((i) => i.componentPath === 'apps/web')).toBe(false);
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: 'apps/web/package.json', reason: 'symlink' }]));
    expect(JSON.stringify(r)).not.toContain('node_modules');
    expect(JSON.stringify(r)).not.toContain('etc-link');
  });

  it('a file name with control or bidi characters never spoils the report: the rest is still sent and passes the server schema', async () => {
    await put('apps/we\u0001b/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    await put('apps/\u202ex/package.json', JSON.stringify({ dependencies: { vue: '3' } }));
    await symlink('../package.json', join(repo, 'odd\u001b[31m-package.json'));
    await mkdir(join(repo, 'lnk\u0007'), { recursive: true });
    await symlink('../package.json', join(repo, 'lnk\u0007/package.json'));
    git('add', '-A');
    git('commit', '-q', '-m', 'odd names');
    const r = await readStackDetection(repo, git('rev-parse', 'HEAD'));
    expect(StackDetectionReportSchema.safeParse(r).success).toBe(true);
    expect(r.items.map((i) => i.entryId)).toEqual(expect.arrayContaining(['react', 'stripe']));
    expect(r.items.some((i) => i.entryId === 'nextjs' || i.entryId === 'vue')).toBe(false);
  });

  it('refuses a base that is not a full commit id', async () => {
    await expect(readStackDetection(repo, 'HEAD')).rejects.toThrow(/full commit/);
  });
});
