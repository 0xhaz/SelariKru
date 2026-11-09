import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfigFromEnv, parseConfig } from '../src/index.ts';
import { testConfig } from './helpers.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemblyOptionsFromEnv, githubOptionsFromEnv, sourceRepoFromEnv, verificationOptionsFromEnv } from '../src/server.ts';

const ENV = {
  SELARIKRU_TENANT_ID: 'tenant_a',
  SELARIKRU_OWNER_UID: 'owner',
  FIREBASE_PROJECT_ID: 'selarikru',
  SELARIKRU_ALLOWED_ORIGINS: 'http://localhost:5173',
  SELARIKRU_MAX_CONCURRENT_TOTAL: '2',
  SELARIKRU_ATTEMPT_TIMEOUT_SECONDS: '1800',
  SELARIKRU_MAX_INFRA_RETRIES: '3',
  SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS: '10',
  SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS: '40',
  SELARIKRU_PAIRING_CODE_TTL_SECONDS: '600',
  SELARIKRU_EXPIRE_LEASES_INTERVAL_MS: '5000',
};

describe('config', () => {
  it('loads a complete environment into one validated object', () => {
    const c = loadConfigFromEnv(ENV);
    expect(c.caps).toEqual({ maxConcurrentTotal: 2, attemptTimeoutSeconds: 1800, maxInfraRetries: 3, infraRetryBackoffSeconds: 10, infraRetryBackoffMaxSeconds: 40 });
    expect(c.host).toBe('127.0.0.1');
    expect(c.mode).toBe('local');
  });

  it.each([
    'SELARIKRU_MAX_CONCURRENT_TOTAL',
    'SELARIKRU_ATTEMPT_TIMEOUT_SECONDS',
    'SELARIKRU_MAX_INFRA_RETRIES',
    'SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS',
    'SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS',
    'SELARIKRU_PAIRING_CODE_TTL_SECONDS',
    'SELARIKRU_OWNER_UID',
    'SELARIKRU_TENANT_ID',
  ])('a missing %s fails at startup with a named error', (name) => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env[name];
    try {
      loadConfigFromEnv(env);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).name).toBe('ConfigError');
      expect((e as ConfigError).missing).toContain(name);
    }
  });

  it('treats an empty or non-numeric limit as missing, never as zero or unlimited', () => {
    expect(() => loadConfigFromEnv({ ...ENV, SELARIKRU_MAX_INFRA_RETRIES: '' })).toThrow(ConfigError);
    expect(() => loadConfigFromEnv({ ...ENV, SELARIKRU_MAX_CONCURRENT_TOTAL: 'many' })).toThrow(ConfigError);
    expect(() => loadConfigFromEnv({ ...ENV, SELARIKRU_MAX_CONCURRENT_TOTAL: '0' })).toThrow(ConfigError);
  });

  it('local mode refuses a non-loopback bind; hosted mode needs explicit origins and no emulator', () => {
    expect(() => parseConfig({ ...testConfig(), host: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...testConfig(), mode: 'hosted', host: '0.0.0.0', allowedOrigins: [] })).toThrow(ConfigError);
    expect(() => loadConfigFromEnv({ ...ENV, SELARIKRU_MODE: 'hosted', SELARIKRU_API_HOST: '0.0.0.0', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow(ConfigError);
    expect(parseConfig({ ...testConfig(), mode: 'hosted', host: '0.0.0.0', allowedOrigins: ['https://app.example'] }).mode).toBe('hosted');
  });
});

const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};

describe('assembly driver settings', () => {
  it('are off by default and need the source repository when on; the artifact directory has one resolver', () => {
    expect(assemblyOptionsFromEnv({})).toBeUndefined();
    expect(() => assemblyOptionsFromEnv({ SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS: 'soon' })).toThrow(/positive integer/);
    expect(() => assemblyOptionsFromEnv({ SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS: '5000' })).toThrow(/SELARIKRU_SOURCE_REPO/);
    const repo = gitRepo();
    expect(assemblyOptionsFromEnv({ SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS: '5000', SELARIKRU_SOURCE_REPO: repo })).toMatchObject({ intervalMs: 5000, repoPath: repo });
    expect(() => assemblyOptionsFromEnv({ SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS: '5000', SELARIKRU_SOURCE_REPO: repo, SELARIKRU_ARTIFACT_DIR: 'relative' })).toThrow(/absolute/);
  });
});

describe('verification driver settings', () => {
  it('are off by default and need the source repository when on', () => {
    expect(verificationOptionsFromEnv({})).toBeUndefined();
    expect(() => verificationOptionsFromEnv({ SELARIKRU_VERIFICATION_POLL_INTERVAL_MS: 'soon' })).toThrow(/positive integer/);
    expect(() => verificationOptionsFromEnv({ SELARIKRU_VERIFICATION_POLL_INTERVAL_MS: '60000' })).toThrow(/SELARIKRU_SOURCE_REPO/);
    const repo = gitRepo();
    const options = verificationOptionsFromEnv({ SELARIKRU_VERIFICATION_POLL_INTERVAL_MS: '60000', SELARIKRU_SOURCE_REPO: repo, SELARIKRU_ARTIFACT_DIR: '/a', SELARIKRU_VERIFIER_HOST: 'local-docker' });
    expect(options).toMatchObject({ intervalMs: 60000, repoPath: repo, host: 'local-docker', verifier: { kind: 'verifier', id: 'verifier:local-docker' } });
  });
});

describe('the source repository setting', () => {
  it('must be an absolute path to an existing git repository', () => {
    expect(sourceRepoFromEnv({})).toBeUndefined();
    expect(() => sourceRepoFromEnv({ SELARIKRU_SOURCE_REPO: 'relative/path' })).toThrow(/absolute/);
    expect(() => sourceRepoFromEnv({ SELARIKRU_SOURCE_REPO: '/nonexistent/source' })).toThrow(/absolute/);
    const notRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    expect(() => sourceRepoFromEnv({ SELARIKRU_SOURCE_REPO: notRepo })).toThrow(/not a git repository/);
    const repo = gitRepo();
    expect(sourceRepoFromEnv({ SELARIKRU_SOURCE_REPO: repo })).toBe(repo);
    expect(() => sourceRepoFromEnv({ SELARIKRU_GITHUB_SOURCE_REPO: repo })).toThrow(/SELARIKRU_SOURCE_REPO/);
  });

  it('a source repository alone never reaches GitHub', () => {
    expect(githubOptionsFromEnv({ SELARIKRU_SOURCE_REPO: gitRepo() })?.sourceRepoPath).toBeUndefined();
    expect(() => githubOptionsFromEnv({ SELARIKRU_GITHUB_ENABLED: '1' })).toThrow(/SELARIKRU_SOURCE_REPO/);
    expect(() => githubOptionsFromEnv({ SELARIKRU_GITHUB_ENABLED: 'yes' })).toThrow(/1 or 0/);
  });
});
