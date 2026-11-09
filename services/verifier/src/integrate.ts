/**
 * Integration controller (docs/architecture.md section 8, "Integration authority"; section 6 rules 7 and 8).
 *
 * Builds the exact candidate that independent verification judges: a real git commit made from the pinned base SHA plus each
 * completed task's content-addressed change set, in a clean temporary clone this function owns. Identical inputs give an
 * identical commit SHA: git runs with no global or system configuration, an empty template, hooks off, and a fixed author,
 * committer and timestamp.
 *
 * Every change-set manifest is untrusted input. Nothing is applied until all of them verify; any failure fails the whole
 * candidate with a named reason and no partial result. Conflicts are never resolved by guessing: they become a proposed plan
 * revision holding one targeted resolution task.
 *
 * The commit is exported to `refs/selarikru/candidates/<sha>` in the local source repository (no remote is touched), so it
 * outlives the temporary clone.
 *
 * Imports are relative on purpose: the verifier image installs only this package, so a workspace dependency here would
 * break its frozen-lockfile install. This file is never loaded by the verifier runner.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ArtifactIntegrityError, type ArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { checkEventAuthority, TaskSpecSchema, transition, validatePlanRevision, type EventEnvelope, type TaskSpec, type TaskStatus } from '../../../packages/domain/src/index.ts';
import { appendEvent, appendUsage, INTEGRATION_ROLE, schema, sql, withTx, type Db, type Tx } from '../../../packages/persistence/src/index.ts';
import { emit, SCHEDULER_ACTOR } from '../../workflow/src/events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus } from '../../workflow/src/taskstate.ts';
import { checkAllowedPaths, type FileChange } from '../../../packages/runtime-docker-local/src/diff.ts';

const execFileP = promisify(execFile);

/** Edits here are never accepted from a worker. The trusted manifest may add more through `IntegrationDeps.protectedPaths`. */
export const DEFAULT_PROTECTED_PATHS = ['contract', 'services/verifier', 'tools/verifier-calibration'] as const;
export const INTEGRATION_ACTOR = { kind: 'integration', id: 'integration' } as const;
const LEASE_SECONDS = 600;
const MAX_CHANGES = 20_000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FIXED_DATE = '2000-01-01T00:00:00Z';

export interface IntegrationRun {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  /** The target branch the single integration lease is held for. */
  readonly target: string;
  /**
   * The base the run was planned on; every worker manifest must name it. The caller KEEPS this original value for the life of the
   * run, even after the target moves: workers built against it, and replay protection compares against it.
   */
  readonly pinnedBaseSha: string;
  /**
   * The target's tip when assembly is requested. When it differs from `pinnedBaseSha` the candidate is rebuilt on it (the caller
   * passes the new tip here, not in `pinnedBaseSha`). Any path a part changed that main also changed since the part's base is a
   * conflict: change sets hold post-images only, and no three-way merge is attempted.
   */
  readonly currentBaseSha: string;
  /** The run's live candidate was built on an earlier tip. Its evidence is retired first even when the tip is back at `pinnedBaseSha`. */
  readonly baseMoved?: boolean;
  /** Local source repository holding both SHAs. */
  readonly repoPath: string;
  /**
   * Set by the assembly driver: names exactly what is being assembled (the parts and the bases). A failure row records it, so the driver can leave
   * a run alone until something actually changed instead of writing a new `candidate.failed` every poll.
   */
  readonly inputsKey?: string;
}

export interface IntegrationDeps {
  readonly db: Db;
  readonly artifacts: ArtifactStore;
  readonly now?: () => Date;
  /** Parent directory for the temporary clone. Default: the system temp directory. */
  readonly workRoot?: string;
  /** Extra protected path prefixes from the trusted manifest. */
  readonly protectedPaths?: readonly string[];
  readonly leaseSeconds?: number;
  /** Keep the clone (and return its path) after success. The caller then owns its removal. Failed assemblies always clean up. */
  readonly keepClone?: boolean;
  /** Test seam: runs just before the final transaction, while the lease is still held. */
  readonly beforePublish?: () => Promise<void>;
  /**
   * Set by the assembly driver. An infrastructure failure (`INFRASTRUCTURE_FAILURES`) reaches this, under the lease, instead of writing a failure row and a
   * `candidate.failed`: it says nothing about the work, and the driver retries. Without it the failure is recorded as any other.
   */
  readonly onInfrastructureFailure?: (failure: { readonly reason: FailureReason; readonly message: string }) => Promise<void>;
  /** Asked right after the lease is held, before any work. False stops here with `not_due` and records nothing, so a pass that lost a race to another assembly leaves no failure row. */
  readonly stillDue?: () => Promise<boolean>;
}

export interface CandidatePart {
  readonly taskId: string;
  readonly revision: number;
  readonly attemptId: string;
  readonly manifestSha256: string;
  /** Sorted paths this part changed. */
  readonly paths: readonly string[];
}

export interface Invalidation {
  readonly reason: 'base_changed' | 'superseded_by_new_candidate';
  readonly candidates: readonly string[];
  readonly checkRuns: readonly string[];
  readonly approvals: readonly string[];
  /** Verified tasks whose evidence was invalidated; they are `verifying` again and need a new verdict. */
  readonly reopenedTasks?: readonly string[];
}

export interface Candidate {
  readonly ok: true;
  readonly candidateId: string;
  /** The candidate commit. This is `candidateSha`. */
  readonly sha: string;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly parts: readonly CandidatePart[];
  /** Records invalidated because the base moved (and rebuilt here). */
  readonly invalidated?: Invalidation;
  /** Older candidates and their evidence invalidated because this one replaces them. */
  readonly superseded?: Invalidation;
  readonly clonePath?: string;
}

export type FailureReason =
  | 'rebuild_deferred'
  | 'invalid_request'
  | 'lease_held'
  | 'lease_lost'
  | 'not_due'
  | 'no_parts'
  | 'task_spec_invalid'
  | 'manifest_missing'
  | 'manifest_corrupt'
  | 'manifest_invalid'
  | 'manifest_identity'
  | 'content_missing'
  | 'artifact_unreadable'
  | 'path_rejected'
  | 'protected_path'
  | 'dependency_cycle'
  | 'base_unavailable'
  | 'conflict'
  | 'apply_failed'
  | 'resolution_invalid'
  | 'git_failed';

export interface Conflict {
  readonly path: string;
  /**
   * overlap: different tasks changed the same file differently (ordered or not: a worker never saw its predecessor's edits).
   * does_not_apply: the change does not apply to the tree it lands on.
   * base_moved: main changed the same path since the part's base.
   * path_collision: paths that differ only in case or Unicode normalisation (one file on a case-insensitive disk).
   */
  readonly kind: 'overlap' | 'does_not_apply' | 'base_moved' | 'path_collision';
  readonly taskIds: readonly string[];
}

export interface CandidateFailure {
  readonly ok: false;
  readonly reason: FailureReason;
  readonly message: string;
  readonly candidateId?: string;
  readonly conflicts?: readonly Conflict[];
  /** An infrastructure failure handed to `onInfrastructureFailure`: nothing was recorded against the work. */
  readonly deferred?: boolean;
  /** The proposed plan revision holding the resolution task, for `conflict`. */
  readonly proposalId?: string;
  readonly invalidated?: Invalidation;
}

export type AssemblyResult = Candidate | CandidateFailure;

/**
 * Reasons that say nothing about the work: a stale git lock, a moved artifact directory, a base the checkout does not hold yet. Everything else (conflict,
 * manifest identity, path rejections) is a verdict on these exact inputs.
 */
export const INFRASTRUCTURE_FAILURES: ReadonlySet<FailureReason> = new Set(['git_failed', 'base_unavailable', 'manifest_missing', 'content_missing', 'artifact_unreadable']);

class Fail extends Error {
  constructor(readonly reason: FailureReason, message: string, readonly extra: { conflicts?: Conflict[]; parts?: ResolvedPartRef[] } = {}) {
    super(message);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}...` : s);
const canon = (p: string): string => p.normalize('NFC').toLowerCase();

// ---------------------------------------------------------------------------------------------------------------------
// Paths

/** Why a changed path is unusable, or null. Syntax only; scope is checked against `allowedPaths` afterwards. */
export function unsafePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return 'empty path';
  if (p.includes('\0')) return 'NUL in path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  const segs = p.split('/');
  if (segs.some((s) => s === '')) return 'empty path segment';
  if (segs.some((s) => s === '.' || s === '..')) return 'parent or current-directory segment';
  if (segs.some((s) => canon(s) === '.git')) return '.git segment';
  return null;
}

function protectedPrefixes(extra: readonly string[] | undefined): string[] {
  return [...DEFAULT_PROTECTED_PATHS, ...(extra ?? [])].map((p) => canon(p.replace(/^(\.\/)+/, '').replace(/\/+$/, ''))).filter((p) => p !== '');
}

const isProtected = (path: string, prefixes: readonly string[]): boolean => {
  const c = canon(path);
  return prefixes.some((x) => c === x || c.startsWith(`${x}/`));
};

// ---------------------------------------------------------------------------------------------------------------------
// Manifests

interface ManifestChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly kind: 'file' | 'symlink' | 'special' | null;
  readonly sha256: string | null;
  readonly linkTarget: string | null;
  bytes: Uint8Array | null;
}

interface LoadedPart extends CandidatePart {
  readonly spec: TaskSpec;
  readonly changes: readonly ManifestChange[];
  /** The base the manifest was built on. */
  readonly baseSha: string;
  /** Set when this part is a resolution task recorded in a plan proposal. */
  readonly resolution: Resolution | null;
}

/** What a resolution was created for: one resolved part, bound by revision, manifest and path set. */
interface ResolvedPartRef {
  readonly taskId: string;
  readonly revision: number;
  readonly manifestSha256: string;
  readonly paths: readonly string[];
}

interface Resolution {
  readonly taskId: string;
  readonly baseSha: string;
  /** The only paths this resolution may touch. */
  readonly paths: ReadonlySet<string>;
  readonly parts: ReadonlyMap<string, ResolvedPartRef>;
  /** Proposal creation time (ms), for "most recent wins". */
  readonly createdAt: number;
}

/** Resolution tasks recorded in this run's integration plan proposals (database rows, not worker input). Rejected ones are named so their parts are skipped. */
async function loadResolutions(db: Db, run: IntegrationRun): Promise<{ active: Map<string, Resolution>; rejected: Set<string> }> {
  const rows = await db.execute(sql`
    SELECT detail -> 'resolves' AS resolves, status, extract(epoch from created_at) * 1000 AS at FROM plan_proposals
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND source = 'integration' AND detail -> 'resolves' IS NOT NULL`);
  const active = new Map<string, Resolution>();
  const rejected = new Set<string>();
  for (const r of rows) {
    const v = r['resolves'] as { taskId?: unknown; parts?: unknown; paths?: unknown; baseSha?: unknown } | null;
    if (!v || typeof v.taskId !== 'string' || !Array.isArray(v.parts) || !Array.isArray(v.paths) || typeof v.baseSha !== 'string') continue;
    if (String(r['status']) === 'rejected') {
      rejected.add(v.taskId);
      continue;
    }
    const parts = new Map<string, ResolvedPartRef>();
    for (const p of v.parts as ResolvedPartRef[]) parts.set(String(p.taskId), { taskId: String(p.taskId), revision: Number(p.revision), manifestSha256: String(p.manifestSha256), paths: (p.paths ?? []).map(String) });
    active.set(v.taskId, { taskId: v.taskId, baseSha: v.baseSha, paths: new Set(v.paths.map(String)), parts, createdAt: Number(r['at']) });
  }
  for (const id of rejected) active.delete(id);
  return { active, rejected };
}

/**
 * A resolution applies only while it matches exactly what it was created for: every resolved part still has the same revision,
 * manifest and path set, and main has not changed any path the resolution touches since its base. Otherwise it is stale and
 * dropped entirely. Of valid resolutions that share a path, the most recently created wins (ties by task id).
 */
function activeResolutions(ordered: readonly LoadedPart[], moved: ReadonlyMap<string, ReadonlySet<string>>): LoadedPart[] {
  const workers = new Map(ordered.filter((p) => p.resolution === null).map((p) => [p.taskId, p]));
  const valid = ordered.filter((p) => {
    const r = p.resolution;
    if (r === null) return false;
    for (const ref of r.parts.values()) {
      const w = workers.get(ref.taskId);
      if (!w || w.revision !== ref.revision || w.manifestSha256 !== ref.manifestSha256 || [...w.paths].sort(cmp).join('\0') !== [...ref.paths].sort(cmp).join('\0')) return false;
    }
    const mv = moved.get(p.baseSha);
    return !p.paths.some((x) => mv?.has(canon(x)));
  });
  valid.sort((a, b) => b.resolution!.createdAt - a.resolution!.createdAt || cmp(b.taskId, a.taskId));
  const claimed = new Set<string>();
  const keep = new Set<string>();
  for (const p of valid) {
    if (p.paths.some((x) => claimed.has(x))) continue;
    keep.add(p.taskId);
    for (const x of p.paths) claimed.add(x);
  }
  return ordered.filter((p) => p.resolution === null || keep.has(p.taskId));
}

function parseManifest(raw: unknown): { taskId: string; revision: number; baseSha: string; changes: ManifestChange[] } {
  const bad = (why: string): never => {
    throw new Fail('manifest_invalid', why);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('manifest is not an object');
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== 1) bad('unsupported manifest schema');
  if (typeof m['taskId'] !== 'string' || typeof m['baseSha'] !== 'string' || !Number.isInteger(m['revision'])) bad('manifest identity fields are missing');
  if (!Array.isArray(m['changes'])) return bad('manifest has no change list');
  if (m['changes'].length > MAX_CHANGES) bad('manifest lists too many changes');
  const seen = new Set<string>();
  const changes: ManifestChange[] = [];
  for (const c of m['changes'] as unknown[]) {
    if (typeof c !== 'object' || c === null) return bad('change entry is not an object');
    const e = c as Record<string, unknown>;
    if (typeof e['path'] !== 'string') return bad('change has no path');
    if (e['status'] !== 'added' && e['status'] !== 'modified' && e['status'] !== 'deleted') return bad(`change ${clip(e['path'], 80)} has an unknown status`);
    const kind = e['kind'] ?? null;
    if (kind !== null && kind !== 'file' && kind !== 'symlink' && kind !== 'special') return bad(`change ${clip(e['path'], 80)} has an unknown kind`);
    const hash = e['sha256'] ?? null;
    if (hash !== null && (typeof hash !== 'string' || !HEX64.test(hash))) return bad(`change ${clip(e['path'], 80)} has a malformed hash`);
    const link = e['linkTarget'] ?? null;
    if (link !== null && typeof link !== 'string') return bad(`change ${clip(e['path'], 80)} has a malformed link target`);
    if (seen.has(e['path'])) return bad(`path listed twice: ${clip(e['path'], 80)}`);
    seen.add(e['path']);
    changes.push({ path: e['path'], status: e['status'], kind, sha256: hash, linkTarget: link, bytes: null });
  }
  return { taskId: m['taskId'] as string, revision: m['revision'] as number, baseSha: m['baseSha'] as string, changes: changes.sort((a, b) => cmp(a.path, b.path)) };
}

async function readVerified(store: ArtifactStore, hash: string, missing: FailureReason): Promise<Uint8Array> {
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(hash);
  } catch (err) {
    if (err instanceof ArtifactIntegrityError) throw new Fail('manifest_corrupt', `artifact ${hash.slice(0, 12)} does not match its hash`);
    throw new Fail('artifact_unreadable', `artifact ${hash.slice(0, 12)} could not be read`);
  }
  if (bytes === null) throw new Fail(missing, `artifact ${hash.slice(0, 12)} does not exist`);
  // The store verifies on read; an implementation that does not is still held to it.
  if (sha256(bytes) !== hash) throw new Fail('manifest_corrupt', `artifact ${hash.slice(0, 12)} does not match its hash`);
  return bytes;
}

interface CompletedTask {
  readonly spec: TaskSpec;
  readonly attemptId: string;
  readonly manifest: string;
}

/**
 * Specs of every task in the run (current revisions), and the completed ones with a published change set. A completed attempt waits
 * for its verdict with outcome `running` (but an end time); verification then closes it as `succeeded`.
 */
async function loadTasks(db: Db, run: IntegrationRun): Promise<{ specs: Map<string, TaskSpec>; completed: CompletedTask[] }> {
  const rows = await db.execute(sql`
    SELECT r.spec, s.status,
      (SELECT a.attempt_id FROM attempts a WHERE a.tenant_id = r.tenant_id AND a.project_id = r.project_id AND a.task_id = r.task_id AND a.revision = r.revision
         AND a.outcome IN ('running', 'succeeded') AND a.ended_at IS NOT NULL AND a.detail ->> 'changeManifestSha256' IS NOT NULL ORDER BY a.attempt_number DESC LIMIT 1) AS attempt_id,
      (SELECT a.detail ->> 'changeManifestSha256' FROM attempts a WHERE a.tenant_id = r.tenant_id AND a.project_id = r.project_id AND a.task_id = r.task_id AND a.revision = r.revision
         AND a.outcome IN ('running', 'succeeded') AND a.ended_at IS NOT NULL AND a.detail ->> 'changeManifestSha256' IS NOT NULL ORDER BY a.attempt_number DESC LIMIT 1) AS manifest
    FROM task_revisions r JOIN task_status s ON s.tenant_id = r.tenant_id AND s.project_id = r.project_id AND s.task_id = r.task_id AND s.current_revision = r.revision
    WHERE r.tenant_id = ${run.tenantId} AND r.project_id = ${run.projectId} AND r.run_id = ${run.runId}
    ORDER BY r.task_id`);
  const specs = new Map<string, TaskSpec>();
  const completed: CompletedTask[] = [];
  for (const row of rows) {
    const parsed = TaskSpecSchema.safeParse(row['spec']);
    if (!parsed.success) throw new Fail('task_spec_invalid', 'a stored task spec is no longer valid');
    specs.set(parsed.data.taskId, parsed.data);
    const done = ['verifying', 'verified', 'merged'].includes(String(row['status']));
    if (done && row['attempt_id'] && row['manifest']) completed.push({ spec: parsed.data, attemptId: String(row['attempt_id']), manifest: String(row['manifest']) });
  }
  return { specs, completed };
}

async function loadPart(done: CompletedTask, run: IntegrationRun, store: ArtifactStore, prefixes: readonly string[], resolution: Resolution | undefined): Promise<LoadedPart> {
  const { spec } = done;
  const id = spec.taskId;
  if (!HEX64.test(done.manifest)) throw new Fail('manifest_invalid', `task ${id}: change manifest id is malformed`);
  const bytes = await readVerified(store, done.manifest, 'manifest_missing');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Fail('manifest_invalid', `task ${id}: manifest is not JSON`);
  }
  const m = (() => {
    try {
      return parseManifest(raw);
    } catch (err) {
      if (err instanceof Fail) throw new Fail(err.reason, `task ${id}: ${err.message}`);
      throw err;
    }
  })();
  // Replay protection: this manifest must be for exactly this task, this revision and the run's pinned base.
  if (m.taskId !== spec.taskId) throw new Fail('manifest_identity', `task ${id}: manifest is for task ${clip(m.taskId, 60)}`);
  if (m.revision !== spec.revision) throw new Fail('manifest_identity', `task ${id}: manifest is for revision ${m.revision}, current is ${spec.revision}`);
  // A worker manifest names the run's pinned base. A resolution task is created later, on the tip at that time, and names that.
  const expectedBase = resolution ? resolution.baseSha : run.pinnedBaseSha;

  if (m.baseSha !== spec.baseSha || m.baseSha !== expectedBase) throw new Fail('manifest_identity', `task ${id}: manifest base ${clip(m.baseSha, 12)} is not the pinned base`);

  for (const c of m.changes) {
    const problem = unsafePathProblem(c.path);
    if (problem !== null) throw new Fail('path_rejected', `task ${id}: ${clip(c.path, 80)}: ${problem}`);
    // Attributes and submodule maps change how git treats other files; only the trusted base may define them.
    const leaf = canon(c.path.split('/').pop()!);
    if (leaf === '.gitattributes' || leaf === '.gitmodules') throw new Fail('path_rejected', `task ${id}: ${clip(c.path, 80)} may not be changed by a worker`);
    if (resolution && !resolution.paths.has(c.path)) throw new Fail('path_rejected', `task ${id}: ${clip(c.path, 80)} is outside the paths its resolution proposal recorded`);
    if (isProtected(c.path, prefixes)) throw new Fail('protected_path', `task ${id}: ${clip(c.path, 80)} is a verifier or contract path`);
  }
  const asChanges: FileChange[] = m.changes.map((c) => ({ path: c.path, status: c.status, kind: c.kind, sha256: c.sha256, linkTarget: c.linkTarget }));
  let gate: ReturnType<typeof checkAllowedPaths>;
  try {
    gate = checkAllowedPaths(asChanges, spec.allowedPaths);
  } catch (err) {
    throw new Fail('path_rejected', `task ${id}: ${err instanceof Error ? clip(err.message, 160) : 'invalid allowedPaths'}`);
  }
  if (!gate.ok) {
    const shown = gate.violations.slice(0, 3).map((v) => `${clip(v.path, 60)} (${v.reason})`).join(', ');
    throw new Fail('path_rejected', `task ${id}: ${gate.violations.length} path(s) rejected: ${shown}`);
  }
  for (const c of m.changes) {
    if (c.status === 'deleted') {
      if (c.kind !== null || c.sha256 !== null) throw new Fail('manifest_invalid', `task ${id}: deleted ${clip(c.path, 60)} carries content`);
      continue;
    }
    if (c.kind !== 'file' || c.sha256 === null) throw new Fail('manifest_invalid', `task ${id}: ${clip(c.path, 60)} is not a regular file with a hash`);
    c.bytes = await readVerified(store, c.sha256, 'content_missing');
  }
  return { taskId: id, revision: spec.revision, attemptId: done.attemptId, manifestSha256: done.manifest, paths: m.changes.map((c) => c.path), spec, changes: m.changes, baseSha: m.baseSha, resolution: resolution ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ordering

/** Dependency order: a task comes after everything it depends on (directly or through other tasks); ties go to the smaller id. */
function orderParts(parts: readonly LoadedPart[], specs: ReadonlyMap<string, TaskSpec>): { ordered: LoadedPart[]; reaches: (from: string, to: string) => boolean } {
  const reachCache = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const hit = reachCache.get(from);
    if (hit) return hit;
    const seen = new Set<string>();
    const stack = [...(specs.get(from)?.dependencies ?? []).map((d) => d.taskId)];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      for (const d of specs.get(t)?.dependencies ?? []) stack.push(d.taskId);
    }
    reachCache.set(from, seen);
    return seen;
  };
  const dependsOn = (a: string, b: string): boolean => reachable(a).has(b);
  const remaining = new Map(parts.map((p) => [p.taskId, p]));
  const ordered: LoadedPart[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((t) => ![...remaining.keys()].some((o) => o !== t && dependsOn(t, o))).sort(cmp);
    if (ready.length === 0) throw new Fail('dependency_cycle', `tasks depend on each other: ${[...remaining.keys()].sort(cmp).join(', ')}`);
    const next = remaining.get(ready[0]!)!;
    ordered.push(next);
    remaining.delete(next.taskId);
  }
  return { ordered, reaches: (a, b) => dependsOn(a, b) || dependsOn(b, a) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Git

const baseEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'SelariKru Integration',
  GIT_AUTHOR_EMAIL: 'integration@selarikru.invalid',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_NAME: 'SelariKru Integration',
  GIT_COMMITTER_EMAIL: 'integration@selarikru.invalid',
  GIT_COMMITTER_DATE: FIXED_DATE,
});
const SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true', '-c', 'core.ignorecase=false', '-c', 'core.precomposeunicode=false', '-c', 'core.excludesFile=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=never'];

async function git(cwd: string, home: string, args: readonly string[], opts: { allowFile?: boolean } = {}): Promise<string> {
  const config = opts.allowFile ? SAFE_CONFIG.map((v) => (v === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : v)) : SAFE_CONFIG;
  try {
    const { stdout } = await execFileP('git', [...config, ...args], { cwd, env: baseEnv(home), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Fail('git_failed', `git ${args[0]} failed: ${clip((e.stderr || e.message || 'error').trim(), 200)}`);
  }
}

async function cloneAtBase(repoPath: string, baseSha: string, dir: string, home: string, otherBases: readonly string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, home, ['init', '--quiet', '--template=', '.']);
  try {
    await git(dir, home, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', repoPath, baseSha, ...otherBases], { allowFile: true });
    await git(dir, home, ['checkout', '--quiet', '--detach', baseSha]);
    const head = await git(dir, home, ['rev-parse', 'HEAD']);
    if (head !== baseSha) throw new Fail('base_unavailable', `base ${baseSha.slice(0, 12)} resolved to a different commit`);
  } catch (err) {
    if (err instanceof Fail && err.reason === 'git_failed') throw new Fail('base_unavailable', `base ${baseSha.slice(0, 12)} cannot be checked out: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulation and exact-byte commit

interface Planned {
  taskId: string;
  sha: string | null;
  bytes: Uint8Array | null;
}

interface BaseEntry {
  readonly mode: string;
  readonly blob: string;
}

async function gitIn(cwd: string, home: string, args: readonly string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: baseEnv(home) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => reject(new Fail('git_failed', `git ${args[0]} could not start: ${clip(e.message, 120)}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
      else reject(new Fail('git_failed', `git ${args[0]} failed: ${clip(Buffer.concat(err).toString('utf8').trim(), 200)}`));
    });
    child.stdin.end(input);
  });
}

function parseTree(out: string): Map<string, BaseEntry> {
  const m = new Map<string, BaseEntry>();
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    const [mode, , blob] = rec.slice(0, tab).split(' ');
    m.set(rec.slice(tab + 1), { mode: mode!, blob: blob! });
  }
  return m;
}

const gitBlobSha = (bytes: Uint8Array): string => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

/** Paths (canonical) that differ between two commits on the target. */
async function changedBetween(tree: string, home: string, from: string, to: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (from === to) return out;
  const raw = await git(tree, home, ['diff', '--name-status', '-z', '--no-renames', from, to]);
  const toks = raw.split('\0').filter((t) => t !== '');
  for (let i = 0; i + 1 < toks.length; i += 2) out.add(canon(toks[i + 1]!));
  return out;
}

async function assertNoLinkAncestors(root: string, path: string): Promise<void> {
  const segs = path.split('/');
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    cur = join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new Fail('apply_failed', `${clip(path, 80)}: ${clip(seg, 40)} is a symbolic link in the base tree`);
    if (!st.isDirectory()) throw new Fail('apply_failed', `${clip(path, 80)}: ${clip(seg, 40)} is a file in the base tree`);
  }
}

/** The tree state of `path` in the clone: absent, or a regular file with its hash. Anything else cannot be changed safely. */
async function baseState(root: string, path: string): Promise<{ exists: false } | { exists: true; sha: string }> {
  await assertNoLinkAncestors(root, path);
  let st;
  try {
    st = await lstat(join(root, path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
    throw err;
  }
  if (!st.isFile()) throw new Fail('apply_failed', `${clip(path, 80)} is not a regular file in the base tree`);
  return { exists: true, sha: sha256(await readFile(join(root, path))) };
}

interface PlanContext {
  readonly base: ReadonlyMap<string, BaseEntry>;
  /** For each part base other than the clone's: canonical paths main changed since. */
  readonly moved: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every prefix of every base path, canonical key to the spellings the base uses. */
  readonly baseSpellings: ReadonlyMap<string, ReadonlySet<string>>;
}

function spellingsOf(base: ReadonlyMap<string, BaseEntry>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const path of base.keys()) {
    const segs = path.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const pre = segs.slice(0, i).join('/');
      const key = canon(pre);
      const set = m.get(key) ?? new Set<string>();
      set.add(pre);
      m.set(key, set);
    }
  }
  return m;
}

/**
 * Decides, without writing, what the tree becomes. Change sets are post-images only, built against the task's own base by a
 * worker that never saw anyone else's edits, so two tasks changing one path to different content is a conflict (ordered or not),
 * and so is a path main changed since the part's base. A completed resolution task (recorded in a plan proposal) wins only the
 * conflicts it was created for.
 */
async function plan(root: string, ordered: readonly LoadedPart[], ctx: PlanContext): Promise<Map<string, Planned>> {
  const overlay = new Map<string, Planned>();
  const writers = new Map<string, Map<string, string | null>>();
  const conflicts = new Map<string, { kind: Conflict['kind']; ids: Set<string> }>();
  const spelled = new Map<string, { names: Set<string>; tasks: Set<string> }>();
  const note = (path: string, kind: Conflict['kind'], ...ids: string[]): void => {
    const hit = conflicts.get(path);
    if (hit) for (const i of ids) hit.ids.add(i);
    else conflicts.set(path, { kind, ids: new Set(ids) });
  };

  const handle = async (part: LoadedPart, c: ManifestChange): Promise<void> => {
    const finalSha = c.status === 'deleted' ? null : c.sha256;
    if (conflicts.has(c.path)) {
      conflicts.get(c.path)!.ids.add(part.taskId);
      return;
    }
    // Case and Unicode collisions: every prefix, against the base tree and against other changes.
    const segs = c.path.split('/');
    const collided = new Set<string>();
    for (let i = 1; i <= segs.length; i++) {
      const pre = segs.slice(0, i).join('/');
      const key = canon(pre);
      const b = ctx.baseSpellings.get(key);
      if (b && [...b].some((n) => n !== pre)) collided.add(part.taskId);
      let r = spelled.get(key);
      if (!r) spelled.set(key, (r = { names: new Set(), tasks: new Set() }));
      if ([...r.names].some((n) => n !== pre)) for (const t of r.tasks) collided.add(t);
      if ([...r.names].some((n) => n !== pre)) collided.add(part.taskId);
      r.names.add(pre);
      r.tasks.add(part.taskId);
    }
    if (collided.size > 0) return note(c.path, 'path_collision', ...collided, part.taskId);
    if (ctx.moved.get(part.baseSha)?.has(canon(c.path))) return note(c.path, 'base_moved', part.taskId);

    const ws = writers.get(c.path);
    if (ws && [...ws].some(([t, sh]) => t !== part.taskId && sh !== finalSha)) return note(c.path, 'overlap', ...ws.keys(), part.taskId);

    const prior = overlay.get(c.path);
    if (prior && prior.taskId !== part.taskId && prior.sha === finalSha) {
      // Both tasks reach the same result (including two deletes of one file): they agree.
      ws!.set(part.taskId, finalSha);
      return;
    }
    const cur = prior ? (prior.sha === null ? ({ exists: false } as const) : ({ exists: true, sha: prior.sha } as const)) : await baseState(root, c.path);
    const applies = c.status === 'added' ? !cur.exists || prior !== undefined || cur.sha === finalSha : cur.exists;
    if (!applies) return note(c.path, 'does_not_apply', part.taskId);
    overlay.set(c.path, { taskId: part.taskId, sha: finalSha, bytes: c.bytes });
    const w = ws ?? new Map<string, string | null>();
    w.set(part.taskId, finalSha);
    writers.set(c.path, w);
  };

  for (const part of ordered.filter((p) => p.resolution === null)) for (const c of part.changes) await handle(part, c);

  for (const part of ordered.filter((p) => p.resolution !== null)) {
    for (const c of part.changes) {
      const cf = conflicts.get(c.path);
      const resolvable = cf !== undefined && cf.kind !== 'path_collision' && [...cf.ids].every((i) => part.resolution!.parts.has(i));
      if (!resolvable) {
        await handle(part, c);
        continue;
      }
      conflicts.delete(c.path);
      writers.delete(c.path);
      if (c.status === 'deleted') {
        if (ctx.base.has(c.path)) overlay.set(c.path, { taskId: part.taskId, sha: null, bytes: null });
        else overlay.delete(c.path);
      } else {
        await baseState(root, c.path);
        overlay.set(c.path, { taskId: part.taskId, sha: c.sha256, bytes: c.bytes });
        writers.set(c.path, new Map([[part.taskId, c.sha256]]));
      }
    }
  }

  if (conflicts.size > 0) {
    const list: Conflict[] = [...conflicts.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([path, v]) => ({ path, kind: v.kind, taskIds: [...v.ids].sort(cmp) }));
    throw new Fail('conflict', `${list.length} conflicting path(s): ${list.slice(0, 5).map((x) => x.path).join(', ')}`, { conflicts: list, parts: ordered.map((p) => ({ taskId: p.taskId, revision: p.revision, manifestSha256: p.manifestSha256, paths: [...p.paths].sort(cmp) })) });
  }
  return overlay;
}

/**
 * Builds the commit with filter-free plumbing so the committed blobs are byte-for-byte the manifest contents, whatever
 * `.gitattributes` or filters say, then verifies the whole resulting tree against the base plus the planned changes.
 */
async function commitOverlay(tree: string, home: string, workDir: string, base: ReadonlyMap<string, BaseEntry>, overlay: ReadonlyMap<string, Planned>, baseSha: string, msgFile: string): Promise<{ sha: string; treeSha: string }> {
  const paths = [...overlay.keys()].sort(cmp);
  const files = paths.filter((p) => overlay.get(p)!.sha !== null);
  const blobDir = join(workDir, 'blobs');
  await mkdir(blobDir);
  for (const [i, p] of files.entries()) await writeFile(join(blobDir, String(i)), overlay.get(p)!.bytes!);
  const hashes = files.length > 0 ? (await gitIn(tree, home, ['hash-object', '-w', '--no-filters', '--stdin-paths'], `${files.map((_, i) => join(blobDir, String(i))).join('\n')}\n`)).split('\n') : [];
  const blobOf = new Map<string, string>();
  for (const [i, p] of files.entries()) {
    if (hashes[i] !== gitBlobSha(overlay.get(p)!.bytes!)) throw new Fail('git_failed', `blob for ${clip(p, 80)} does not match its content`);
    blobOf.set(p, hashes[i]!);
  }
  const lines = paths.map((p) => (overlay.get(p)!.sha === null ? `0 ${'0'.repeat(40)} 0\t${p}\0` : `${base.get(p)?.mode ?? '100644'} ${blobOf.get(p)!} 0\t${p}\0`));
  if (lines.length > 0) await gitIn(tree, home, ['update-index', '--add', '--remove', '-z', '--index-info'], lines.join(''));
  const treeSha = await git(tree, home, ['write-tree']);
  const expected = new Map([...base].map(([p, e]) => [p, `${e.mode} ${e.blob}`]));
  for (const p of paths) {
    if (overlay.get(p)!.sha === null) expected.delete(p);
    else expected.set(p, `${base.get(p)?.mode ?? '100644'} ${blobOf.get(p)!}`);
  }
  const actual = parseTree(await git(tree, home, ['ls-tree', '-r', '-z', treeSha]));
  if (actual.size !== expected.size || [...expected].some(([p, v]) => { const a = actual.get(p); return a === undefined || `${a.mode} ${a.blob}` !== v; })) {
    throw new Fail('git_failed', 'the committed tree differs from the base plus the manifests');
  }
  const sha = await git(tree, home, ['commit-tree', treeSha, '-p', baseSha, '-F', msgFile]);
  await git(tree, home, ['update-ref', 'refs/selarikru/candidate', sha]);
  return { sha, treeSha };
}

// ---------------------------------------------------------------------------------------------------------------------
// Database

async function acquireLease(db: Db, run: IntegrationRun, holder: string, seconds: number): Promise<boolean> {
  // The database clock decides expiry, so hosts with skewed clocks cannot both believe they hold the lease.
  const rows = await db.execute(sql`
    INSERT INTO integration_leases (tenant_id, project_id, target, holder, acquired_at, expires_at)
    VALUES (${run.tenantId}, ${run.projectId}, ${run.target}, ${holder}, now(), now() + make_interval(secs => ${seconds}))
    ON CONFLICT (tenant_id, project_id, target) DO UPDATE
      SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
      WHERE integration_leases.expires_at <= now()
    RETURNING holder`);
  return rows.length === 1 && String(rows[0]!['holder']) === holder;
}

/** Extends the lease only while this holder still owns an unexpired one. */
async function renewLease(db: Db, run: IntegrationRun, holder: string, seconds: number): Promise<boolean> {
  const rows = await db.execute(sql`
    UPDATE integration_leases SET expires_at = now() + make_interval(secs => ${seconds})
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND target = ${run.target} AND holder = ${holder} AND expires_at > now()
    RETURNING holder`);
  return rows.length === 1;
}

/** Fences a write: locks this holder's unexpired lease row for the rest of the transaction, or throws `lease_lost`. */
async function fence(tx: Tx, run: IntegrationRun, holder: string): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT holder FROM integration_leases
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND target = ${run.target} AND holder = ${holder} AND expires_at > now() FOR UPDATE`);
  if (rows.length !== 1) throw new Fail('lease_lost', 'the integration lease was lost or expired before the result could be published');
}

async function releaseLease(db: Db, run: IntegrationRun, holder: string): Promise<void> {
  await db.execute(sql`DELETE FROM integration_leases WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND target = ${run.target} AND holder = ${holder}`);
}

const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** This run's tasks waiting for a verdict. They go into the same candidate, so a claim one of them holds is not another run's. */
async function tasksBeingBuilt(tx: Tx, run: IntegrationRun): Promise<string[]> {
  const rows = await tx.execute(sql`SELECT s.task_id FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision WHERE s.tenant_id = ${run.tenantId} AND s.project_id = ${run.projectId} AND r.run_id = ${run.runId} AND s.status = 'verifying'`);
  return rows.map((r) => String(r['task_id']));
}

/** The first verified part of a to-be-rebuilt candidate that could not take its claims back. Other parts of that candidate holding the claim is no conflict. Takes the scheduler lock. */
async function rebuildClaimConflict(tx: Tx, run: IntegrationRun, building: readonly string[]): Promise<{ readonly taskId: string; readonly resourceKey: string } | null> {
  const rows = await tx.execute(sql`SELECT parts FROM candidates WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND target = ${run.target} AND status IN ('assembled', 'rejected') AND sha IS NOT NULL AND base_sha <> ${run.currentBaseSha} FOR UPDATE`);
  if (rows.length === 0) return null;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`);
  const parts = rows.flatMap((r) => (r['parts'] as { taskId: string; revision: number }[]) ?? []);
  const own = new Set([...building, ...parts.map((p) => p.taskId)]);
  for (const part of [...parts].sort((a, b) => cmp(a.taskId, b.taskId))) {
    const [row] = await tx.execute(sql`SELECT s.status, r.spec FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision WHERE s.tenant_id = ${run.tenantId} AND s.project_id = ${run.projectId} AND s.task_id = ${part.taskId} AND s.current_revision = ${part.revision}`);
    if (row?.['status'] !== 'verified') continue;
    const spec = TaskSpecSchema.parse(row['spec']);
    for (const claim of spec.resourceClaims) {
      const live = await tx.execute(sql`SELECT task_id, mode FROM resource_claims WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND resource_key = ${claim.key} AND released_at IS NULL`);
      if (live.some((h) => !own.has(String(h['task_id'])) && (claim.mode === 'exclusive' || h['mode'] === 'exclusive'))) return { taskId: part.taskId, resourceKey: claim.key };
    }
  }
  return null;
}

/** Marks candidates, their check runs and any approval bound to their SHA as invalidated, in the caller's transaction. */
async function invalidate(tx: Tx, run: IntegrationRun, reason: Invalidation['reason'], keep: { baseNot?: string; shaNot?: string }, now: Date, alsoOwn: readonly string[] = []): Promise<Invalidation | undefined> {
  const where = keep.baseNot !== undefined ? sql`base_sha <> ${keep.baseNot}` : sql`sha <> ${keep.shaNot!}`;
  const rows = await tx.execute(sql`
    UPDATE candidates SET status = 'invalidated', reason = ${reason}, updated_at = ${now.toISOString()}::timestamptz
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND target = ${run.target} AND status IN ('assembled', 'rejected') AND sha IS NOT NULL AND ${where}
    RETURNING candidate_id, sha, parts`);
  if (rows.length === 0) return undefined;
  const shas = rows.map((r) => String(r['sha']));
  const checks = await tx.execute(sql`
    UPDATE check_runs SET result = 'invalidated'
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_sha IN (${inList(shas)}) AND result <> 'invalidated'
    RETURNING check_run_id`);
  const approvals = await tx.execute(sql`
    UPDATE approvals SET outcome = 'invalidated'
    WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND outcome IN ('pending', 'granted') AND expected_revisions ->> 'candidateSha' IN (${inList(shas)})
    RETURNING approval_id`);
  // Evidence is gone, so readiness is too. Every part this evidence had verified goes back through the domain transition to `verifying`
  // (claims re-acquired; `blocked` when they cannot be), the run leaves review, and each change is recorded in this same transaction.
  const reopened: string[] = [];
  if (rows.length > 0) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`); // same lock as claiming
  const candidateIds = rows.map((r) => String(r['candidate_id'])).sort(cmp);
  for (const r of rows) {
    for (const part of (r['parts'] as { taskId: string; revision: number; attemptId: string }[]) ?? []) {
      const key = { tenantId: run.tenantId, projectId: run.projectId, taskId: part.taskId };
      const row = await lockStatusRow(tx, key);
      if (!row || row.currentRevision !== part.revision || row.status !== 'verified') continue;
      const rev = await tx.execute(sql`SELECT spec FROM task_revisions WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND task_id = ${part.taskId} AND revision = ${part.revision}`);
      const spec = TaskSpecSchema.parse(rev[0]!['spec']);
      const attempts = await loadAttempts(tx, key, part.revision);
      const state = buildTaskState(spec, row.status as TaskStatus, attempts);
      if (!state) throw new Error(`task ${part.taskId}: stored spec no longer valid`);
      const want = new Map<string, 'shared' | 'exclusive'>();
      for (const c of spec.resourceClaims) if (want.get(c.key) !== 'exclusive') want.set(c.key, c.mode);
      let conflict: string | undefined;
      if (want.size > 0) {
        // The candidate's own parts are coming back together: their claims never conflict with each other, and one row held for a key is enough for all of them.
        const own = [...alsoOwn, ...rows.flatMap((c) => ((c['parts'] as { taskId: string }[]) ?? []).map((p) => p.taskId))];
        const live = await tx.execute(sql`SELECT resource_key, mode, task_id FROM resource_claims WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND resource_key IN (${inList([...want.keys()])}) AND released_at IS NULL`);
        conflict = [...want].find(([k, m]) => live.some((h) => h['resource_key'] === k && !own.includes(String(h['task_id'])) && (m === 'exclusive' || h['mode'] === 'exclusive')))?.[0];
        for (const k of live) if (own.includes(String(k['task_id']))) want.delete(String(k['resource_key']));
      }
      const moved = transition(state, { type: 'verification_invalidated', ...(conflict !== undefined ? { blockedReason: `resource_conflict:${conflict}` } : {}) });
      if (!moved.ok) throw new Error(`illegal reopen transition: ${JSON.stringify(moved.error)}`);
      for (const rec of moved.value.attempts) {
        const stored = attempts.find((a) => a.attemptId === rec.attemptId);
        if (stored && stored.outcome !== rec.outcome) await tx.execute(sql`UPDATE attempts SET outcome = ${rec.outcome} WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND attempt_id = ${rec.attemptId}`);
      }
      if (conflict === undefined) {
        for (const [resourceKey, mode] of want) {
          await tx.execute(sql`
            INSERT INTO resource_claims (tenant_id, project_id, claim_id, task_id, revision, resource_key, mode, attempt_id)
            VALUES (${run.tenantId}, ${run.projectId}, ${`clm_${randomUUID()}`}, ${part.taskId}, ${part.revision}, ${resourceKey}, ${mode}, ${part.attemptId})`);
        }
      }
      const aggregateRevision = await setStatus(tx, key, row.rowRevision, moved.value.status, now);
      // The re-verify lineage: this work was already judged and only main moved, so a failed verdict on the rebuild blocks it. No repair worker is started on its account.
      if (reason === 'base_changed') {
        await tx.execute(sql`INSERT INTO task_commands (tenant_id, project_id, operation_id, task_id, revision, command, state, requested_by, requested_at, detail)
          VALUES (${run.tenantId}, ${run.projectId}, ${`op_base_changed_${randomUUID()}`}, ${part.taskId}, ${part.revision}, 'reverify', 'applied', 'integration', ${now.toISOString()}::timestamptz, ${JSON.stringify({ attemptId: part.attemptId, reason })}::jsonb)`);
      }
      const scope = { projectId: run.projectId, runId: spec.runId, taskId: part.taskId, aggregateRevision };
      await emit(tx, scope, now, {
        type: 'task.reopened', attemptId: part.attemptId, actor: INTEGRATION_ACTOR,
        payload: { reason, candidateIds, status: moved.value.status, ...(conflict !== undefined ? { blocked: `resource_conflict:${conflict}` } : {}) },
      });
      if (conflict !== undefined) await emit(tx, scope, now, { type: 'task.blocked', attemptId: part.attemptId, actor: SCHEDULER_ACTOR, payload: { reason: `resource_conflict:${conflict}` } });
      reopened.push(part.taskId);
    }
  }
  const reverted = await tx.execute(sql`
    UPDATE runs SET lifecycle = 'running' WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId} AND lifecycle = 'ready_for_review' RETURNING run_id`);
  if (reverted.length > 0) await emitCandidate(tx, run, now, 'run.reverted', { reason, candidateIds, reopenedTasks: [...new Set(reopened)].sort(cmp) });
  return {
    reason,
    candidates: rows.map((r) => String(r['candidate_id'])).sort(cmp),
    checkRuns: checks.map((r) => String(r['check_run_id'])).sort(cmp),
    approvals: approvals.map((r) => String(r['approval_id'])).sort(cmp),
    ...(reopened.length > 0 ? { reopenedTasks: [...new Set(reopened)].sort(cmp) } : {}),
  };
}

async function emitCandidate(tx: Tx, run: IntegrationRun, now: Date, type: 'candidate.assembled' | 'candidate.failed' | 'run.reverted', payload: Record<string, unknown>): Promise<void> {
  const at = now.toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: run.projectId, runId: run.runId, taskId: run.runId, attemptId: null, type,
    sequence: 0, aggregateRevision: 0, actor: INTEGRATION_ACTOR, occurredAt: at, receivedAt: at, causationId: null, traceId: `trace_${randomUUID()}`, payload,
  };
  const authority = checkEventAuthority(envelope);
  if (!authority.ok) throw new Error(`integration emitted a forbidden event: ${JSON.stringify(authority.error)}`);
  await appendEvent(tx, envelope);
}

const CLASSIFICATION_RANK = ['public', 'internal', 'restricted', 'secret'] as const;

/** One targeted task that owns exactly the conflicting paths, proposed as a plan revision. Never applied here. */
function buildResolution(run: IntegrationRun, conflicts: readonly Conflict[], specs: ReadonlyMap<string, TaskSpec>, parts: readonly ResolvedPartRef[]): TaskSpec {
  const involved = [...new Set(conflicts.flatMap((c) => c.taskIds))].sort(cmp).map((id) => specs.get(id)!);
  const template = involved[0]!;
  const taskId = `resolve_${sha256(JSON.stringify([run.runId, run.currentBaseSha, conflicts, parts])).slice(0, 12)}`;
  const classification = involved.reduce<TaskSpec['classification']>((hi, s) => (CLASSIFICATION_RANK.indexOf(s.classification) > CLASSIFICATION_RANK.indexOf(hi) ? s.classification : hi), 'public');
  const paths = conflicts.map((c) => c.path);
  const contractRefs = new Map(involved.flatMap((s) => s.contractRefs).map((r) => [`${r.artifactId}:${r.sha256}`, r]));
  return TaskSpecSchema.parse({
    ...template,
    taskId,
    revision: 1,
    role: 'integration',
    title: clip(`Resolve integration conflict: ${paths.join(', ')}`, 120),
    baseSha: run.currentBaseSha,
    requirementIds: [...new Set(involved.flatMap((s) => s.requirementIds))].sort(cmp),
    dependencies: [],
    contractRefs: [...contractRefs.values()].sort((a, b) => cmp(a.artifactId, b.artifactId)),
    allowedPaths: paths,
    resourceClaims: [],
    acceptanceCheckIds: [...new Set(involved.flatMap((s) => s.acceptanceCheckIds))].sort(cmp),
    classification,
  });
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Assembles the candidate for `run` under the single integration lease for (project, target). Returns the candidate, or a
 * failure with a named reason. A failure leaves no commit and no partial tree; it is recorded as a `candidates` row
 * and a `candidate.failed` event. If the pinned base differs from the target's current tip, the earlier candidate and its
 * evidence are invalidated first and the candidate is rebuilt on the current tip (paths main changed become conflicts).
 * Every write is fenced on the lease: a holder that lost or outlived it publishes nothing.
 */
export async function assembleCandidate(run: IntegrationRun, deps: IntegrationDeps): Promise<AssemblyResult> {
  const now = deps.now ?? (() => new Date());
  if (!FULL_SHA.test(run.pinnedBaseSha) || !FULL_SHA.test(run.currentBaseSha) || run.target === '') {
    return { ok: false, reason: 'invalid_request', message: 'pinned and current base must be full commit ids and a target is required' };
  }
  const holder = `integration:${randomUUID()}`;
  const startedAt = now();
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS;
  if (!(await acquireLease(deps.db, run, holder, leaseSeconds))) {
    return { ok: false, reason: 'lease_held', message: `another assembly holds the integration lease for ${run.target}` };
  }
  let lost = false;
  const renewer = setInterval(() => {
    renewLease(deps.db, run, holder, leaseSeconds).then((ok) => { if (!ok) lost = true; }, () => undefined);
  }, Math.max(100, (leaseSeconds * 1000) / 3));
  renewer.unref();
  const alive = (): void => {
    if (lost) throw new Fail('lease_lost', 'the integration lease was lost during assembly');
  };
  let workDir: string | null = null;
  let keep = false;
  let invalidated: Invalidation | undefined;
  try {
    try {
      if (deps.stillDue && !(await deps.stillDue())) return { ok: false, reason: 'not_due', message: 'nothing is due to assemble' };
      if (run.pinnedBaseSha !== run.currentBaseSha || run.baseMoved === true) {
        // Checked before any write, under the claiming lock: a part sent back blocked would drop out of the rebuild, and a partial tree would be judged.
        const held = await withTx(deps.db, async (tx) => {
          await fence(tx, run, holder);
          const building = await tasksBeingBuilt(tx, run);
          const conflict = await rebuildClaimConflict(tx, run, building);
          if (conflict) return conflict;
          invalidated = await invalidate(tx, run, 'base_changed', { baseNot: run.currentBaseSha }, now(), building);
          return null;
        });
        if (held) return { ok: false, reason: 'rebuild_deferred', message: `waiting for ${held.resourceKey}, held by another task, before ${held.taskId} can be rebuilt` };
      }
      const { specs, completed } = await loadTasks(deps.db, run);
      if (completed.length === 0) throw new Fail('no_parts', 'no completed task has a published change set');
      const { active: resolutions, rejected } = await loadResolutions(deps.db, run);
      const prefixes = protectedPrefixes(deps.protectedPaths);
      const loaded: LoadedPart[] = [];
      for (const done of completed.filter((d) => !rejected.has(d.spec.taskId))) loaded.push(await loadPart(done, run, deps.artifacts, prefixes, resolutions.get(done.spec.taskId)));
      const { ordered: allOrdered } = orderParts(loaded, specs);
      alive();

      const parent = deps.workRoot ?? join(tmpdir(), 'selarikru-integrate');
      await mkdir(parent, { recursive: true });
      workDir = await mkdtemp(join(parent, 'asm-'));
      const home = join(workDir, 'home');
      const tree = join(workDir, 'tree');
      await mkdir(home);
      const otherBases = [...new Set(allOrdered.map((p) => p.baseSha))].filter((b) => b !== run.currentBaseSha).sort(cmp);
      await cloneAtBase(run.repoPath, run.currentBaseSha, tree, home, otherBases);
      alive();
      const moved = new Map<string, Set<string>>();
      for (const b of otherBases) moved.set(b, await changedBetween(tree, home, b, run.currentBaseSha));
      const ordered = activeResolutions(allOrdered, moved);
      const base = parseTree(await git(tree, home, ['ls-tree', '-r', '-z', 'HEAD']));
      const overlay = await plan(tree, ordered, { base, moved, baseSpellings: spellingsOf(base) });
      alive();

      const message = [
        'integration candidate', '', `run: ${run.runId}`, `target: ${run.target}`, `base: ${run.currentBaseSha}`, 'parts:',
        ...ordered.map((p) => `- ${p.taskId}@${p.revision} ${p.manifestSha256}`), '',
      ].join('\n');
      const msgFile = join(workDir, 'message.txt');
      await writeFile(msgFile, message);
      const { sha, treeSha } = await commitOverlay(tree, home, workDir, base, overlay, run.currentBaseSha, msgFile);
      // The clone is temporary, so the commit is exported to a local ref in the source repository, where verification and a later
      // push step can reach it. Nothing is pushed anywhere else, and no branch moves.
      await git(run.repoPath, home, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', tree, `refs/selarikru/candidate:refs/selarikru/candidates/${sha}`], { allowFile: true });
      const parts: CandidatePart[] = ordered.map((p) => ({ taskId: p.taskId, revision: p.revision, attemptId: p.attemptId, manifestSha256: p.manifestSha256, paths: p.paths }));
      const candidateId = `cand_${sha}`;
      alive();
      await deps.beforePublish?.();

      const superseded = await withTx(deps.db, async (tx) => {
        await fence(tx, run, holder);
        const at = now();
        await recordIntegrationTime(tx, run, holder, startedAt, at);
        // The same commit can come back with new attempt bindings (an identical repair). Whatever was concluded about the earlier binding
      // is kept as history in `detail.history` but stops being evidence: its check runs are invalidated.
      const prior = await tx.execute(sql`SELECT status, parts IS DISTINCT FROM ${JSON.stringify(parts)}::jsonb AS changed FROM candidates WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_id = ${candidateId} FOR UPDATE`);
      if (prior[0] && (prior[0]['status'] !== 'assembled' || prior[0]['changed'] === true)) {
        await tx.execute(sql`UPDATE check_runs SET result = 'invalidated' WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_sha = ${sha} AND result <> 'invalidated'`);
      }
      await tx.execute(sql`
          INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status, reason, detail, updated_at)
          VALUES (${run.tenantId}, ${run.projectId}, ${candidateId}, ${run.runId}, ${run.target}, ${sha}, ${run.currentBaseSha}, ${treeSha}, ${JSON.stringify(parts)}::jsonb, 'assembled', NULL, '{}'::jsonb, ${at.toISOString()}::timestamptz)
          ON CONFLICT (tenant_id, project_id, candidate_id) DO UPDATE SET
            detail = CASE WHEN candidates.status = 'assembled' AND candidates.parts IS NOT DISTINCT FROM EXCLUDED.parts THEN candidates.detail
              ELSE (jsonb_set(candidates.detail, '{history}', COALESCE(candidates.detail -> 'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                'status', candidates.status, 'reason', candidates.reason, 'parts', candidates.parts, 'treeSha', candidates.tree_sha, 'rebuiltAt', EXCLUDED.updated_at)))) - 'verificationDriver' - 'verification' - 'verificationRetry' END,
            status = 'assembled', reason = NULL, parts = EXCLUDED.parts, tree_sha = EXCLUDED.tree_sha, base_sha = EXCLUDED.base_sha, updated_at = EXCLUDED.updated_at`);
        const sup = await invalidate(tx, run, 'superseded_by_new_candidate', { shaNot: sha }, at, parts.map((p) => p.taskId));
        await emitCandidate(tx, run, at, 'candidate.assembled', {
          candidateId, sha, baseSha: run.currentBaseSha, treeSha, target: run.target, parts: parts.map((p) => ({ taskId: p.taskId, revision: p.revision, manifestSha256: p.manifestSha256 })),
          ...(invalidated ? { invalidated } : {}), ...(sup ? { superseded: sup } : {}),
        });
        return sup;
      });
      keep = deps.keepClone === true;
      return {
        ok: true, candidateId, sha, baseSha: run.currentBaseSha, treeSha, parts,
        ...(invalidated ? { invalidated } : {}), ...(superseded ? { superseded } : {}), ...(keep ? { clonePath: tree } : {}),
      };
    } catch (err) {
      const fail = err instanceof Fail ? err : new Fail('git_failed', `unexpected error: ${err instanceof Error ? clip(err.message, 160) : 'error'}`);
      if (fail.reason === 'lease_lost') return { ok: false, reason: 'lease_lost', message: fail.message, ...(invalidated ? { invalidated } : {}) };
      if (deps.onInfrastructureFailure && INFRASTRUCTURE_FAILURES.has(fail.reason)) {
        await withTx(deps.db, (tx) => recordIntegrationTime(tx, run, holder, startedAt, now())).catch(() => undefined);
        await deps.onInfrastructureFailure({ reason: fail.reason, message: clip(fail.message, 400) });
        return { ok: false, reason: fail.reason, message: fail.message, deferred: true, ...(invalidated ? { invalidated } : {}) };
      }
      return await recordFailure(deps, run, holder, startedAt, now(), fail, invalidated);
    }
  } finally {
    clearInterval(renewer);
    if (workDir !== null && !keep) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await releaseLease(deps.db, run, holder).catch(() => undefined);
  }
}

/** The assembly's elapsed time on the host, once per assembly (`holder` is unique to it), success or failure. It is part of the host's total. */
async function recordIntegrationTime(tx: Tx, run: IntegrationRun, holder: string, startedAt: Date, at: Date): Promise<void> {
  await appendUsage(tx, {
    tenantId: run.tenantId, projectId: run.projectId, runId: run.runId, dedupeKey: `integration:${holder}`, role: INTEGRATION_ROLE,
    metric: 'worker_seconds', quantity: (Math.max(0, at.getTime() - startedAt.getTime()) / 1000).toFixed(3), provenance: 'observed', source: 'integration', phase: 'active', host: 'local', basis: 'measured', recordedAt: at,
  });
}

async function recordFailure(deps: IntegrationDeps, run: IntegrationRun, holder: string, startedAt: Date, at: Date, fail: Fail, invalidated: Invalidation | undefined): Promise<CandidateFailure> {
  const conflicts = fail.extra.conflicts;
  const status = fail.reason === 'conflict' ? 'conflicted' : 'failed';
  const candidateId = `cand_${fail.reason}_${sha256(JSON.stringify([run.runId, run.target, run.currentBaseSha, fail.message])).slice(0, 16)}`;
  let proposalId: string | undefined;
  let proposalError: Fail | undefined;
  // What the conflict is and between which work, independent of which commit of main exposed it: another commit landing does not make it a new conflict; a new revision of the work does.
  const conflictKey = conflicts ? sha256(JSON.stringify([run.runId, run.target, [...conflicts].map((c) => [c.path, c.kind, [...c.taskIds].sort(cmp)]).sort((a, b) => cmp(String(a[0]), String(b[0]))), (fail.extra.parts ?? []).map((p) => JSON.stringify(p)).sort(cmp)])) : undefined;
  try {
    const repeated = await withTx(deps.db, async (tx): Promise<{ candidateId: string; proposalId: string } | null> => {
      await fence(tx, run, holder);
      await recordIntegrationTime(tx, run, holder, startedAt, at);
      if (conflicts) {
        const [same] = await tx.execute(sql`SELECT c.candidate_id, c.detail, p.proposal_id FROM candidates c JOIN plan_proposals p ON p.tenant_id = c.tenant_id AND p.project_id = c.project_id AND p.proposal_id = c.detail ->> 'proposalId'
          WHERE c.tenant_id = ${run.tenantId} AND c.project_id = ${run.projectId} AND c.run_id = ${run.runId} AND c.status = 'conflicted' AND c.detail ->> 'conflictKey' = ${conflictKey!} AND p.status = 'proposed' ORDER BY c.updated_at DESC LIMIT 1 FOR UPDATE OF c, p`);
        if (same) {
          // The same conflict on a newer main: the open proposal now targets that main. No second proposal, no second event.
          await tx.execute(sql`UPDATE candidates SET base_sha = ${run.currentBaseSha}, updated_at = ${at.toISOString()}::timestamptz, detail = detail || ${JSON.stringify({ ...(run.inputsKey !== undefined ? { inputsKey: run.inputsKey } : {}) })}::jsonb
            WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND candidate_id = ${same['candidate_id'] as string}`);
          await tx.execute(sql`UPDATE plan_proposals SET tasks = jsonb_set(tasks, '{0,baseSha}', to_jsonb(${run.currentBaseSha}::text)), detail = jsonb_set(jsonb_set(detail, '{baseSha}', to_jsonb(${run.currentBaseSha}::text)), '{resolves,baseSha}', to_jsonb(${run.currentBaseSha}::text))
            WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND proposal_id = ${same['proposal_id'] as string}`);
          return { candidateId: String(same['candidate_id']), proposalId: String(same['proposal_id']) };
        }
        const { specs } = await loadTasks(deps.db, run);
        const involved = new Set(conflicts.flatMap((c) => c.taskIds));
        const refs = (fail.extra.parts ?? []).filter((p) => involved.has(p.taskId));
        const resolution = buildResolution(run, conflicts, specs, refs);
        const runRow = (await tx.execute(sql`SELECT plan_revision FROM runs WHERE tenant_id = ${run.tenantId} AND project_id = ${run.projectId} AND run_id = ${run.runId}`))[0];
        const basedOn = Number(runRow?.['plan_revision'] ?? 0);
        const valid = validatePlanRevision({ projectId: run.projectId, runId: run.runId, revision: basedOn + 1, tasks: [resolution] }, { projectId: run.projectId, runId: run.runId });
        if (!valid.ok) throw new Fail('resolution_invalid', `the resolution task is not a valid plan: ${JSON.stringify(valid.errors).slice(0, 200)}`);
        proposalId = `prop_${resolution.taskId}`;
        const resolves = { taskId: resolution.taskId, baseSha: run.currentBaseSha, paths: conflicts.map((c) => c.path).sort(cmp), parts: refs };
        await tx.insert(schema.planProposals).values({
          tenantId: run.tenantId, projectId: run.projectId, proposalId, runId: run.runId, basedOnPlanRevision: basedOn, status: 'proposed', source: 'integration',
          reason: clip(fail.message, 300), candidateId, tasks: [resolution], detail: { conflicts, baseSha: run.currentBaseSha, resolves },
        }).onConflictDoNothing();
      }
      await tx.execute(sql`
        INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status, reason, detail, updated_at)
        VALUES (${run.tenantId}, ${run.projectId}, ${candidateId}, ${run.runId}, ${run.target}, NULL, ${run.currentBaseSha}, NULL, '[]'::jsonb, ${status}, ${fail.reason},
          ${JSON.stringify({ message: clip(fail.message, 400), ...(run.inputsKey !== undefined ? { inputsKey: run.inputsKey } : {}), ...(conflicts ? { conflicts, proposalId, conflictKey } : {}) })}::jsonb, ${at.toISOString()}::timestamptz)
        ON CONFLICT (tenant_id, project_id, candidate_id) DO UPDATE SET updated_at = EXCLUDED.updated_at, detail = EXCLUDED.detail`);
      await emitCandidate(tx, run, at, 'candidate.failed', {
        candidateId, reason: fail.reason, message: clip(fail.message, 400), baseSha: run.currentBaseSha, target: run.target,
        ...(conflicts ? { conflicts, proposalId } : {}), ...(invalidated ? { invalidated } : {}),
      });
      return null;
    });
    if (repeated) return { ok: false, reason: fail.reason, message: fail.message, candidateId: repeated.candidateId, ...(conflicts ? { conflicts } : {}), proposalId: repeated.proposalId, ...(invalidated ? { invalidated } : {}) };
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    if (err.reason === 'lease_lost') return { ok: false, reason: 'lease_lost', message: err.message, ...(invalidated ? { invalidated } : {}) };
    proposalError = err;
  }
  if (proposalError) return await recordFailure(deps, run, holder, startedAt, at, new Fail(proposalError.reason, proposalError.message), invalidated);
  return {
    ok: false, reason: fail.reason, message: fail.message, candidateId,
    ...(conflicts ? { conflicts } : {}), ...(proposalId ? { proposalId } : {}), ...(invalidated ? { invalidated } : {}),
  };
}
