import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { createGhCliPort } from '@selarikru/integrations-github';
import { loadValidRecord } from '../../../services/verifier/src/service.ts';
import type { Db } from '@selarikru/persistence';
import { ConfigError, loadConfigFromEnv } from './config.ts';
import { startServer, type GithubOptions } from './server.ts';

function githubOptions(env: NodeJS.ProcessEnv): GithubOptions | undefined {
  const interval = env['SELARIKRU_GITHUB_POLL_INTERVAL_MS'];
  const repo = env['SELARIKRU_GITHUB_SOURCE_REPO'];
  const dir = env['SELARIKRU_ARTIFACT_DIR'];
  if (repo && !dir) throw new ConfigError('missing required configuration: SELARIKRU_ARTIFACT_DIR', ['SELARIKRU_ARTIFACT_DIR']);
  const artifacts = dir ? new LocalDiskArtifactStore(dir) : undefined;
  return {
    webhookSecret: env['SELARIKRU_GITHUB_WEBHOOK_SECRET'] || undefined,
    ...(interval !== undefined && interval !== '' ? { pollIntervalMs: /^\d+$/.test(interval) ? Number(interval) : Number.NaN, port: createGhCliPort() } : {}),
    ...(repo && artifacts ? { sourceRepoPath: repo, port: createGhCliPort(), loadRecord: (db: Db, key: { tenantId: string; projectId: string; sha: string }) => loadValidRecord(db, artifacts, key) } : {}),
  };
}

try {
  const config = loadConfigFromEnv(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('missing required configuration: DATABASE_URL', ['DATABASE_URL']);
  const server = await startServer({
    config,
    databaseUrl,
    policyFile: process.env['SELARIKRU_POLICY_FILE'] || undefined,
    planConfigFile: process.env['SELARIKRU_PLAN_CONFIG_FILE'] || undefined,
    github: githubOptions(process.env),
    onReconcileError: (e) => console.error('github reconciler pass failed:', e instanceof Error ? e.message : e),
    onError: (e) => console.error('lease expiry pass failed:', e instanceof Error ? e.message : e),
  });
  console.log(`control API listening on ${server.address}`);
  const shutdown = () => void server.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(e instanceof ConfigError ? `${e.name}: ${e.message}` : e);
  process.exit(1);
}
