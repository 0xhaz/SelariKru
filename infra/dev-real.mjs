// Local stack for a real run: `pnpm dev:real`. dev-stack plus a seeded project pointing at a real GitHub repository and a real base commit, with the draft-PR route on.
// Set in the environment or .env (seeded with no network call):
//   SELARIKRU_OWNER_UID            the Auth Emulator UID of the owner
//   SELARIKRU_SOURCE_REPO          absolute path to the source checkout; also pass it to the runner: --repo proj_real_local=<path>
//   SELARIKRU_REAL_REPOSITORY      owner/repo the draft pull request opens against
//   SELARIKRU_REAL_ALLOWED_PATHS   comma-separated paths workers may change
//   SELARIKRU_REAL_BUDGET_LIMIT_USD  run budget in USD
// The seed also creates the owner's account in the Auth Emulator (loopback only), with UID SELARIKRU_OWNER_UID. Sign in with SELARIKRU_REAL_OWNER_EMAIL
// (default owner@selarikru.invalid) and SELARIKRU_REAL_OWNER_PASSWORD (default real-run-local-only-password; emulator-only, not a secret).
// Optional: SELARIKRU_REAL_PROJECT_ID, SELARIKRU_REAL_RUN_ID, SELARIKRU_REAL_BASE_BRANCH (default main), SELARIKRU_REAL_TERMINAL_CONTROL=1 (lets the owner take control of a running worker; off by default).
// Generated files go to the git-ignored .local/real-run/. `dev:demo` is unaffected. Opening a PR stays an owner action.
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

if (!process.env.SELARIKRU_SOURCE_REPO) {
  console.error('dev:real needs SELARIKRU_SOURCE_REPO: the absolute path of the checkout to build from.');
  process.exit(1);
}

const dir = resolve('.local/real-run');
mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  SELARIKRU_REAL_RUN: '1',
  SELARIKRU_REAL_RUN_DIR: dir,
  SELARIKRU_GITHUB_ENABLED: process.env.SELARIKRU_GITHUB_ENABLED ?? '1',
  SELARIKRU_POLICY_FILE: resolve(dir, 'policy.json'),
  SELARIKRU_PLAN_CONFIG_FILE: resolve(dir, 'plan-config.json'),
});

await import('./dev-stack.mjs');
