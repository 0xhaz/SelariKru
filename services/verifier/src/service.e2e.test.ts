// Real end-to-end verification in the pinned Docker image. Off by default (minutes, needs Docker):
//   VERIFY_E2E=1 pnpm --filter @selarikru/verifier exec vitest run src/service.e2e.test.ts
// The calibration solution is read from the private tools directory into a temporary repository only; it never reaches a worker.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { schema, type Db } from '../../../packages/persistence/src/index.ts';
import { PROJECT, RUN, TENANT, resetDb, seedTask, setupTestDb, specFor, type TestDb } from '../../workflow/test/helpers.ts';
import { assembleCandidate } from './integrate.ts';
import { LOCAL_DOCKER_HOST, dockerRunner, loadValidRecord, verifyCandidate } from './service.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const walk = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel)).flatMap((n) => { const r = rel ? `${rel}/${n}` : n; return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r]; });

describe.skipIf(process.env['VERIFY_E2E'] !== '1')('real Docker verification of an assembled candidate', () => {
  let tdb: TestDb; let db: Db; let tmp: string; let repo: string; let artifacts: LocalDiskArtifactStore; let baseSha: string;
  beforeAll(async () => {
    tdb = await setupTestDb(); db = tdb.db;
    tmp = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
    artifacts = new LocalDiskArtifactStore(join(tmp, 'artifacts'));
    repo = join(tmp, 'repo'); mkdirSync(repo);
    git(repo, 'init', '-q');
    cpSync(join(root, 'examples/feedback-board-starter'), repo, { recursive: true, filter: (p) => !['node_modules', 'dist'].includes(basename(p)) && !/\.sqlite/.test(p) });
    git(repo, 'add', '-A'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'starter');
    baseSha = git(repo, 'rev-parse', 'HEAD');
  });
  afterAll(async () => { await tdb.close(); rmSync(tmp, { recursive: true, force: true }); });

  async function candidate(withSolution: boolean) {
    await resetDb(db);
    const overlay = join(root, 'tools/verifier-calibration/feedback-board-solution/overlay');
    const changes: unknown[] = [];
    if (withSolution) {
      for (const p of walk(overlay)) {
        const bytes = readFileSync(join(overlay, p));
        const ref = await artifacts.put(bytes);
        changes.push({ path: p, status: existsSync(join(repo, p)) ? 'modified' : 'added', kind: 'file', sha256: ref.sha256, linkTarget: null, size: ref.size });
      }
    } else {
      const ref = await artifacts.put(Buffer.from('placeholder\n'));
      changes.push({ path: 'src/placeholder.txt', status: 'added', kind: 'file', sha256: ref.sha256, linkTarget: null, size: ref.size });
    }
    await seedTask(db, specFor('t1', { baseSha, allowedPaths: ['src', 'server', 'migrations'] }), 'verifying');
    const manifest = (await artifacts.put(Buffer.from(JSON.stringify({ schema: 1, taskId: 't1', revision: 1, baseSha, changes })))).sha256;
    await db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_t1', taskId: 't1', revision: 1, attemptNumber: 1, outcome: 'running', startedAt: new Date(), endedAt: new Date(), detail: { changeManifestSha256: manifest } });
    const r = await assembleCandidate({ tenantId: TENANT, projectId: PROJECT, runId: RUN, target: 'main', pinnedBaseSha: baseSha, currentBaseSha: baseSha, repoPath: repo }, { db, artifacts, workRoot: join(tmp, 'work') });
    if (!r.ok) throw new Error(`assembly failed: ${r.reason}`);
    return r;
  }
  const verify = (c: { sha: string }) => verifyCandidate({ tenantId: TENANT, projectId: PROJECT, runId: RUN, sha: c.sha, taskId: 't1', repoPath: repo },
    { db, artifacts, runner: dockerRunner(), verifier: { kind: 'verifier', id: 'verifier-local-docker' }, host: LOCAL_DOCKER_HOST, workRoot: join(tmp, 'work') });

  it('the calibration solution candidate passes 8/8 and the record is bound to its SHA', async () => {
    const c = await candidate(true);
    const rec = await verify(c);
    console.log('E2E solution', rec.candidateSha, rec.result, rec.results.map((r) => `${r.checkId}:${r.status}`).join(' '));
    expect(rec.result).toBe('passed');
    expect(rec.results.filter((r) => r.status === 'passed')).toHaveLength(8);
    expect(rec.candidateSha).toBe(c.sha);
    expect(rec.environmentImageDigest).toMatch(/@sha256:/);
    expect(await loadValidRecord(db, artifacts, { tenantId: TENANT, projectId: PROJECT, sha: c.sha })).toEqual(rec);
  }, 1_500_000);

  it('the starter candidate fails 8/8', async () => {
    const c = await candidate(false);
    const rec = await verify(c);
    console.log('E2E starter', rec.candidateSha, rec.result, rec.results.map((r) => `${r.checkId}:${r.status}`).join(' '));
    expect(rec.result).toBe('failed');
    expect(rec.results.filter((r) => r.status === 'failed')).toHaveLength(8);
  }, 1_500_000);
});
