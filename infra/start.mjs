// One command for the whole local app: `pnpm start`.
//   1. Checks this machine: Node 24, pnpm, Docker, the Firebase CLI, the two env files, installed dependencies and a paired runner.
//   2. Starts the stack (Postgres, migrations, the Firebase Auth Emulator, the control API): dev-real.mjs when SELARIKRU_SOURCE_REPO is set, else dev-stack.mjs.
//   3. Starts the web app on http://127.0.0.1:5173 and the local runner, then opens the browser.
// Ctrl+C stops everything it started. `pnpm start --check` runs step 1 only.
//
// Optional settings, in the environment or the git-ignored .env:
//   SELARIKRU_RUNNER_REPOS   project=path pairs for the runner, comma-separated (proj_a=/abs/path,proj_b=/abs/path). The runner also reads its own config.json.
//   SELARIKRU_RUNNER_SLOTS   how many tasks the runner works on at once (default 2)
//   SELARIKRU_BROWSER        the browser app to open (macOS default: Google Chrome when installed, for Gemini Nano)
//   SELARIKRU_NO_OPEN=1      do not open a browser
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(ROOT);
if (existsSync('.env')) process.loadEnvFile('.env');

const CHECK_ONLY = process.argv.includes('--check');
const WEB_URL = 'http://127.0.0.1:5173';
const API_PORT = Number(process.env.SELARIKRU_API_PORT ?? 8787);
const AUTH_PORT = Number(process.env.SELARIKRU_AUTH_EMULATOR_PORT ?? 9099);
const RUNNER_HOME = process.env.SELARIKRU_RUNNER_HOME ?? join(homedir(), '.selarikru', 'runner');

const say = (msg) => console.log(`[selarikru] ${msg}`);
const ok = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', shell: platform() === 'win32' }).status === 0;
const out = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: platform() === 'win32' }).stdout?.trim() ?? '';
const envFileHas = (file, name) => existsSync(file) && new RegExp(`^${name}=\\S`, 'm').test(readFileSync(file, 'utf8'));
const portInUse = (port) =>
  new Promise((done) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });

// 1. Preflight. Every problem is listed with its fix; nothing starts until all pass.
const problems = [];
const check = (pass, what, fix) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${what}`);
  if (!pass) problems.push(fix);
};
console.log('[selarikru] checking this machine');
const nodeMajor = Number(process.versions.node.split('.')[0]);
check(nodeMajor === 24, `Node 24 (found ${process.versions.node})`, 'Install Node 24 and use it in this terminal (for example `nvm use 24`).');
const pnpmVersion = out('pnpm', ['--version']);
check(/^9\./.test(pnpmVersion), `pnpm 9 (found ${pnpmVersion || 'none'})`, 'Install pnpm 9: `corepack enable && corepack prepare pnpm@9.12.2 --activate`.');
check(ok('docker', ['info']), 'Docker is running', 'Start Docker Desktop (Postgres runs in a container).');
check(ok('firebase', ['--version']), 'Firebase CLI', 'Install the Firebase CLI: `npm install -g firebase-tools` (it runs the local Auth Emulator).');
check(existsSync('node_modules'), 'dependencies installed', 'Run `pnpm install` in this folder.');
check(Boolean(process.env.SELARIKRU_OWNER_UID), '.env has SELARIKRU_OWNER_UID', 'Copy .env.example to .env and fill in the values it lists.');
// Without the Firebase web config the app still starts (a dev placeholder stands in); only the AI calls need it.
const firebaseConfigured = envFileHas('apps/control-web/.env.local', 'VITE_FIREBASE_API_KEY');
console.log(`  ${firebaseConfigured ? 'ok  ' : 'note'} apps/control-web/.env.local has the Firebase web config${firebaseConfigured ? '' : ': not yet. SelariKru starts, but the AI calls need it. TESTING.md › "Your own Firebase project" shows how.'}`);
if (firebaseConfigured && !envFileHas('apps/control-web/.env.local', 'VITE_RECAPTCHA_SITE_KEY')) console.log('  note apps/control-web/.env.local has no VITE_RECAPTCHA_SITE_KEY: App Check is off, so cloud AI calls fail while your project enforces it (calls on this device still work).');
const source = process.env.SELARIKRU_SOURCE_REPO;
if (source) check(isAbsolute(source) && existsSync(join(source, '.git')), 'SELARIKRU_SOURCE_REPO is a git checkout', 'Set SELARIKRU_SOURCE_REPO in .env to the absolute path of the project checkout to build, or remove it.');
let paired = existsSync(join(RUNNER_HOME, 'credentials.json'));
// With a source repository, dev-real seeds the owner's Auth Emulator account, so an unpaired runner is paired automatically once the API is up.
const autoPair = !paired && Boolean(source);
console.log(`  ${paired ? 'ok  ' : 'note'} local runner paired${paired ? '' : autoPair ? ': not yet. It will be paired with this stack once the API is up.' : ': not yet. The app runs without it; set SELARIKRU_SOURCE_REPO to have it paired automatically (see TESTING.md).'}`);
const busy = [];
for (const [port, name] of [[5173, 'web app'], [API_PORT, 'control API'], [AUTH_PORT, 'Auth Emulator']]) if (await portInUse(port)) busy.push(`${port} (${name})`);
check(busy.length === 0, 'ports 5173, 8787 and 9099 are free', `Something is already using ${busy.join(', ')}. Stop it (an earlier SelariKru in another terminal?) and try again.`);

if (problems.length > 0) {
  console.error('\n[selarikru] fix these first:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (CHECK_ONLY) {
  say('all checks passed. Run `pnpm start` to launch.');
  process.exit(0);
}

// 2-3. Start. Each child gets its own process group (pnpm, vite and the emulator spawn helpers), so Ctrl+C can stop the whole tree.
const children = [];
const start = (label, cmd, args) => {
  say(`starting ${label}`);
  const c = spawn(cmd, args, { stdio: 'inherit', env: process.env, detached: platform() !== 'win32', shell: platform() === 'win32' });
  children.push({ label, c });
  c.on('exit', (code) => {
    if (!stopping) {
      say(`${label} stopped${code ? ` (exit ${code})` : ''}; shutting down`);
      stop(code || 1);
    }
  });
  return c;
};
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const { c } of [...children].reverse()) {
    try {
      if (platform() === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const waitForPort = async (port, label, seconds) => {
  for (let i = 0; i < seconds * 2; i++) {
    if (stopping) return false;
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  say(`${label} did not come up on port ${port} within ${seconds} s; shutting down`);
  stop(1);
  return false;
};

start('the stack (Postgres, Auth Emulator, control API)', process.execPath, [source ? 'infra/dev-real.mjs' : 'infra/dev-stack.mjs']);
if (!(await waitForPort(API_PORT, 'The control API', 180))) process.exit(1);

start('the web app', 'pnpm', ['--filter', '@selarikru/control-web', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
if (!(await waitForPort(5173, 'The web app', 60))) process.exit(1);

// First start: pair the runner with this local stack. Loopback only: the owner signs in to the Auth Emulator (the seeded account's emulator-only
// password), asks the API for a one-time pairing code, and the runner enrols with it. The code is never printed.
const pairRunner = async () => {
  const email = process.env.SELARIKRU_REAL_OWNER_EMAIL?.trim() || 'owner@selarikru.invalid';
  const password = process.env.SELARIKRU_REAL_OWNER_PASSWORD?.trim() || 'real-run-local-only-password';
  try {
    const signIn = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-emulator`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const { idToken } = await signIn.json();
    if (!signIn.ok || !idToken) throw new Error(`the emulator sign-in failed (HTTP ${signIn.status})`);
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/runners/pairing-codes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` }, body: JSON.stringify({ location: 'local' }),
    });
    const { pairingCode } = await res.json();
    if (!res.ok || !pairingCode) throw new Error(`the API refused a pairing code (HTTP ${res.status})`);
    const r = spawnSync('pnpm', ['--filter', '@selarikru/local-runner', 'exec', 'tsx', 'src/main.ts', 'pair', '--api', `http://127.0.0.1:${API_PORT}`, '--code', pairingCode, '--label', 'this computer'], { stdio: 'inherit', env: process.env, shell: platform() === 'win32' });
    if (r.status !== 0) throw new Error('the runner could not enrol');
    return true;
  } catch (e) {
    say(`could not pair the runner (${e instanceof Error ? e.message : String(e)}). The app runs without it; see TESTING.md to pair it by hand.`);
    return false;
  }
};
if (autoPair) {
  say('pairing the local runner with this stack');
  paired = await pairRunner();
}

if (paired) {
  const repos = (process.env.SELARIKRU_RUNNER_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((r) => ['--repo', r]);
  start('the local runner', 'pnpm', ['--filter', '@selarikru/local-runner', 'exec', 'tsx', 'src/main.ts', 'run', '--slots', process.env.SELARIKRU_RUNNER_SLOTS ?? '2', ...repos]);
}

if (process.env.SELARIKRU_NO_OPEN !== '1') {
  const os = platform();
  const chrome = process.env.SELARIKRU_BROWSER ?? (os === 'darwin' && existsSync('/Applications/Google Chrome.app') ? 'Google Chrome' : '');
  if (os === 'darwin') spawn('open', chrome ? ['-a', chrome, WEB_URL] : [WEB_URL], { stdio: 'ignore' });
  else if (os === 'win32') spawn('cmd', ['/c', 'start', '', WEB_URL], { stdio: 'ignore' });
  else spawn('xdg-open', [WEB_URL], { stdio: 'ignore' });
}
say(`SelariKru is running at ${WEB_URL}. Press Ctrl+C to stop everything.`);
