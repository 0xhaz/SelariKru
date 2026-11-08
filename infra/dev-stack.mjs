// Local development stack: Postgres (compose), migrations, Firebase Auth Emulator, control API.
// Run with `pnpm dev:stack`. Values come from the environment or a local, git-ignored `.env`.
// The limit values filled in below apply to this local stack only. The API itself has no defaults.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = { ...process.env };
const demo = env.SELARIKRU_DEMO === '1'; // set by dev-demo.mjs
const need = ['SELARIKRU_OWNER_UID'];
const missing = need.filter((n) => !env[n]);
if (missing.length > 0) {
  console.error(`dev:stack needs ${missing.join(', ')} (the Firebase Auth Emulator UID of the owner account). Set it in .env.`);
  process.exit(1);
}

const authPort = env.SELARIKRU_AUTH_EMULATOR_PORT ?? '9099';
const dev = {
  DATABASE_URL: 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test',
  FIREBASE_PROJECT_ID: 'selarikru',
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  SELARIKRU_MODE: 'local',
  SELARIKRU_API_HOST: '127.0.0.1',
  SELARIKRU_TENANT_ID: 'tenant_local',
  SELARIKRU_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  // From policies/default.json: 2 concurrent, 1800 s attempt timeout.
  SELARIKRU_MAX_CONCURRENT_TOTAL: '2',
  SELARIKRU_ATTEMPT_TIMEOUT_SECONDS: '1800',
  // Local-only values for infrastructure retries.
  SELARIKRU_MAX_INFRA_RETRIES: '3',
  SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS: '10',
  SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS: '60',
  SELARIKRU_PAIRING_CODE_TTL_SECONDS: '600',
  SELARIKRU_EXPIRE_LEASES_INTERVAL_MS: '5000',
};
for (const [k, v] of Object.entries(dev)) env[k] ??= v;

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};

console.log('> starting Postgres');
run('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', '--wait']);
console.log('> running migrations');
run('pnpm', ['--filter', '@selarikru/control-api', 'migrate']);

const dir = mkdtempSync(join(tmpdir(), 'selarikru-dev-auth-'));
writeFileSync(
  join(dir, 'firebase.json'),
  JSON.stringify({ emulators: { auth: { host: '127.0.0.1', port: Number(authPort) }, ui: { enabled: false } } }),
);
console.log(`> starting Firebase Auth Emulator on 127.0.0.1:${authPort}`);
const children = [
  spawn('firebase', ['emulators:start', '--only', 'auth', '--project', env.FIREBASE_PROJECT_ID], { cwd: dir, stdio: 'inherit', env, detached: true }),
];

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${authPort}/`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 300));
}

if (demo) {
  console.log('> seeding demo account, project and run');
  run('pnpm', ['--filter', '@selarikru/control-api', 'exec', 'tsx', 'src/demo-seed.ts']);
}

console.log('> starting control API');
children.push(spawn('pnpm', ['--filter', '@selarikru/control-api', 'start'], { stdio: 'inherit', env }));
if (demo) {
  console.log('> starting web dev server');
  // Own process group: pnpm and vite spawn helpers that a plain kill would leave behind.
  children.push(spawn('pnpm', ['--filter', '@selarikru/control-web', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { stdio: 'inherit', env, detached: true }));
  console.log(env.SELARIKRU_DEMO_BANNER ?? '');
}

const stop = () => {
  // The emulator runs in its own process group (the CLI spawns helpers); the API is a plain child.
  for (const [c, group] of [[children[0], true], [children[1], false], [children[2], true]]) {
    if (!c) continue;
    try {
      process.kill(group ? -c.pid : c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children[1].on('exit', stop);
