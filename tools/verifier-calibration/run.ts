// Private verifier calibration runner. Never provide to workers.
//   pnpm --filter @selarikru/verifier-calibration calibrate [--docker] [--results <path>]   solution must pass 8/8
//   pnpm --filter @selarikru/verifier-calibration calibrate:docker -- --mutants               each mutant must fail its listed FB-IDs
//   pnpm --filter @selarikru/verifier-calibration calibrate:docker -- --tamper                hostile build must not pass
//   pnpm --filter @selarikru/verifier-calibration calibrate:docker -- --starter               bare starter must fail 8/8
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const starter = join(root, 'examples/feedback-board-starter');
const overlay = join(here, 'feedback-board-solution/overlay');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const docker = flag('--docker');
const ri = args.indexOf('--results');
const resultsBase = resolve(ri >= 0 && args[ri + 1] ? args[ri + 1]! : join(tmpdir(), 'selarikru-calibration-results.json'));

interface Patch { file: string; find: string; replace: string }
interface Run { name: string; useOverlay: boolean; extra?: (dir: string) => void; patches?: Patch[]; showSetup?: boolean }

function verify(run: Run): any {
  const tmp = mkdtempSync(join(tmpdir(), 'selarikru-calibration-'));
  const candidate = join(tmp, 'candidate');
  const results = resultsBase.replace(/\.json$/, `.${run.name}.json`);
  try {
    cpSync(starter, candidate, { recursive: true, filter: (p) => !['node_modules', 'dist'].includes(basename(p)) && !/\.sqlite/.test(p) });
    if (run.useOverlay) cpSync(overlay, candidate, { recursive: true });
    for (const p of run.patches ?? []) {
      const f = join(candidate, p.file);
      const text = readFileSync(f, 'utf8');
      if (!text.includes(p.find)) throw new Error(`patch for ${p.file} does not apply (${run.name})`);
      writeFileSync(f, text.replace(p.find, () => p.replace));
    }
    run.extra?.(candidate);
    const cmd = docker ? join(root, 'services/verifier/scripts/docker-verify.sh') : 'pnpm';
    const argv = docker ? [candidate, results] : ['--filter', '@selarikru/verifier', 'verify'];
    const env = { ...process.env, CANDIDATE_DIR: candidate, RESULTS_PATH: results, ...(run.showSetup ? { VERIFY_SHOW_SETUP: '1' } : {}) };
    spawnSync(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'], env });
    return JSON.parse(readFileSync(results, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const statuses = (r: any): Record<string, string> => Object.fromEntries(r.quality.criteria.map((c: any) => [c.id, c.status]));
const show = (label: string, r: any) => console.log(`${label}: ${Object.entries(statuses(r)).map(([k, v]) => `${k} ${v}`).join(', ')}`);
let ok = true;
const check = (cond: boolean, msg: string) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

if (flag('--mutants') || flag('--tamper')) if (!docker) throw new Error('--mutants and --tamper need --docker (survivor processes and file tampering are only contained in the image)');

if (flag('--starter')) {
  const r = verify({ name: 'starter', useOverlay: false });
  show('starter', r);
  check(Object.values(statuses(r)).every((s) => s === 'failed'), 'every FB-ID fails on the bare starter');
} else if (flag('--preflight')) {
  // Deliberately re-open /ms-playwright (as the base image ships it) and expect the runner to refuse a verdict.
  const tmp = mkdtempSync(join(tmpdir(), 'selarikru-preflight-'));
  try {
    cpSync(starter, join(tmp, 'c'), { recursive: true, filter: (p) => !['node_modules', 'dist'].includes(basename(p)) });
    const name = `selarikru-preflight-${process.pid}`;
    spawnSync('docker', ['run', '--name', name, '--security-opt', 'no-new-privileges', '--cap-drop=ALL', ...['CHOWN', 'SETUID', 'SETGID', 'KILL', 'DAC_OVERRIDE', 'FOWNER'].flatMap((c) => ['--cap-add', c]),
      '-v', `${join(tmp, 'c')}:/candidate:ro`, '-e', 'CANDIDATE_DIR=/candidate', '-e', 'RESULTS_PATH=/verifier-out/result.json', '--entrypoint', 'sh', 'selarikru-verifier:playwright-1.65.0',
      '-c', 'chmod 777 /ms-playwright && exec pnpm exec tsx src/run.ts'], { stdio: ['ignore', 'ignore', 'inherit'] });
    spawnSync('docker', ['cp', `${name}:/verifier-out/result.json`, join(tmp, 'r.json')], { stdio: 'ignore' });
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const r = JSON.parse(readFileSync(join(tmp, 'r.json'), 'utf8'));
    show('preflight', r);
    check(Object.values(statuses(r)).every((s) => s === 'error') && JSON.stringify(r).includes('isolation preflight failed'), 'a world-writable /ms-playwright makes the runner refuse a verdict');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else if (flag('--mutants')) {
  const mutants = JSON.parse(readFileSync(join(here, 'mutants/mutants.json'), 'utf8')) as Array<{ id: string; covers: string; mustFail: string[]; patches: Patch[] }>;
  for (const m of mutants) {
    const r = verify({ name: `mutant-${m.id}`, useOverlay: true, patches: m.patches });
    show(m.id, r);
    const st = statuses(r);
    check(r.quality.allRequiredChecksPassed === false && m.mustFail.every((id) => st[id] === 'failed'), `${m.id} is caught (${m.mustFail.join(', ')} failed): ${m.covers}`);
  }
} else if (flag('--tamper')) {
  // Both variants run a hostile build/start script on top of the calibration solution. Variant A would pass 8/8 if
  // tampering had no effect; variant B carries a known bug (NFC normalization) so that a forged pass would be visible.
  const mutants = JSON.parse(readFileSync(join(here, 'mutants/mutants.json'), 'utf8')) as Array<{ id: string; patches: Patch[] }>;
  const bug = mutants.find((m) => m.id === 'nfc-normalization')!;
  const hostile: Patch[] = [
    { file: 'package.json', find: '"build": "tsc --noEmit && vite build"', replace: '"build": "node tamper.mjs && tsc --noEmit && vite build"' },
    { file: 'package.json', find: '"start": "tsx server/index.ts"', replace: '"start": "node tamper.mjs --quiet && tsx server/index.ts"' },
  ];
  for (const variant of [
    { name: 'tamper-solution', patches: hostile, expect: { 'FB-01': 'passed', 'FB-02': 'passed' } as Record<string, string>, rest: 'passed' },
    { name: 'tamper-buggy', patches: [...bug.patches, ...hostile], expect: { 'FB-01': 'failed', 'FB-02': 'failed' } as Record<string, string>, rest: 'passed' },
  ]) {
    const r = verify({ name: variant.name, useOverlay: true, showSetup: true, extra: (dir) => cpSync(join(here, 'tamper/tamper.mjs'), join(dir, 'tamper.mjs')), patches: variant.patches });
    show(variant.name, r);
    const st = statuses(r);
    const detail: string = r.setup?.build?.detail ?? '';
    const denied = (detail.match(/TAMPER DENIED/g) ?? []).length;
    const planted = (detail.match(/TAMPER PLANTED (.*)/g) ?? []);
    check(denied >= 20, `${variant.name}: tamper attempts ran and were denied (${denied} DENIED lines)`);
    check(!detail.includes('TAMPER WROTE'), `${variant.name}: no write to a protected location succeeded`);
    check(planted.every((l) => l.includes('/tmp ')), `${variant.name}: only world-writable /tmp was writable (${planted.length} planted)`);
    const refused = Object.values(st).every((v) => v === 'error');
    const honest = Object.entries(st).every(([id, v]) => v === (variant.expect[id] ?? variant.rest));
    check(refused || honest, `${variant.name}: verdict is ${refused ? 'refused' : honest ? 'honest' : 'FORGED OR WRONG'}`);
  }
} else {
  const r = verify({ name: 'solution', useOverlay: true });
  show('calibration', r);
  check(r.quality.allRequiredChecksPassed === true, 'calibration solution passes 8/8');
}
process.exitCode = ok ? 0 : 1;
