// Applies the private calibration overlay to a fresh temp copy of the starter and runs the protected verifier on it.
//   pnpm --filter @selarikru/verifier-calibration calibrate -- [--docker] [--results <path>]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const starter = join(root, 'examples/feedback-board-starter');
const overlay = join(here, 'feedback-board-solution/overlay');
const args = process.argv.slice(2);
const docker = args.includes('--docker');
const ri = args.indexOf('--results');
const results = resolve(ri >= 0 && args[ri + 1] ? args[ri + 1]! : join(tmpdir(), 'selarikru-calibration-results.json'));

const tmp = mkdtempSync(join(tmpdir(), 'selarikru-calibration-'));
const candidate = join(tmp, 'candidate');
try {
  cpSync(starter, candidate, { recursive: true, filter: (p) => !['node_modules', 'dist'].includes(basename(p)) && !/\.sqlite/.test(p) });
  cpSync(overlay, candidate, { recursive: true });
  const cmd = docker ? join(root, 'services/verifier/scripts/docker-verify.sh') : 'pnpm';
  const argv = docker ? [candidate, results] : ['--filter', '@selarikru/verifier', 'verify'];
  const r = spawnSync(cmd, argv, { stdio: 'inherit', env: { ...process.env, CANDIDATE_DIR: candidate, RESULTS_PATH: results } });
  console.log(`results: ${results}`);
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
