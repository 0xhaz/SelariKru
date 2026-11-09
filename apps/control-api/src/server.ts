import { startReconciler, type GitHubPort } from '@selarikru/integrations-github';
import { createDb } from '@selarikru/persistence';
import { loadDefaultPolicy, loadPolicyFile } from '@selarikru/policy/load';
import { createScheduler } from '@selarikru/workflow';
import { buildApp } from './app.ts';
import { loadPlanConfigFile } from './proposals.ts';
import type { TokenVerifier } from './auth.ts';
import type { ControlApiConfig } from './config.ts';
import { startLeaseExpiryDriver } from './expire.ts';
import { createFirebaseVerifier } from './firebase.ts';

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
  /** GitHub review integration. `webhookSecret` registers the webhook route; `port` + `pollIntervalMs` start the polling reconciler (the local path). */
  github?: { webhookSecret?: string | undefined; port?: GitHubPort | undefined; pollIntervalMs?: number | undefined } | undefined;
}): Promise<RunningServer> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const { db, close } = createDb(options.databaseUrl);
  const policy = options.policyFile ? loadPolicyFile(options.policyFile) : loadDefaultPolicy();
  const scheduler = createScheduler({ db, now, policy });
  const verifier = options.verifier ?? createFirebaseVerifier({ projectId: config.firebaseProjectId });
  const app = buildApp({ config, db, verifier, now, scheduler, policy, planConfig: options.planConfigFile ? loadPlanConfigFile(options.planConfigFile) : undefined,
    github: options.github?.webhookSecret ? { webhookSecret: options.github.webhookSecret } : undefined });
  const driver = startLeaseExpiryDriver({
    scheduler, now, intervalMs: config.expireLeasesIntervalMs,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const reconciler = options.github?.port && options.github.pollIntervalMs
    ? startReconciler({ db, port: options.github.port, now, intervalMs: options.github.pollIntervalMs, ...(options.onError ? { onError: options.onError } : {}) })
    : undefined;
  const address = await app.listen({ host: config.host, port: config.port });
  return {
    address,
    async stop() {
      await driver.stop();
      await reconciler?.stop();
      await app.close();
      await close();
    },
  };
}
