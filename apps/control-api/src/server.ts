import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { HarnessCatalog, VerificationRecord } from '@selarikru/domain';
import { declaredHarnessCatalog } from '@selarikru/harness-claude';
import { createGhCliPort, startReconciler, type GitHubPort } from '@selarikru/integrations-github';
import { createDb, type Db } from '@selarikru/persistence';
import { loadDefaultPolicy, loadPolicyFile } from '@selarikru/policy/load';
import { createScheduler, type TrustedVerifier } from '@selarikru/workflow';
import { buildApp } from './app.ts';
import { loadPlanConfigFile } from './proposals.ts';
import type { TokenVerifier } from './auth.ts';
import { ConfigError, type ControlApiConfig } from './config.ts';
import { startLeaseExpiryDriver } from './expire.ts';
import { createFirebaseVerifier } from './firebase.ts';
import { LocalDiskArtifactStore, resolveArtifactDir } from '../../../packages/artifacts/src/index.ts';
import { dockerRunner, currentTrusted, loadValidRecord, LOCAL_DOCKER_HOST } from '../../../services/verifier/src/service.ts';
import { DEFAULT_VERIFICATION_RETRIES, startVerificationDriver, type VerificationDriverOptions } from '../../../services/verifier/src/driver.ts';
import { ASSEMBLY_LEASE_SECONDS, startAssemblyDriver, type AssemblyDriverOptions } from '../../../services/verifier/src/assembly-driver.ts';

/** Starts the verification driver. Absent: nothing verifies assembled candidates in this process. */
export type VerificationOptions = Omit<VerificationDriverOptions, 'db' | 'tenantId' | 'now'> & { intervalMs: number };

/** Starts the assembly driver. Absent: nothing assembles finished parts into candidates in this process. */
export type AssemblyOptions = Omit<AssemblyDriverOptions, 'db' | 'tenantId' | 'now'> & { intervalMs: number };

const pollInterval = (env: NodeJS.ProcessEnv, name: string, key: string): number | undefined => {
  const interval = env[name];
  if (interval === undefined || interval === '') return undefined;
  const intervalMs = /^\d+$/.test(interval) ? Number(interval) : Number.NaN;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) throw new ConfigError(`invalid configuration: ${name} must be a positive integer of milliseconds, at most 2147483647`, [], [key]);
  return intervalMs;
};

/**
 * The repository candidates are built from, verified against, and pushed from: `SELARIKRU_SOURCE_REPO`, the one setting for it. Must be an absolute path to an
 * existing git repository, because a wrong one would otherwise surface only as every assembly failing.
 */
export function sourceRepoFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env['SELARIKRU_GITHUB_SOURCE_REPO']) throw new ConfigError('SELARIKRU_GITHUB_SOURCE_REPO was replaced: set SELARIKRU_SOURCE_REPO, and SELARIKRU_GITHUB_ENABLED=1 to open pull requests from it', [], ['SELARIKRU_GITHUB_SOURCE_REPO']);
  const repo = env['SELARIKRU_SOURCE_REPO'];
  if (!repo) return undefined;
  if (!isAbsolute(repo) || !existsSync(repo)) throw new ConfigError('invalid configuration: SELARIKRU_SOURCE_REPO must be an absolute path to an existing git repository', [], ['SELARIKRU_SOURCE_REPO']);
  const git = spawnSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { stdio: 'ignore', env: { PATH: env['PATH'] ?? process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (git.status !== 0) throw new ConfigError('invalid configuration: SELARIKRU_SOURCE_REPO is not a git repository', [], ['SELARIKRU_SOURCE_REPO']);
  return repo;
}

/**
 * GitHub review from the environment. `SELARIKRU_GITHUB_ENABLED=1` turns on the owner route that opens a run's draft PR, from `SELARIKRU_SOURCE_REPO`, and the
 * polling reconciler when `SELARIKRU_GITHUB_POLL_INTERVAL_MS` is set. Off by default, so setting a source repository never reaches GitHub by itself.
 */
export function githubOptionsFromEnv(env: NodeJS.ProcessEnv): GithubOptions | undefined {
  const enabled = env['SELARIKRU_GITHUB_ENABLED'];
  if (enabled !== undefined && enabled !== '' && enabled !== '1' && enabled !== '0') throw new ConfigError('invalid configuration: SELARIKRU_GITHUB_ENABLED must be 1 or 0', [], ['SELARIKRU_GITHUB_ENABLED']);
  const interval = env['SELARIKRU_GITHUB_POLL_INTERVAL_MS'];
  const on = enabled === '1';
  const repo = sourceRepoFromEnv(env);
  if (on && !repo) throw new ConfigError('missing required configuration: SELARIKRU_GITHUB_ENABLED needs SELARIKRU_SOURCE_REPO', ['SELARIKRU_SOURCE_REPO']);
  const artifacts = on ? new LocalDiskArtifactStore(resolveArtifactDir(env)) : undefined;
  return {
    webhookSecret: env['SELARIKRU_GITHUB_WEBHOOK_SECRET'] || undefined,
    ...(interval !== undefined && interval !== '' ? { pollIntervalMs: /^\d+$/.test(interval) ? Number(interval) : Number.NaN, port: createGhCliPort() } : {}),
    ...(on && repo && artifacts ? { sourceRepoPath: repo, port: createGhCliPort(), loadRecord: (db: Db, key: { tenantId: string; projectId: string; sha: string }) => loadValidRecord(db, artifacts, key) } : {}),
  };
}

/**
 * Reads the verification driver's settings from the environment. Off unless `SELARIKRU_VERIFICATION_POLL_INTERVAL_MS` is set; when on, the source
 * repository is required, because a missing one would stop every verification silently.
 */
export function verificationOptionsFromEnv(env: NodeJS.ProcessEnv): VerificationOptions | undefined {
  const intervalMs = pollInterval(env, 'SELARIKRU_VERIFICATION_POLL_INTERVAL_MS', 'verificationPollIntervalMs');
  if (intervalMs === undefined) return undefined;
  const repoPath = sourceRepoFromEnv(env);
  if (!repoPath) throw new ConfigError('missing required configuration: SELARIKRU_SOURCE_REPO', ['SELARIKRU_SOURCE_REPO']);
  const dir = resolveArtifactDir(env);
  const host = env['SELARIKRU_VERIFIER_HOST'] || LOCAL_DOCKER_HOST;
  const retries = env['SELARIKRU_VERIFICATION_RETRIES'];
  const maxVerificationRetries = retries === undefined || retries === '' ? DEFAULT_VERIFICATION_RETRIES : /^\d+$/.test(retries) ? Number(retries) : Number.NaN;
  if (!Number.isSafeInteger(maxVerificationRetries) || maxVerificationRetries < 0) throw new ConfigError('invalid configuration: SELARIKRU_VERIFICATION_RETRIES must be a non-negative integer', [], ['verificationRetries']);
  return { intervalMs, repoPath, artifacts: new LocalDiskArtifactStore(dir), runner: dockerRunner(), verifier: { kind: 'verifier', id: `verifier:${host}` }, host, maxVerificationRetries };
}

/** The assembly driver's settings. Off unless `SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS` is set; when on, the source repository is required. */
export function assemblyOptionsFromEnv(env: NodeJS.ProcessEnv): AssemblyOptions | undefined {
  const intervalMs = pollInterval(env, 'SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS', 'assemblyPollIntervalMs');
  if (intervalMs === undefined) return undefined;
  const repoPath = sourceRepoFromEnv(env);
  if (!repoPath) throw new ConfigError('missing required configuration: SELARIKRU_SOURCE_REPO', ['SELARIKRU_SOURCE_REPO']);
  const dir = resolveArtifactDir(env);
  return { intervalMs, repoPath, artifacts: new LocalDiskArtifactStore(dir), leaseSeconds: ASSEMBLY_LEASE_SECONDS };
}

/**
 * What the snapshot and the failures route hold evidence to. The hashes are read once: they cover this process's own verifier code, and the snapshot asks for them on every refresh.
 * The pull-request route keeps its own check per use.
 */
export function evidenceOptionsFromEnv(env: NodeJS.ProcessEnv): EvidenceOptions {
  const artifacts = new LocalDiskArtifactStore(resolveArtifactDir(env));
  const trusted = currentTrusted();
  return { trusted: () => trusted, loadRecord: (db, key) => loadValidRecord(db, artifacts, key) };
}

export interface EvidenceOptions {
  trusted: () => TrustedVerifier;
  loadRecord: (db: Db, key: { tenantId: string; projectId: string; sha: string }) => Promise<VerificationRecord | null>;
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
  /** What this build's adapters declare. Default: the compiled-in list. Nothing is probed here: this host needs no harness installed, and only runners say what they can launch. */
  harnessCatalog?: HarnessCatalog | undefined;
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
  /** What evidence is held to. Absent: no criterion can be counted as verified. */
  evidence?: EvidenceOptions | undefined;
  /** Runs `verifyCandidate` for assembled candidates and reaps verifications with no verdict. Failures reach `onVerificationError`, or `onError`. */
  verification?: VerificationOptions | undefined;
  onVerificationError?: ((e: unknown) => void) | undefined;
  /** Runs `assembleCandidate` for finished parts. Failures reach `onAssemblyError`, or `onError`. */
  assembly?: AssemblyOptions | undefined;
  onAssemblyError?: ((e: unknown) => void) | undefined;
}): Promise<RunningServer> {
  const { config } = options;
  validateGithubOptions(options.github);
  const now = options.now ?? (() => new Date());
  const { db, close } = createDb(options.databaseUrl);
  const policy = options.policyFile ? loadPolicyFile(options.policyFile) : loadDefaultPolicy();
  const catalog = options.harnessCatalog ?? declaredHarnessCatalog();
  const scheduler = createScheduler({ db, now, policy, catalog });
  const verifier = options.verifier ?? createFirebaseVerifier({ projectId: config.firebaseProjectId });
  const app = buildApp({ config, db, verifier, now, scheduler, policy, catalog, evidence: options.evidence ? { trusted: options.evidence.trusted, loadRecord: (key) => options.evidence!.loadRecord(db, key) } : undefined, planConfig: options.planConfigFile ? loadPlanConfigFile(options.planConfigFile) : undefined,
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
  const assemblies = options.assembly
    ? startAssemblyDriver({ db, tenantId: config.tenantId, now, ...options.assembly, ...((options.onAssemblyError ?? options.onError) ? { onError: (options.onAssemblyError ?? options.onError)! } : {}) })
    : undefined;
  const address = await app.listen({ host: config.host, port: config.port });
  return {
    address,
    async stop() {
      await driver.stop();
      await reconciler?.stop();
      await verifications?.stop();
      await assemblies?.stop();
      await app.close();
      await close();
    },
  };
}
