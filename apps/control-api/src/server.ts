import type { VerificationRecord } from '@selarikru/domain';
import { startReconciler, type GitHubPort } from '@selarikru/integrations-github';
import { createDb, type Db } from '@selarikru/persistence';
import { loadDefaultPolicy, loadPolicyFile } from '@selarikru/policy/load';
import { createScheduler } from '@selarikru/workflow';
import { buildApp } from './app.ts';
import { loadPlanConfigFile } from './proposals.ts';
import type { TokenVerifier } from './auth.ts';
import { ConfigError, type ControlApiConfig } from './config.ts';
import { startLeaseExpiryDriver } from './expire.ts';
import { createFirebaseVerifier } from './firebase.ts';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { dockerRunner, LOCAL_DOCKER_HOST } from '../../../services/verifier/src/service.ts';
import { startVerificationDriver, type VerificationDriverOptions } from '../../../services/verifier/src/driver.ts';

/** Starts the verification driver. Absent: nothing verifies assembled candidates in this process. */
export type VerificationOptions = Omit<VerificationDriverOptions, 'db' | 'tenantId' | 'now'> & { intervalMs: number };

/**
 * Reads the verification driver's settings from the environment. Off unless `SELARIKRU_VERIFICATION_POLL_INTERVAL_MS` is set; when on, the source
 * repository and artifact directory are required, because a missing one would stop every verification silently.
 */
export function verificationOptionsFromEnv(env: NodeJS.ProcessEnv): VerificationOptions | undefined {
  const interval = env['SELARIKRU_VERIFICATION_POLL_INTERVAL_MS'];
  if (interval === undefined || interval === '') return undefined;
  const intervalMs = /^\d+$/.test(interval) ? Number(interval) : Number.NaN;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) {
    throw new ConfigError('invalid configuration: SELARIKRU_VERIFICATION_POLL_INTERVAL_MS must be a positive integer of milliseconds, at most 2147483647', [], ['verificationPollIntervalMs']);
  }
  const repoPath = env['SELARIKRU_GITHUB_SOURCE_REPO'];
  const dir = env['SELARIKRU_ARTIFACT_DIR'];
  if (!repoPath) throw new ConfigError('missing required configuration: SELARIKRU_GITHUB_SOURCE_REPO', ['SELARIKRU_GITHUB_SOURCE_REPO']);
  if (!dir) throw new ConfigError('missing required configuration: SELARIKRU_ARTIFACT_DIR', ['SELARIKRU_ARTIFACT_DIR']);
  const host = env['SELARIKRU_VERIFIER_HOST'] || LOCAL_DOCKER_HOST;
  return { intervalMs, repoPath, artifacts: new LocalDiskArtifactStore(dir), runner: dockerRunner(), verifier: { kind: 'verifier', id: `verifier:${host}` }, host };
}

export interface GithubOptions {
  webhookSecret?: string | undefined;
  port?: GitHubPort | undefined;
  pollIntervalMs?: number | undefined;
  sourceRepoPath?: string | undefined;
  loadRecord?: ((db: Db, key: { tenantId: string; projectId: string; sha: string }) => Promise<VerificationRecord | null>) | undefined;
}

/** Longest delay `setTimeout` accepts; a larger interval would fire immediately and spin. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Fails startup clearly on an unusable GitHub setting instead of running half-configured. */
export function validateGithubOptions(g: GithubOptions | undefined): void {
  if (!g) return;
  if (g.pollIntervalMs !== undefined && (!Number.isSafeInteger(g.pollIntervalMs) || g.pollIntervalMs < 1 || g.pollIntervalMs > MAX_TIMER_MS)) {
    throw new ConfigError('invalid configuration: SELARIKRU_GITHUB_POLL_INTERVAL_MS must be a positive integer of milliseconds, at most 2147483647', [], ['githubPollIntervalMs']);
  }
  if (g.pollIntervalMs !== undefined && !g.port) throw new ConfigError('invalid configuration: a GitHub poll interval needs a GitHub port', [], ['githubPort']);
  if (g.webhookSecret && g.pollIntervalMs === undefined) {
    throw new ConfigError('missing required configuration: SELARIKRU_GITHUB_WEBHOOK_SECRET needs SELARIKRU_GITHUB_POLL_INTERVAL_MS, because the reconciler processes webhook hints', ['SELARIKRU_GITHUB_POLL_INTERVAL_MS']);
  }
  if ((g.sourceRepoPath !== undefined) !== (g.loadRecord !== undefined) || (g.sourceRepoPath !== undefined && !g.port)) {
    throw new ConfigError('invalid configuration: opening pull requests needs a source repository path, a record loader and a GitHub port together', [], ['githubPullRequests']);
  }
}

export interface RunningServer {
  readonly address: string;
  stop(): Promise<void>;
}

/** Wires the real database, Firebase verifier, policy file and lease-expiry driver around `buildApp`. */
export async function startServer(options: {
  config: ControlApiConfig;
  databaseUrl: string;
  policyFile?: string | undefined;
  /** JSON file of per-project plan settings (see loadPlanConfigFile). Without it, proposal review is blocked. */
  planConfigFile?: string | undefined;
  verifier?: TokenVerifier | undefined;
  now?: (() => Date) | undefined;
  onError?: ((e: unknown) => void) | undefined;
  /** Receives GitHub reconciler failures, so they can carry their own log label. Defaults to `onError`. */
  onReconcileError?: ((e: unknown) => void) | undefined;
  /**
   * GitHub review integration. `webhookSecret` registers the webhook route and needs `port` and `pollIntervalMs` (the reconciler processes its
   * hints). `port` + `pollIntervalMs` start the polling reconciler, the local path. `sourceRepoPath` + `loadRecord` register the owner route that
   * opens a run's draft PR; `loadRecord` is the verifier's `loadValidRecord` bound to its artifact store.
   */
  github?: GithubOptions | undefined;
  /** Runs `verifyCandidate` for assembled candidates and reaps verifications with no verdict. Failures reach `onVerificationError`, or `onError`. */
  verification?: VerificationOptions | undefined;
  onVerificationError?: ((e: unknown) => void) | undefined;
}): Promise<RunningServer> {
  const { config } = options;
  validateGithubOptions(options.github);
  const now = options.now ?? (() => new Date());
  const { db, close } = createDb(options.databaseUrl);
  const policy = options.policyFile ? loadPolicyFile(options.policyFile) : loadDefaultPolicy();
  const scheduler = createScheduler({ db, now, policy });
  const verifier = options.verifier ?? createFirebaseVerifier({ projectId: config.firebaseProjectId });
  const app = buildApp({ config, db, verifier, now, scheduler, policy, planConfig: options.planConfigFile ? loadPlanConfigFile(options.planConfigFile) : undefined,
    github: options.github ? {
      webhookSecret: options.github.webhookSecret,
      pullRequests: options.github.port && options.github.sourceRepoPath && options.github.loadRecord
        ? { port: options.github.port, repoPath: options.github.sourceRepoPath, loadRecord: (key) => options.github!.loadRecord!(db, key) }
        : undefined,
    } : undefined });
  const driver = startLeaseExpiryDriver({
    scheduler, now, intervalMs: config.expireLeasesIntervalMs,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const reconciler = options.github?.port && options.github.pollIntervalMs
    ? startReconciler({ db, port: options.github.port, now, intervalMs: options.github.pollIntervalMs, ...((options.onReconcileError ?? options.onError) ? { onError: (options.onReconcileError ?? options.onError)! } : {}) })
    : undefined;
  const verifications = options.verification
    ? startVerificationDriver({ db, tenantId: config.tenantId, now, ...options.verification, ...((options.onVerificationError ?? options.onError) ? { onError: (options.onVerificationError ?? options.onError)! } : {}) })
    : undefined;
  const address = await app.listen({ host: config.host, port: config.port });
  return {
    address,
    async stop() {
      await driver.stop();
      await reconciler?.stop();
      await verifications?.stop();
      await app.close();
      await close();
    },
  };
}
