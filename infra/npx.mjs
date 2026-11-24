#!/usr/bin/env node
// One line from any terminal: `npx github:0xhaz/SelariKru`. Node built-ins only, because npx runs this file before anything is installed.
//   1. Clones SelariKru into ./SelariKru, or reuses that folder, or the current folder when it is already a SelariKru checkout.
//   2. Runs `pnpm install`.
//   3. On the first run only, writes the two git-ignored env files: it asks for your Firebase web config (pasted as one block from the console), and
//      sets up a local Feedback Board project for the team to build (a git checkout under .local/, with GitHub off).
//   4. Hands over to `pnpm start` (infra/start.mjs), which checks the machine, starts everything and opens Chrome.
// Usage: npx github:0xhaz/SelariKru [folder] [--check]. --check is passed to pnpm start (checks only, nothing starts).
// SELARIKRU_CLONE_URL overrides the repository to clone (used to test this file against a local checkout).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const CLONE_URL = process.env.SELARIKRU_CLONE_URL ?? 'https://github.com/0xhaz/SelariKru.git';
const PROJECT_ID = 'proj_starter_local'; // not the real-run default (proj_real_local), so it never collides with a project an existing local stack already seeded
const RUN_ID = 'run_starter_local';
const OWNER_EMAIL = 'owner@selarikru.invalid';
const OWNER_PASSWORD = 'real-run-local-only-password'; // the real-run seed's default; Auth Emulator only, not a secret
const WIN = platform() === 'win32';

const say = (msg) => console.log(`[selarikru] ${msg}`);
const fail = (msg) => {
  console.error(`[selarikru] ${msg}`);
  process.exit(1);
};
const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', shell: WIN }).status === 0;
const runOrFail = (cmd, args, cwd) => {
  // stdin is closed so a child never reads what you type at the setup questions.
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: WIN });
  if (r.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` failed (exit ${r.status ?? 'signal'}).`);
};
const isSelariKru = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'selarikru';
  } catch {
    return false;
  }
};

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const folderArg = args.find((a) => !a.startsWith('--'));

// What this step needs. pnpm start checks the rest (Docker, the Firebase CLI, free ports).
if (Number(process.versions.node.split('.')[0]) !== 24) fail(`SelariKru needs Node 24 (found ${process.versions.node}). Switch to Node 24 (for example \`nvm use 24\`) and run this again.`);
if (!has('git', ['--version'])) fail('SelariKru needs git. Install it and run this again.');
if (!has('pnpm', ['--version'])) fail('SelariKru needs pnpm. Run `corepack enable`, then run this again.');

// 1. The checkout.
let root;
if (!folderArg && isSelariKru(process.cwd())) {
  root = process.cwd();
  say(`using this SelariKru checkout: ${root}`);
} else {
  root = resolve(process.cwd(), folderArg ?? 'SelariKru');
  if (existsSync(root)) {
    if (!isSelariKru(root)) fail(`${root} already exists and is not a SelariKru checkout. Pick another folder: npx github:0xhaz/SelariKru <folder>`);
    say(`using the existing checkout in ${root}`);
  } else {
    say(`cloning SelariKru into ${root}`);
    runOrFail('git', ['clone', CLONE_URL, root], process.cwd());
  }
}

// 2. Dependencies. Checked inside the checkout: a newer pnpm switches to the version package.json pins (packageManager).
const pnpmVersion = spawnSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', shell: WIN }).stdout?.trim() ?? '';
if (!/^9\./.test(pnpmVersion)) fail(`SelariKru needs pnpm 9 in its folder (found ${pnpmVersion || 'none'}). Run \`corepack enable && corepack prepare pnpm@9.12.2 --activate\`, then run this again.`);
say('installing dependencies (pnpm install)');
runOrFail('pnpm', ['install', '--frozen-lockfile'], root);

// 3. First-run setup. Existing env files are never changed.
const envFile = join(root, '.env');
const webEnvFile = join(root, 'apps', 'control-web', '.env.local');
const writePrivate = (file, lines) => {
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  if (!WIN) chmodSync(file, 0o600);
};

const FIREBASE_FIELDS = [
  ['apiKey', 'VITE_FIREBASE_API_KEY'],
  ['authDomain', 'VITE_FIREBASE_AUTH_DOMAIN'],
  ['projectId', 'VITE_FIREBASE_PROJECT_ID'],
  ['storageBucket', 'VITE_FIREBASE_STORAGE_BUCKET'],
  ['messagingSenderId', 'VITE_FIREBASE_MESSAGING_SENDER_ID'],
  ['appId', 'VITE_FIREBASE_APP_ID'],
];
/** Reads `key: "value"` pairs from the pasted firebaseConfig object. Values are never printed. */
function parseFirebaseConfig(text) {
  const found = {};
  for (const m of text.matchAll(/["']?(\w+)["']?\s*:\s*["']([^"'\s]+)["']/g)) found[m[1]] = m[2];
  const missing = FIREBASE_FIELDS.filter(([k]) => !found[k]).map(([k]) => k);
  return { values: Object.fromEntries(FIREBASE_FIELDS.filter(([k]) => found[k]).map(([k, name]) => [name, found[k]])), missing };
}

if (!existsSync(webEnvFile) || !existsSync(envFile)) {
  if (!process.stdin.isTTY) fail('First run: the env files are missing, and this terminal cannot ask for them. Copy .env.example to .env and apps/control-web/.env.example to apps/control-web/.env.local, fill them in (see TESTING.md), then run this again.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  // A buffered line iterator: a pasted block arrives as one chunk, and every line of it is kept until it is read.
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (prompt = '') => {
    if (prompt) process.stdout.write(prompt);
    const r = await lines.next();
    return r.done ? null : r.value;
  };
  console.log('\n[selarikru] First run: a little setup. What you enter is written only to git-ignored files on this machine.\n');

  if (!existsSync(webEnvFile)) {
    console.log('SelariKru calls Firebase AI Logic from your browser, so it needs your own Firebase web app.');
    console.log('In the Firebase console, open Project settings › General › Your apps, and copy the firebaseConfig object.');
    console.log('(Turn on AI Logic and App Check for that project first; TESTING.md shows how.)\n');
    let parsed;
    for (let attempt = 0; attempt < 2; attempt++) {
      console.log('Paste it here, then press Enter on an empty line:');
      const pasted = [];
      for (;;) {
        const line = await nextLine();
        if (line === null || (line.trim() === '' && pasted.length > 0)) break;
        if (line.trim() !== '') pasted.push(line);
      }
      parsed = parseFirebaseConfig(pasted.join('\n'));
      if (parsed.missing.length === 0) break;
      console.log(`That config is missing ${parsed.missing.join(', ')}. Copy the whole object and try again.\n`);
    }
    if (parsed.missing.length > 0) {
      rl.close();
      fail('No complete Firebase config. Fill in apps/control-web/.env.local by hand (see apps/control-web/.env.example), then run this again.');
    }
    console.log('\nYour App Check reCAPTCHA Enterprise site key (App Check › Apps in the Firebase console).');
    const siteKey = ((await nextLine('Site key, or Enter to skip (AI calls fail while App Check is enforced without it): ')) ?? '').trim();
    writePrivate(webEnvFile, [
      '# Written by npx github:0xhaz/SelariKru on first run. Git-ignored; never commit it.',
      ...Object.entries(parsed.values).map(([k, v]) => `${k}=${v}`),
      `VITE_RECAPTCHA_SITE_KEY=${siteKey}`,
      'VITE_API_BASE_URL=http://127.0.0.1:8787',
      'VITE_AUTH_EMULATOR_URL=http://127.0.0.1:9099',
      `VITE_DEFAULT_PROJECT_ID=${PROJECT_ID}`,
      `VITE_DEFAULT_RUN_ID=${RUN_ID}`,
    ]);
    say('wrote apps/control-web/.env.local');
  }
  rl.close();

  if (!existsSync(envFile)) {
    // The project the team builds: a fresh copy of the Feedback Board starter, as its own git repository with a main branch.
    const starter = join(root, '.local', 'starter', 'feedback-board');
    if (!existsSync(join(starter, '.git'))) {
      mkdirSync(starter, { recursive: true });
      cpSync(join(root, 'examples', 'feedback-board-starter'), starter, {
        recursive: true,
        filter: (src) => !/(^|[\\/])(node_modules|dist)$/.test(src) && !/\.sqlite(-wal|-shm)?$/.test(src),
      });
      const g = (...a) => runOrFail('git', ['-c', 'user.name=SelariKru', '-c', 'user.email=dev@selarikru.invalid', '-c', 'commit.gpgsign=false', ...a], starter);
      g('init', '-q', '-b', 'main');
      g('add', '-A');
      g('commit', '-q', '-m', 'Feedback Board starter');
    }
    writePrivate(envFile, [
      '# Written by npx github:0xhaz/SelariKru on first run. Git-ignored; never commit it. .env.example lists every setting.',
      '# The owner account lives only in the local Auth Emulator.',
      'SELARIKRU_OWNER_UID=local-owner',
      '# The project the team builds: a local Feedback Board checkout. GitHub is off, so verified changes stay local.',
      '# To get draft pull requests, point these at your own repository and set SELARIKRU_GITHUB_ENABLED=1 (see TESTING.md).',
      `SELARIKRU_SOURCE_REPO=${starter}`,
      'SELARIKRU_GITHUB_ENABLED=0',
      'SELARIKRU_REAL_REPOSITORY=local/feedback-board',
      'SELARIKRU_REAL_ALLOWED_PATHS=src,server',
      'SELARIKRU_REAL_BUDGET_LIMIT_USD=5',
      `SELARIKRU_REAL_PROJECT_ID=${PROJECT_ID}`,
      `SELARIKRU_REAL_RUN_ID=${RUN_ID}`,
      `SELARIKRU_RUNNER_REPOS=${PROJECT_ID}=${starter}`,
    ]);
    say('wrote .env, with a local Feedback Board project to build');
  }
}

if (!flags.includes('--check')) {
  console.log('');
  say(`sign in with ${OWNER_EMAIL} and password ${OWNER_PASSWORD} (Auth Emulator only, not a secret).`);
  console.log('');
}

// 4. Hand over to pnpm start. Ctrl+C reaches it directly; this process just waits for it.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, [join(root, 'infra', 'start.mjs'), ...flags], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
