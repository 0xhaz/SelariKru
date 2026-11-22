#!/usr/bin/env node
// Pre-deploy check for the hosted demo (apps/control-web/dist-hosted). Firebase runs it as the hosting predeploy step, after
// `build:hosted`, so a failed check stops `firebase deploy` before anything is uploaded. It never prints a key, only what is wrong.
//
//   node tools/deploy/check-hosted.mjs [dist-dir]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = resolve(process.argv[2] ?? join(ROOT, 'apps/control-web/dist-hosted'));

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`check-hosted: no build at ${relative(ROOT, DIST) || DIST}. Run: pnpm --filter @selarikru/control-web build:hosted`);
  process.exit(1);
}

const firebaseJson = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));
if (resolve(ROOT, firebaseJson.hosting.public) !== DIST) warn(`firebase.json serves ${firebaseJson.hosting.public}, not the folder checked here.`);

const files = walk(DIST);
const rel = (p) => relative(DIST, p);
const textFiles = files.filter((p) => /\.(html|js|css|json|txt|svg|webmanifest)$/.test(p));
const text = new Map(textFiles.map((p) => [p, readFileSync(p, 'utf8')]));

// 1. Only the demo page ships: no benchmark bench page, no test harness, no source maps.
for (const p of files) {
  const r = rel(p);
  if (/(^|\/)bench\.html$/.test(r)) fail(`the benchmark page is in the build (${r}). Unset VITE_BENCH_PAGE and rebuild.`);
  if (/harness/i.test(r)) fail(`a test harness file is in the build (${r}).`);
  if (r.endsWith('.map')) fail(`a source map is in the build (${r}); it would publish the source with local paths.`);
}

// 2. The page carries its CSP and is the hosted demo build.
const index = text.get(join(DIST, 'index.html')) ?? '';
if (!/<meta[^>]+http-equiv="Content-Security-Policy"/i.test(index)) fail('index.html has no Content-Security-Policy meta tag.');
if (!files.some((p) => /HostedRoot-[\w-]+\.js$/.test(p))) fail('no HostedRoot chunk: this is not the hosted demo build (use build:hosted).');

// 3. Nothing internal, local or third-party-branded.
const INTERNAL = [
  [/jsm[- ]?hq/i, 'a JSM HQ name (its trademark terms forbid it)'],
  [/workplan\.md|demo-script|plan\.md\b/i, 'a reference to an internal planning file'],
  [/\/(Users|Volumes|home)\/[\w.-]+\//, 'an absolute local file path'],
  [/hq-askwell/i, 'a local sandbox name'],
];
// 4. Secrets that must never ship. The Firebase web API key and the reCAPTCHA site key are public by design and are checked separately.
const SECRETS = [
  [/ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,}/, 'a GitHub token'],
  [/sk-ant-[0-9A-Za-z_-]{20,}/, 'an Anthropic API key'],
  [/BEGIN [A-Z ]*PRIVATE KEY/, 'a private key'],
  [/"type"\s*:\s*"service_account"/, 'a service account key'],
  // The SDK reads `self.FIREBASE_APPCHECK_DEBUG_TOKEN`; only an assignment (a token, or `true`, which mints one) is a leak.
  [/APPCHECK_DEBUG_TOKEN\s*=(?!=)\s*(["'`][0-9a-f-]{36}["'`]|!0\b|true\b)/i, 'an App Check debug token'],
];
for (const [p, body] of text) {
  for (const [re, what] of [...INTERNAL, ...SECRETS]) if (re.test(body)) fail(`${rel(p)} contains ${what}.`);
  if (/(127\.0\.0\.1|localhost):(8787|9099|5173)/.test(body)) warn(`${rel(p)} mentions a local dev address; check that it is copy, not a live endpoint.`);
}

// 5. The Firebase web API key: exactly one, and one that has never been committed. A key found anywhere in git history must be rotated.
const keys = new Set([...text.values()].flatMap((b) => b.match(/AIza[0-9A-Za-z_-]{35}/g) ?? []));
if (keys.size === 0) fail('no Firebase web API key in the build: VITE_FIREBASE_API_KEY was not set.');
if (keys.size > 1) fail(`${keys.size} different Firebase API keys in the build; expected one.`);
for (const key of keys) {
  let hits = '';
  try {
    hits = execFileSync('git', ['-C', ROOT, 'log', '--all', '--oneline', '-S', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    warn('could not search git history for the API key; check by hand that it was rotated.');
  }
  if (hits) fail(`the build's Firebase API key appears in ${hits.split('\n').length} commit(s) in git history. Rotate it in the Google Cloud console and update VITE_FIREBASE_API_KEY.`);
}

// 6. App Check: the reCAPTCHA Enterprise site key is in the build.
if (![...text.values()].some((b) => /6L[\w-]{38}/.test(b))) fail('no reCAPTCHA Enterprise site key in the build: VITE_RECAPTCHA_SITE_KEY was not set, so App Check would not run.');

const kb = Math.round(files.reduce((n, p) => n + statSync(p).size, 0) / 1024);
for (const w of warnings) console.warn(`check-hosted: warning: ${w}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`check-hosted: FAIL: ${f}`);
  console.error(`check-hosted: ${failures.length} problem(s). Nothing was deployed.`);
  process.exit(1);
}
console.log(`check-hosted: OK (${files.length} files, ${kb} KB, ${warnings.length} warning(s)).`);
