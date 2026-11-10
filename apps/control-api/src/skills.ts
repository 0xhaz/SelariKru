import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  libraryVersion, packDigest, parseSkillFrontmatter, scanPack, SKILL_LIBRARY, SKILL_LIMITS, skillDirOf, SkillEvaluationSchema, SkillExecutionRecordSchema, skillLibraryUrl,
  SkillPathSchema, SkillScanReportSchema, skillStates, SkillVersionSchema, SkillVersionTextSchema, strongerLabel,
  type DeliveredSkillPack, type DeliveredSkills, type PackEntry, type ResolvedSkill, type SkillBinding, type SkillFile, type SkillScanReport, type SkillVersion,
} from '@selarikru/domain';
import { schema, withTx, type Db, type Executor, type Tx } from '@selarikru/persistence';
import { redactSecrets, SkillBindingRequestSchema, SkillIntakeRequestSchema, SkillReviewRequestSchema, SkillRevokeRequestSchema } from '@selarikru/protocol';
import { bindingOf, loadKnownVersions } from '@selarikru/workflow';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError, invalidRequest, staleRevision } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { requireProject } from './store.ts';

/**
 * The skill library's owner surface and delivery (docs/skill-candidates.md §5 and §7). First-party packs are code and files in this repository, published reviewed.
 * A third-party pack only reaches staging: read from a local directory the owner names, never fetched, never installed, never run, and scanned statically. It is
 * Available or Blocked until an owner marks one exact version Reviewed; only then can it be bound. A binding is a T6.2 setting the server enforces at claim, so each
 * save is in force when it commits.
 *
 * Locking: a review, a revoke and a binding save each take the scheduler lock first, then their own row, and nothing else; no event is appended and no status row is
 * touched. The claim takes the scheduler lock and reads these tables without locking them, so a revoke or an unbind holds for every claim after its save commits. An
 * intake takes no lock: it inserts a version nothing can use until it is reviewed. See the lock order in services/workflow/src/verification.ts.
 *
 * Restricted data: everything here except `skill_pack_files` is metadata. A pack's content is read only to deliver it to the worker the claim resolved it for, and a restricted
 * or secret pack is never delivered to a cloud worker (the resolver leaves it out; delivery checks again). The execution record and the evidence carry ids and digests only.
 */

const schedulerLock = (tx: Tx, tenantId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${tenantId}`}, 0))`);
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

// ---- first-party content ------------------------------------------------------------------------------------------------------------------

const libraryCache = new Map<string, { path: string; content: string }[]>();

/** A first-party pack's files as they are on disk. Not checked here: the runner checks every pack against its recorded digest and starts nothing on a mismatch. */
async function libraryContent(v: SkillVersion): Promise<{ path: string; content: string }[]> {
  const hit = libraryCache.get(v.versionId);
  if (hit) return hit;
  const root = join(fileURLToPath(skillLibraryUrl()), v.skillId, v.version);
  const files = await Promise.all(v.files.map(async (f) => ({ path: f.path, content: await readFile(join(root, f.path), 'utf8') })));
  libraryCache.set(v.versionId, files);
  return files;
}

/**
 * The packs a claimed attempt receives, with their content: exactly the ones the claim recorded, in order. A restricted or secret pack never goes to a cloud worker; a pack
 * whose content cannot be found is sent with what was found, and the runner's digest check refuses it.
 */
export async function skillsForLease(db: Executor, lease: { tenantId: string; location: 'local' | 'cloud'; skills?: readonly ResolvedSkill[] | undefined }): Promise<DeliveredSkills> {
  const packs: DeliveredSkillPack[] = [];
  for (const r of lease.skills ?? []) {
    if (lease.location === 'cloud' && (r.classification === 'restricted' || r.classification === 'secret')) continue;
    const lib = libraryVersion(r.versionId);
    const files = lib && r.origin === 'first_party' ? await libraryContent(lib)
      : (await db.select({ path: schema.skillPackFiles.path, content: schema.skillPackFiles.content }).from(schema.skillPackFiles)
        .where(and(eq(schema.skillPackFiles.tenantId, lease.tenantId), eq(schema.skillPackFiles.versionId, r.versionId)))).sort((a, b) => (a.path < b.path ? -1 : 1));
    packs.push({ skillId: r.skillId, versionId: r.versionId, name: r.name, version: r.version, digest: r.digest, dir: r.dir, files });
  }
  return { packs };
}

// ---- intake --------------------------------------------------------------------------------------------------------------------------------

const IGNORED = new Set(['.DS_Store']);

/**
 * Lists a directory as pack entries without following a symlink and without running anything: `lstat` and `readdir` for structure, and a no-follow open for each regular file
 * small enough to read. A file that is not UTF-8 text is binary and left unread. Whatever is skipped is recorded, so the scan reports incomplete analysis.
 */
export async function readPackDirectory(root: string): Promise<PackEntry[]> {
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new AppError(422, 'skill_intake_failed', 'The path is not a directory this server can read. Nothing was staged.');
  const out: PackEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = async (rel: string, depth: number): Promise<void> => {
    const items = (await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const d of items) {
      if (IGNORED.has(d.name)) continue;
      const path = rel === '' ? d.name : `${rel}/${d.name}`;
      if (out.length >= SKILL_LIMITS.maxIntakeEntries) { out.push({ path, kind: 'file', bytes: 0, executable: false, text: null, unread: 'limit' }); return; }
      if (d.isSymbolicLink()) { out.push({ path, kind: 'symlink', bytes: 0, executable: false, text: null }); continue; }
      if (d.isDirectory()) {
        out.push({ path, kind: 'directory', bytes: 0, executable: false, text: null });
        if (depth + 1 >= SKILL_LIMITS.maxIntakeDepth) out.push({ path: `${path}/`, kind: 'file', bytes: 0, executable: false, text: null, unread: 'depth' });
        else await walk(path, depth + 1);
        continue;
      }
      if (!d.isFile()) { out.push({ path, kind: 'special', bytes: 0, executable: false, text: null }); continue; }
      const abs = join(root, path);
      const fst = await lstat(abs);
      const executable = (fst.mode & 0o111) !== 0;
      if (fst.size > SKILL_LIMITS.maxFileBytes) { out.push({ path, kind: 'file', bytes: fst.size, executable, text: null, unread: 'too_large' }); continue; }
      let bytes: Buffer;
      try {
        const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { bytes = await fh.readFile(); } finally { await fh.close(); }
      } catch {
        out.push({ path, kind: 'file', bytes: fst.size, executable, text: null, unread: 'unreadable' });
        continue;
      }
      let text: string | null = null;
      try { text = bytes.includes(0) ? null : decoder.decode(bytes); } catch { text = null; }
      out.push({ path, kind: 'file', bytes: bytes.length, executable, text, ...(text === null ? { unread: 'binary' as const } : {}), ...(SkillPathSchema.safeParse(path).success ? {} : { unread: 'unsafe_path' as const }) });
    }
  };
  await walk('', 0);
  return out;
}

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';

/** The version a staged directory makes: identity from its header, digest from its exact readable files, labelled at least as strongly as the project. */
export function stagedVersion(entries: readonly PackEntry[], scan: SkillScanReport, meta: { path: string; at: Date; by: string; projectLabel: string }): { version: Record<string, unknown>; files: { file: SkillFile; content: string }[] } {
  const skill = entries.find((e) => e.path === 'SKILL.md' && e.text !== null);
  const fm = skill?.text ? parseSkillFrontmatter(skill.text) : null;
  const files = entries.filter((e): e is PackEntry & { text: string } => e.kind === 'file' && e.text !== null && e.unread === undefined && SkillPathSchema.safeParse(e.path).success)
    .map((e) => ({ file: { path: e.path, sha256: sha(e.text), bytes: Buffer.byteLength(e.text) }, content: e.text }));
  const digest = packDigest(files.map((f) => f.file));
  const skillId = `tp-${slug(fm?.name ?? meta.path.split('/').at(-1) ?? 'pack')}`;
  const v = fm?.version && SkillVersionTextSchema.safeParse(fm.version).success ? fm.version : '0.0.0';
  const clean = (s: string | null, n: number): string => redactSecrets(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const license = entries.find((e) => /^(?:LICENSE|LICENCE|COPYING)(?:\.[A-Za-z]+)?$/.test(e.path));
  const version = {
    versionId: `${skillId}@${v}+${digest.slice(0, 12)}`, skillId, name: clean(fm?.name ?? skillId, 80) || skillId, version: v, description: clean(fm?.description ?? null, 400),
    origin: 'third_party', scope: 'project',
    license: { spdx: fm?.license ? clean(fm.license, 80) : null, file: license && SkillPathSchema.safeParse(license.path).success ? license.path : null },
    source: { kind: 'local_directory', path: redactSecrets(meta.path).slice(0, 1024), importedAt: meta.at.toISOString(), importedBy: meta.by.slice(0, 200) },
    digest, files: files.map((f) => f.file).slice(0, SKILL_LIMITS.maxFiles),
    // A staged pack declares no triggers we trust: the binding's roles and paths are what narrow it.
    triggers: { entries: [], roles: [], paths: [], actions: [] },
    labels: { frameworks: [], roles: [], focus: [] },
    tools: (fm?.allowedTools ?? []).map((t) => clean(t, 64)).filter(Boolean).slice(0, 20),
    harnesses: ['claude-code'],
    classification: strongerLabel('internal', meta.projectLabel),
  };
  void scan;
  return { version, files };
}

// ---- views -----------------------------------------------------------------------------------------------------------------------------------

export interface CatalogEntryView {
  readonly versionId: string;
  readonly skillId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly origin: 'first_party' | 'third_party';
  readonly scope: 'platform' | 'project';
  readonly digest: string | null;
  readonly files: readonly SkillFile[];
  readonly license: SkillVersion['license'] | null;
  readonly source: SkillVersion['source'] | null;
  readonly triggers: SkillVersion['triggers'] | null;
  readonly tools: readonly string[];
  readonly classification: string;
  readonly states: readonly string[];
  readonly review: { readonly by: string; readonly at: string | null } | null;
  readonly revocation: { readonly by: string; readonly at: string; readonly reason: string } | null;
  readonly scan: SkillScanReport | null;
  readonly enabledFor: readonly { readonly taskId: string; readonly attemptId: string }[];
  readonly evaluations: readonly Record<string, unknown>[];
}

async function catalogView(db: Executor, tenantId: string, projectId: string): Promise<CatalogEntryView[]> {
  const revocations = await db.select().from(schema.skillRevocations).where(eq(schema.skillRevocations.tenantId, tenantId));
  const staged = await db.select().from(schema.skillStagedVersions).where(and(eq(schema.skillStagedVersions.tenantId, tenantId), eq(schema.skillStagedVersions.projectId, projectId))).orderBy(schema.skillStagedVersions.stagedAt);
  const evals = (await db.select().from(schema.skillEvaluations).where(and(eq(schema.skillEvaluations.tenantId, tenantId), eq(schema.skillEvaluations.projectId, projectId))))
    .flatMap((e) => { const p = SkillEvaluationSchema.safeParse(e.record); return p.success ? [p.data] : []; });
  // Enabled for this task: what each task's latest attempt received.
  const records = await db.select().from(schema.skillExecutionRecords).where(and(eq(schema.skillExecutionRecords.tenantId, tenantId), eq(schema.skillExecutionRecords.projectId, projectId))).orderBy(desc(schema.skillExecutionRecords.recordedAt));
  const latest = new Map<string, { attemptId: string; versionIds: string[] }>();
  for (const r of records) {
    if (latest.has(r.taskId)) continue;
    const p = SkillExecutionRecordSchema.safeParse(r.record);
    latest.set(r.taskId, { attemptId: r.attemptId, versionIds: p.success ? p.data.delivered.map((d) => d.versionId) : [] });
  }
  const enabledFor = (versionId: string) => [...latest.entries()].filter(([, v]) => v.versionIds.includes(versionId)).map(([taskId, v]) => ({ taskId, attemptId: v.attemptId })).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  const revocationOf = (versionId: string) => { const r = revocations.find((x) => x.versionId === versionId); return r ? { by: r.revokedBy, at: r.revokedAt.toISOString(), reason: r.reason } : null; };
  const entry = (v: SkillVersion, extra: { reviewed: boolean; blocked: boolean; review: CatalogEntryView['review']; scan: SkillScanReport | null }): CatalogEntryView => {
    const revocation = revocationOf(v.versionId);
    const evaluations = evals.filter((e) => e.versionId === v.versionId);
    const enabled = enabledFor(v.versionId);
    return {
      versionId: v.versionId, skillId: v.skillId, name: v.name, version: v.version, description: v.description, origin: v.origin, scope: v.scope, digest: v.digest, files: v.files,
      license: v.license, source: v.source, triggers: v.triggers, tools: v.tools, classification: v.classification,
      states: skillStates({ version: v, reviewed: extra.reviewed, blocked: extra.blocked, revoked: revocation !== null, evaluations, projectId, enabledFor: enabled.map((e) => e.taskId) }),
      review: extra.review, revocation, scan: extra.scan, enabledFor: enabled, evaluations,
    };
  };
  const out: CatalogEntryView[] = SKILL_LIBRARY.map((v) => entry(v, { reviewed: true, blocked: false, review: { by: 'platform', at: null }, scan: null }));
  for (const s of staged) {
    const scan = SkillScanReportSchema.safeParse(s.scan);
    const v = SkillVersionSchema.safeParse(s.version);
    const review = s.reviewedAt ? { by: s.reviewedBy ?? 'owner', at: s.reviewedAt.toISOString() } : null;
    if (v.success) { out.push(entry(v.data, { reviewed: review !== null, blocked: s.blocked, review, scan: scan.success ? scan.data : null })); continue; }
    // A blocked pack whose metadata could not even form a version: shown by id, with its scan, and usable for nothing.
    const raw = s.version as { name?: unknown; version?: unknown; description?: unknown };
    out.push({
      versionId: s.versionId, skillId: s.skillId, name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : s.skillId, version: typeof raw.version === 'string' ? raw.version.slice(0, 40) : '?',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '', origin: 'third_party', scope: 'project', digest: null, files: [], license: null, source: null, triggers: null,
      tools: [], classification: 'internal', states: revocationOf(s.versionId) ? ['revoked'] : ['blocked'], review, revocation: revocationOf(s.versionId), scan: scan.success ? scan.data : null, enabledFor: [], evaluations: [],
    });
  }
  return out;
}

interface BindingView {
  readonly skillId: string;
  readonly desired: SkillBinding | null;
  readonly effective: SkillBinding | null;
  readonly desiredRevision: number;
  readonly effectiveRevision: number;
  readonly state: 'applied' | 'applying';
  readonly updatedBy: string;
  readonly updatedAt: string;
}

const bindingRow = (r: typeof schema.projectSkillBindings.$inferSelect): BindingView => ({
  skillId: r.skillId, desired: bindingOf(r.desired), effective: r.effective === null ? null : bindingOf(r.effective), desiredRevision: r.desiredRevision, effectiveRevision: r.effectiveRevision,
  state: r.effectiveRevision >= r.desiredRevision ? 'applied' : 'applying', updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString(),
});

export async function loadSkillsView(db: Executor, tenantId: string, projectId: string) {
  const bindings = await db.select().from(schema.projectSkillBindings).where(and(eq(schema.projectSkillBindings.tenantId, tenantId), eq(schema.projectSkillBindings.projectId, projectId))).orderBy(schema.projectSkillBindings.skillId);
  const roles = await db.execute(sql`SELECT DISTINCT r.spec ->> 'role' AS role FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
    WHERE s.tenant_id = ${tenantId} AND s.project_id = ${projectId} ORDER BY 1`);
  return {
    projectId, catalog: await catalogView(db, tenantId, projectId),
    // Bindings removed by the owner stay as rows (their revision keeps counting) but bind nothing.
    bindings: bindings.map(bindingRow).filter((b) => b.desired !== null || b.desiredRevision > 0),
    roles: roles.map((r) => r['role']).filter((r): r is string => typeof r === 'string'),
  };
}

/** The reviewed, unrevoked, bound versions and the stack entries their triggers name: what the stack's Skills axis shows. */
export async function boundSkillsForStack(db: Executor, tenantId: string, projectId: string): Promise<{ name: string; version: string; entries: string[] }[]> {
  const known = await loadKnownVersions(db, tenantId, projectId);
  const rows = await db.select().from(schema.projectSkillBindings).where(and(eq(schema.projectSkillBindings.tenantId, tenantId), eq(schema.projectSkillBindings.projectId, projectId)));
  return rows.flatMap((r) => {
    const b = bindingOf(r.desired);
    const k = b ? known.get(b.versionId) : undefined;
    return k && k.reviewed && !k.revoked && !k.blocked ? [{ name: k.version.name, version: k.version.version, entries: [...k.version.triggers.entries] }] : [];
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- routes ---------------------------------------------------------------------------------------------------------------------------------

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const projectOf = async (req: FastifyRequest) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const projectId = (req.params as { id: string }).id;
    const project = await requireProject(db, config.tenantId, projectId);
    return { projectId, uid: req.principal.uid, project };
  };
  const entryOf = async (db2: Executor, projectId: string, versionId: string): Promise<CatalogEntryView> => {
    const e = (await catalogView(db2, config.tenantId, projectId)).find((c) => c.versionId === versionId);
    if (!e) throw new AppError(404, 'skill_version_not_found', 'no such pack version in this project');
    return e;
  };

  app.get('/v1/projects/:id/skills', auth, async (req) => {
    const { projectId } = await projectOf(req);
    return loadSkillsView(db, config.tenantId, projectId);
  });

  app.post('/v1/projects/:id/skills/intake', auth, async (req, reply) => {
    const { projectId, uid, project } = await projectOf(req);
    const body = parseBody(SkillIntakeRequestSchema, req.body);
    if (!isAbsolute(body.path) || body.path.includes('\0')) throw invalidRequest('the intake path must be an absolute local directory');
    if (redactSecrets(body.path) !== body.path) throw new AppError(400, 'credential_in_input', 'the path contains something shaped like a secret; nothing was staged');
    const root = resolve(body.path);
    const entries = await readPackDirectory(root);
    const scan = scanPack(entries, { secretShaped: (line) => redactSecrets(line) !== line });
    const at = now();
    const { version, files } = stagedVersion(entries, scan, { path: root, at, by: uid, projectLabel: project.classification });
    const versionId = String(version['versionId']);
    const parsed = SkillVersionSchema.safeParse(version);
    // A version that cannot be described completely cannot be delivered either.
    const blocked = scan.blocked || !parsed.success;
    const existing = (await db.select({ projectId: schema.skillStagedVersions.projectId }).from(schema.skillStagedVersions).where(and(eq(schema.skillStagedVersions.tenantId, config.tenantId), eq(schema.skillStagedVersions.versionId, versionId))))[0];
    if (existing && existing.projectId !== projectId) throw new AppError(409, 'skill_already_staged', 'these exact files are already staged in another project');
    if (!existing) {
      await withTx(db, async (tx) => {
        const inserted = await tx.insert(schema.skillStagedVersions).values({ tenantId: config.tenantId, projectId, versionId, skillId: String(version['skillId']), version, scan: scan as unknown as Record<string, unknown>, blocked, stagedBy: uid, stagedAt: at })
          .onConflictDoNothing().returning({ v: schema.skillStagedVersions.versionId });
        // What can never be delivered is not kept: a blocked pack stores its metadata and scan only.
        if (inserted.length > 0 && !blocked) for (const f of files) await tx.insert(schema.skillPackFiles).values({ tenantId: config.tenantId, versionId, path: f.file.path, content: f.content });
      });
    }
    return reply.code(existing ? 200 : 201).send(await entryOf(db, projectId, versionId));
  });

  app.post('/v1/projects/:id/skills/review', auth, async (req) => {
    const { projectId, uid } = await projectOf(req);
    const body = parseBody(SkillReviewRequestSchema, req.body);
    await withTx(db, async (tx) => {
      await schedulerLock(tx, config.tenantId);
      const [row] = await tx.select().from(schema.skillStagedVersions).where(and(eq(schema.skillStagedVersions.tenantId, config.tenantId), eq(schema.skillStagedVersions.projectId, projectId), eq(schema.skillStagedVersions.versionId, body.versionId))).for('update');
      if (!row) {
        if (libraryVersion(body.versionId)) throw new AppError(409, 'skill_already_reviewed', 'a first-party pack is published reviewed');
        throw new AppError(404, 'skill_version_not_found', 'no such staged pack version in this project');
      }
      if (row.blocked) throw new AppError(409, 'skill_not_reviewable', 'the static scan blocked this version: it holds scripts, hooks or a credential, or it could not be fully analysed');
      if (row.reviewedAt !== null) throw new AppError(409, 'skill_already_reviewed', 'this version is already reviewed');
      const revoked = await tx.select().from(schema.skillRevocations).where(and(eq(schema.skillRevocations.tenantId, config.tenantId), eq(schema.skillRevocations.versionId, body.versionId)));
      if (revoked.length > 0) throw new AppError(409, 'skill_revoked', 'this version is revoked');
      const scan = SkillScanReportSchema.safeParse(row.scan);
      if (!scan.success) throw new AppError(409, 'skill_not_reviewable', 'the scan report cannot be read, so the version cannot be reviewed');
      if (scan.data.findings.some((f) => f.severity === 'review') && !body.acknowledgeFindings) throw new AppError(409, 'skill_findings_unacknowledged', 'the scan raised findings for review; acknowledge them to mark this version reviewed');
      await tx.update(schema.skillStagedVersions).set({ reviewedBy: uid, reviewedAt: now() }).where(and(eq(schema.skillStagedVersions.tenantId, config.tenantId), eq(schema.skillStagedVersions.versionId, body.versionId)));
    });
    return entryOf(db, projectId, body.versionId);
  });

  app.post('/v1/projects/:id/skills/revoke', auth, async (req) => {
    const { projectId, uid } = await projectOf(req);
    const body = parseBody(SkillRevokeRequestSchema, req.body);
    if (redactSecrets(body.reason) !== body.reason) throw new AppError(400, 'credential_in_input', 'the reason contains something shaped like a secret; nothing was recorded');
    await entryOf(db, projectId, body.versionId);
    await withTx(db, async (tx) => {
      // The scheduler lock first: a claim in flight finishes before this revoke, and every claim after it reads it.
      await schedulerLock(tx, config.tenantId);
      const done = await tx.insert(schema.skillRevocations).values({ tenantId: config.tenantId, versionId: body.versionId, reason: body.reason.replace(/\s+/g, ' ').trim(), revokedBy: uid, revokedAt: now() }).onConflictDoNothing().returning({ v: schema.skillRevocations.versionId });
      if (done.length === 0) throw new AppError(409, 'skill_already_revoked', 'this version is already revoked');
    });
    return entryOf(db, projectId, body.versionId);
  });

  app.post('/v1/projects/:id/skills/bindings', auth, async (req) => {
    const { projectId, uid } = await projectOf(req);
    const body = parseBody(SkillBindingRequestSchema, req.body);
    if (body.binding && [...body.binding.roles, ...body.binding.paths].some((s) => redactSecrets(s) !== s)) throw new AppError(400, 'credential_in_input', 'this contains something shaped like a secret; nothing was saved');
    const at = now();
    return withTx(db, async (tx) => {
      // Scheduler lock, then the binding row. The server enforces a binding at claim, so it is in force when this commits: desired and effective move together.
      await schedulerLock(tx, config.tenantId);
      const where = and(eq(schema.projectSkillBindings.tenantId, config.tenantId), eq(schema.projectSkillBindings.projectId, projectId), eq(schema.projectSkillBindings.skillId, body.skillId));
      const [row] = await tx.select().from(schema.projectSkillBindings).where(where).for('update');
      const current = row?.desiredRevision ?? 0;
      if (body.expectedRevision !== current) throw staleRevision(current, 'this binding');
      if (body.binding !== null) {
        const known = (await loadKnownVersions(tx, config.tenantId, projectId)).get(body.binding.versionId);
        if (!known || known.version.skillId !== body.skillId) {
          const staged = (await tx.select({ v: schema.skillStagedVersions.versionId }).from(schema.skillStagedVersions).where(and(eq(schema.skillStagedVersions.tenantId, config.tenantId), eq(schema.skillStagedVersions.projectId, projectId), eq(schema.skillStagedVersions.versionId, body.binding.versionId)))).length > 0;
          if (staged) throw new AppError(409, 'skill_not_reviewed', 'only a reviewed version can be bound; this one is blocked or not reviewed');
          throw new AppError(404, 'skill_version_not_found', 'no such pack version for this skill');
        }
        if (known.revoked) throw new AppError(409, 'skill_revoked', 'a revoked version cannot be bound');
        if (!known.reviewed || known.blocked) throw new AppError(409, 'skill_not_reviewed', 'only a reviewed version can be bound');
      }
      const desired = body.binding ?? { removed: true };
      const revision = current + 1;
      const values = { field: 'binding', desired, desiredRevision: revision, effective: desired, effectiveRevision: revision, enforcer: 'server', configRevision: null, updatedBy: uid, updatedAt: at, appliedAt: at };
      await tx.insert(schema.projectSkillBindings).values({ tenantId: config.tenantId, projectId, skillId: body.skillId, ...values })
        .onConflictDoUpdate({ target: [schema.projectSkillBindings.tenantId, schema.projectSkillBindings.projectId, schema.projectSkillBindings.skillId], set: values });
      const [saved] = await tx.select().from(schema.projectSkillBindings).where(where);
      return bindingRow(saved!);
    });
  });

  /** What one attempt received: the recorded versions and digests, and which of them have been revoked since. Metadata only. */
  app.get('/v1/projects/:id/skills/attempts/:attemptId', auth, async (req) => {
    const { projectId } = await projectOf(req);
    const attemptId = (req.params as { attemptId: string }).attemptId;
    const [row] = await db.select().from(schema.skillExecutionRecords).where(and(eq(schema.skillExecutionRecords.tenantId, config.tenantId), eq(schema.skillExecutionRecords.projectId, projectId), eq(schema.skillExecutionRecords.attemptId, attemptId)));
    if (!row) return { attemptId, record: null, revoked: [] };
    const p = SkillExecutionRecordSchema.safeParse(row.record);
    const record = p.success ? p.data : null;
    const ids = record?.delivered.map((d) => d.versionId) ?? [];
    const revoked = ids.length === 0 ? [] : (await db.select({ v: schema.skillRevocations.versionId }).from(schema.skillRevocations).where(eq(schema.skillRevocations.tenantId, config.tenantId))).map((r) => r.v).filter((v) => ids.includes(v)).sort();
    return { attemptId, record, revoked };
  });
}

export { skillDirOf };
