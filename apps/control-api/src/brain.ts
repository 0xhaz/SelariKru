import {
  allowedUseFor, BRAIN_GENERATOR, BlueprintContentSchema, productBrainSources, stackBrainSources, BrainCompilationSchema, BrainSourceRevisionSchema, buildContextBundle, canonicalJson, cleanSourceText, compileBrain, strongerLabel, TaskSpecSchema,
  type BrainBundle, type BrainClaim, type BrainClassification, type BrainCompilation, type BrainDestination, type BrainRevocation, type BrainSection, type BrainSourceRevision, type TaskSpec,
} from '@selarikru/domain';
import { schema, withTx, type Db, type Executor, type Tx } from '@selarikru/persistence';
import { BrainManifestRequestSchema, BrainNoteRequestSchema, BrainRevokeRequestSchema, redactSecrets, REPO_MANIFEST_DOC_PATH_MAX, type RepoManifest } from '@selarikru/protocol';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { sha256Hex } from './auth.ts';
import { AppError, invalidRequest } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { flushProductEvents, loadProductRecords } from './product.ts';
import { loadStack } from './stack.ts';
import { leaseHolds, loadSpecRow, newId, requireProject } from './store.ts';

/**
 * The Project Brain's server side (docs/second-brain.md §4, §7). Deterministic only: sources are snapshots of records this server already holds (the accepted blueprint,
 * the accepted plan, recorded decisions and approvals, verifier verdicts, pull request outcomes), an owner's notes, and a runner's repository manifest. Pages are
 * compiled by `compileBrain` with no model. Model-assisted synthesis is not built.
 *
 * Locking: every write here takes the project's `brain_heads` row and nothing else. It is taken with no other lock held, and while it is held only brain tables are
 * written; every other table is read without a lock. So it never orders against the scheduler lock, run rows, status rows or the event sequence (see the lock order in
 * services/workflow/src/verification.ts). No brain change appends an event: brain text never enters the event stream.
 *
 * Restricted data: a source's label is the strongest of the project's and every task it was read from. Nothing here copies agent text: verdicts give check ids, approvals
 * an operation code, and a restricted attempt's own words never reach this server in the first place.
 */

type Draft = Omit<BrainSourceRevision, 'revision' | 'seq' | 'recordedAt' | 'contentSha256'>;

const SYSTEM = 'control-api';
const contentSha = (d: Draft): string =>
  sha256Hex(canonicalJson({ kind: d.kind, title: d.title, standing: d.standing, classification: d.classification, allowedUse: d.allowedUse, derivedFrom: d.derivedFrom, taskId: d.taskId, sections: d.sections }));
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const text = (s: string, max = 1000): string => cleanSourceText(redactSecrets(s), max).replace(/\s+/g, ' ').trim();
const sec = (anchor: string, heading: string, body: string, key?: string): BrainSection => ({ anchor, heading: text(heading, 200) || anchor, text: text(body, 2000), ...(key !== undefined ? { key } : {}) });
const label = (...xs: unknown[]): BrainClassification => xs.reduce<BrainClassification>((acc, x) => strongerLabel(acc, x), 'public');
const draft = (d: Omit<Draft, 'allowedUse' | 'derivedFrom'> & { derivedFrom?: Draft['derivedFrom'] }): Draft => ({ ...d, derivedFrom: d.derivedFrom ?? [], allowedUse: allowedUseFor(d.classification) });

// ---- reading records into sources ----------------------------------------------------------------------------------

/** Sources read from records, by source id. Deterministic for the same records. */
export async function recordSources(db: Executor, tenantId: string, projectId: string): Promise<Draft[]> {
  const project = await requireProject(db, tenantId, projectId);
  const projectLabel = label(project.classification);
  const out: Draft[] = [];

  // The current plan of the latest planned run: each task at its current revision.
  const [run] = await db.select().from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.projectId, projectId), isNotNull(schema.runs.planRevision))).orderBy(desc(schema.runs.createdAt), desc(schema.runs.runId)).limit(1);
  const specs: TaskSpec[] = [];
  if (run) {
    const rows = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskStatus).innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
      eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
    )).where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskRevisions.runId, run.runId))).orderBy(asc(schema.taskStatus.taskId));
    for (const r of rows) {
      const p = TaskSpecSchema.safeParse(r.spec);
      if (p.success) specs.push(p.data);
    }
    for (const s of specs) {
      const deps = s.dependencies.map((d) => d.taskId);
      out.push(draft({
        sourceId: `plan:${run.runId}:${s.taskId}`, kind: 'plan', title: `Plan: ${text(s.title, 160)}`, standing: 'accepted', classification: label(projectLabel, s.classification),
        provenance: { origin: 'plan', ref: `${run.runId}/${s.taskId}@${s.revision}`, recordedBy: SYSTEM }, taskId: null,
        sections: [sec(`tasks/${s.taskId}`, s.title, `Role ${s.role}. May change: ${s.allowedPaths.join(', ') || 'nothing'}. Depends on: ${deps.join(', ') || 'nothing'}. Judged on: ${s.requirementIds.join(', ') || 'nothing listed'}.`, `task:${s.taskId}`)],
      }));
    }
  }

  // Criteria and constraints: the accepted blueprint when the project was set up through onboarding, else the criteria the accepted plan carries.
  const [onboarding] = await db.select().from(schema.projectOnboardings).where(and(eq(schema.projectOnboardings.tenantId, tenantId), eq(schema.projectOnboardings.projectId, projectId), isNotNull(schema.projectOnboardings.acceptedBlueprintVersion)));
  const accepted = onboarding?.acceptedBlueprintVersion ?? null;
  const [bp] = accepted === null ? [] : await db.select().from(schema.projectBlueprints).where(and(eq(schema.projectBlueprints.tenantId, tenantId), eq(schema.projectBlueprints.projectId, projectId), eq(schema.projectBlueprints.version, accepted)));
  const blueprint = bp ? BlueprintContentSchema.safeParse(bp.content) : null;
  if (blueprint?.success) {
    const b = blueprint.data;
    const prov = { origin: 'onboarding', ref: `blueprint:v${accepted}`, recordedBy: SYSTEM };
    out.push(draft({
      sourceId: `brief:${projectId}`, kind: 'brief', title: 'Accepted brief', standing: 'accepted', classification: projectLabel, provenance: prov, taskId: null,
      sections: [
        sec('goals/idea', 'Idea', b.goals.idea, 'goal:idea'), sec('goals/audience', 'Audience', b.goals.audience, 'goal:audience'), sec('goals/first-outcome', 'First outcome', b.goals.firstOutcome, 'goal:first_outcome'),
        sec('tracks', 'Tracks', b.tracks.join(', '), 'tracks'),
        ...b.stack.map((s, i) => sec(`stack/${i + 1}`, s.name, s.reason, `stack:${i + 1}`)),
        ...b.nonGoals.map((g, i) => sec(`non-goals/${i + 1}`, 'Non-goal', g, `non_goal:${i + 1}`)),
        ...b.assumptions.map((g, i) => sec(`assumptions/${i + 1}`, 'Assumption', g, `assumption:${i + 1}`)),
        ...b.pendingDecisions.map((g, i) => sec(`pending-decisions/${i + 1}`, 'Pending decision', g, `pending_decision:${i + 1}`)),
      ],
    }));
    out.push(draft({
      sourceId: `criteria:${projectId}`, kind: 'criteria', title: 'Accepted criteria and constraints', standing: 'accepted', classification: projectLabel, provenance: prov, taskId: null,
      sections: [
        ...b.acceptanceCriteria.map((c) => sec(`criteria/${c.id}`, c.id, c.text, `criterion:${c.id}`)),
        sec('constraints/allowed-paths', 'Allowed paths', b.allowedPaths.join(', '), 'allowed_paths'),
        ...(b.rolePaths ? Object.entries(b.rolePaths).map(([role, paths]) => sec(`constraints/role-paths/${role}`, `${role} paths`, paths.join(', '), `role_paths:${role}`)) : []),
      ],
    }));
  }
  // Criteria the plan's tasks carry. The canonical text of an id is the blueprint's, or else the first task's by task id. A task that states another text for the same id
  // is an accepted source of its own (`criteria_task:<task>`), so the compiler disputes the claim and records a decision proposal; nothing picks one silently.
  const canonical = new Map<string, string>(blueprint?.success ? blueprint.data.acceptanceCriteria.map((c) => [c.id, c.text.replace(/\s+/g, ' ').trim()]) : []);
  const fromTasks = new Map<string, { text: string; classification: BrainClassification }>();
  const variants = new Map<string, { spec: TaskSpec; sections: BrainSection[] }>();
  for (const s of specs) {
    for (const c of s.criteria ?? []) {
      if (!CODE.test(c.id)) continue;
      const said = c.text.replace(/\s+/g, ' ').trim();
      const want = canonical.get(c.id) ?? fromTasks.get(c.id)?.text;
      if (want === undefined) { fromTasks.set(c.id, { text: said, classification: label(projectLabel, s.classification) }); continue; }
      if (said === want) continue;
      const v = variants.get(s.taskId) ?? { spec: s, sections: [] };
      v.sections.push(sec(`criteria/${c.id}`, c.id, c.text, `criterion:${c.id}`));
      variants.set(s.taskId, v);
    }
  }
  if (run && !blueprint?.success && fromTasks.size > 0) {
    out.push(draft({
      sourceId: `criteria:${projectId}`, kind: 'criteria', title: 'Accepted criteria', standing: 'accepted', classification: label(projectLabel, ...[...fromTasks.values()].map((v) => v.classification)),
      provenance: { origin: 'plan', ref: `${run.runId}@${run.planRevision}`, recordedBy: SYSTEM }, taskId: null,
      sections: [...fromTasks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, v]) => sec(`criteria/${id}`, id, v.text, `criterion:${id}`)),
    }));
  }
  for (const [taskId, v] of [...variants.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(draft({
      sourceId: `criteria_task:${taskId}`, kind: 'criteria', title: `Criteria as task ${text(taskId, 80)} states them`, standing: 'accepted', classification: label(projectLabel, v.spec.classification),
      provenance: { origin: 'plan', ref: `${v.spec.runId}/${taskId}@${v.spec.revision}`, recordedBy: SYSTEM }, taskId,
      sections: v.sections,
    }));
  }

  const taskLabel = new Map<string, BrainClassification>();
  const labelOfTask = async (taskId: string | null): Promise<BrainClassification> => {
    if (taskId === null) return projectLabel;
    if (!taskLabel.has(taskId)) {
      const [row] = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(eq(schema.taskRevisions.tenantId, tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.taskId, taskId))).orderBy(desc(schema.taskRevisions.revision)).limit(1);
      const p = TaskSpecSchema.safeParse(row?.spec);
      // A task that cannot be read is labelled as the strongest: fails closed.
      taskLabel.set(taskId, p.success ? label(projectLabel, p.data.classification) : 'secret');
    }
    return taskLabel.get(taskId)!;
  };

  // Recorded decisions: reduced scope, rulings, grants. The owner wrote the rationale.
  for (const d of await db.select().from(schema.decisions).where(and(eq(schema.decisions.tenantId, tenantId), eq(schema.decisions.projectId, projectId))).orderBy(asc(schema.decisions.decisionId))) {
    if (!CODE.test(d.decisionId)) continue;
    out.push(draft({
      // The strongest of the project's label and every label the decision covers: a reclassification of restricted material is itself restricted.
      sourceId: `decision:${d.decisionId}`, kind: 'decision', title: `Decision ${d.decisionId}`, standing: 'accepted',
      classification: label(projectLabel, ...d.affected.flatMap((x) => (x !== null && typeof x === 'object' && 'sourceClassification' in x ? [(x as { sourceClassification: unknown }).sourceClassification] : []))),
      provenance: { origin: 'decisions', ref: d.decisionId, recordedBy: d.author.slice(0, 200) || SYSTEM }, taskId: null,
      sections: [sec(`decision/${d.decisionId}`, d.context, `${d.rationale}${d.supersededBy ? ` (superseded by ${d.supersededBy})` : ''}`, `decision:${d.decisionId}`)],
    }));
  }

  // Resolved approvals: the operation code and the outcome only. Never the request's reason, which may be a worker's words.
  for (const a of await db.select().from(schema.approvals).where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.projectId, projectId), inArray(schema.approvals.outcome, ['granted', 'denied']))).orderBy(asc(schema.approvals.approvalId))) {
    if (!CODE.test(a.approvalId)) continue;
    const op = typeof a.detail['operation'] === 'string' && /^[a-z_]{1,60}$/.test(a.detail['operation']) ? a.detail['operation'] : 'an operation';
    out.push(draft({
      sourceId: `approval:${a.approvalId}`, kind: 'decision', title: `Approval ${a.approvalId}`, standing: 'accepted', classification: await labelOfTask(a.taskId),
      provenance: { origin: 'approvals', ref: a.approvalId, recordedBy: (a.approver ?? SYSTEM).slice(0, 200) }, taskId: a.taskId,
      sections: [sec(`approval/${a.approvalId}`, `Approval: ${op}`, `${op} was ${a.outcome}${a.taskId ? ` for task ${a.taskId}` : ''}${a.resolvedAt ? ` on ${a.resolvedAt.toISOString().slice(0, 10)}` : ''}.`, `approval:${a.approvalId}`)],
    }));
  }

  // Verdicts and pull request outcomes, from the event log: the latest per task and per run. Check ids and commit ids only.
  const evs = await db.execute(sql`
    SELECT DISTINCT ON (type_group, subject) type, task_id, run_id, payload, occurred_at, type_group, subject FROM (
      SELECT type, task_id, run_id, payload, occurred_at, sequence,
        CASE WHEN type LIKE 'verification.%' THEN 'verification' ELSE 'pull_request' END AS type_group,
        CASE WHEN type LIKE 'verification.%' THEN task_id ELSE run_id END AS subject
      FROM events WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND type IN ('verification.passed', 'verification.failed', 'change.proposed', 'change.merged')
    ) e ORDER BY type_group, subject, sequence DESC`);
  for (const e of evs) {
    const type = String(e['type']);
    const payload = (e['payload'] ?? {}) as Record<string, unknown>;
    const candidate = typeof payload['candidateSha'] === 'string' && HEX.test(payload['candidateSha']) ? payload['candidateSha'].slice(0, 12) : null;
    if (type.startsWith('verification.')) {
      const taskId = String(e['task_id']);
      if (!CODE.test(taskId)) continue;
      const failed = Array.isArray(payload['failedChecks']) ? payload['failedChecks'].filter((c): c is string => typeof c === 'string' && CODE.test(c)).slice(0, 40) : [];
      const body = type === 'verification.passed' ? `Verification passed${candidate ? ` at candidate ${candidate}` : ''}.` : `Verification failed${failed.length > 0 ? `: ${failed.join(', ')}` : ''}.`;
      out.push(draft({
        sourceId: `verification:${taskId}`, kind: 'verification', title: `Verification of ${taskId}`, standing: 'accepted', classification: await labelOfTask(taskId),
        provenance: { origin: 'events', ref: `${type}:${taskId}`, recordedBy: 'verifier' }, taskId,
        sections: [sec(`verification/${taskId}`, `Verification: ${taskId}`, body, `verification:${taskId}`)],
      }));
    } else {
      const runId = String(e['run_id']);
      if (!CODE.test(runId)) continue;
      out.push(draft({
        sourceId: `pull_request:${runId}`, kind: 'decision', title: `Pull request for ${runId}`, standing: 'accepted', classification: projectLabel,
        provenance: { origin: 'events', ref: `${type}:${runId}`, recordedBy: SYSTEM }, taskId: null,
        sections: [sec(`pull-request/${runId}`, `Pull request: ${runId}`, type === 'change.merged' ? 'A person merged the pull request on GitHub.' : 'A draft pull request was opened for review.', `pull_request:${runId}`)],
      }));
    }
  }
  // The owner's stack settings: one source per component, citing each decided category. Undecided categories state nothing; detections that were not confirmed are
  // proposals and are not read at all.
  // A stored stack this build cannot read states nothing: its earlier claims go stale rather than being guessed at.
  const stack = await loadStack(db, tenantId, projectId);
  for (const st of stack.unreadable ? [] : stackBrainSources(stack.document)) {
    out.push(draft({
      sourceId: st.sourceId, kind: 'stack', title: text(st.title, 200) || 'Stack', standing: 'accepted', classification: label(projectLabel, st.classification), taskId: null,
      provenance: { origin: 'owner', ref: `stack@r${stack.revision}`, recordedBy: (stack.updatedBy ?? SYSTEM).slice(0, 200) },
      sections: st.sections.map((x) => sec(x.anchor, x.heading, x.text, x.key)),
    }));
  }
  // Product-learning records: a confirmed brief (a proposal states nothing), outcome plans, release notes and outcome reviews. Each keeps the label it took from what it cites.
  for (const pr of productBrainSources(await loadProductRecords(db, tenantId, projectId))) {
    out.push(draft({
      sourceId: pr.sourceId, kind: 'product', title: text(pr.title, 200) || 'Product record', standing: pr.standing, classification: label(projectLabel, pr.classification), taskId: null,
      provenance: { origin: 'product', ref: pr.ref.slice(0, 200), recordedBy: pr.recordedBy.slice(0, 200) || SYSTEM },
      sections: pr.sections.map((x) => sec(x.anchor, x.heading, x.text, x.key)),
    }));
  }
  return out;
}

// ---- storage ------------------------------------------------------------------------------------------------------

const toRevision = (r: typeof schema.brainSources.$inferSelect): BrainSourceRevision => BrainSourceRevisionSchema.parse({
  sourceId: r.sourceId, revision: r.revision, kind: r.kind, title: r.title, standing: r.standing, classification: r.classification, allowedUse: r.allowedUse,
  provenance: r.provenance, derivedFrom: r.derivedFrom, taskId: r.taskId, sections: r.sections, contentSha256: r.contentSha256, seq: r.seq, recordedAt: r.recordedAt.toISOString(),
});
const toRevocation = (r: typeof schema.brainRevocations.$inferSelect): BrainRevocation => ({ sourceId: r.sourceId, reason: r.reason, revokedBy: r.revokedBy, revokedAt: r.revokedAt.toISOString(), seq: r.seq });

export interface BrainState {
  readonly lastSeq: number;
  readonly revisions: BrainSourceRevision[];
  readonly revocations: BrainRevocation[];
  readonly compilation: BrainCompilation | null;
  readonly resolutions: (typeof schema.brainConflictResolutions.$inferSelect)[];
}

const where = <T extends { tenantId: unknown; projectId: unknown }>(t: T, tenantId: string, projectId: string) => and(eq(t.tenantId as never, tenantId), eq(t.projectId as never, projectId));

export async function loadBrain(db: Executor, tenantId: string, projectId: string): Promise<BrainState> {
  const [head] = await db.select().from(schema.brainHeads).where(where(schema.brainHeads, tenantId, projectId));
  const revisions = (await db.select().from(schema.brainSources).where(where(schema.brainSources, tenantId, projectId)).orderBy(asc(schema.brainSources.seq))).map(toRevision);
  const revocations = (await db.select().from(schema.brainRevocations).where(where(schema.brainRevocations, tenantId, projectId)).orderBy(asc(schema.brainRevocations.seq))).map(toRevocation);
  const [c] = await db.select().from(schema.brainCompilations).where(where(schema.brainCompilations, tenantId, projectId)).orderBy(desc(schema.brainCompilations.version)).limit(1);
  const compilation = c ? BrainCompilationSchema.parse({ version: c.version, generator: { id: c.generatorId, version: c.generatorVersion }, generatedAt: c.generatedAt.toISOString(), watermark: c.watermark, pages: c.pages, conflicts: c.conflicts }) : null;
  const resolutions = await db.select().from(schema.brainConflictResolutions).where(where(schema.brainConflictResolutions, tenantId, projectId)).orderBy(asc(schema.brainConflictResolutions.conflictId));
  return { lastSeq: head?.lastSeq ?? 0, revisions, revocations, compilation, resolutions };
}

/** The project's brain lock. Taken with no other lock held; see the note at the top of this file. */
async function lockHead(tx: Tx, tenantId: string, projectId: string): Promise<{ lastSeq: number; compiledVersion: number; recordsMark: string | null }> {
  await tx.insert(schema.brainHeads).values({ tenantId, projectId }).onConflictDoNothing();
  const [head] = await tx.select().from(schema.brainHeads).where(where(schema.brainHeads, tenantId, projectId)).for('update');
  return { lastSeq: head!.lastSeq, compiledVersion: head!.compiledVersion, recordsMark: head!.recordsMark };
}

/**
 * A fingerprint of every record `recordSources` reads: the latest relevant event, decisions, resolved approvals, task revisions, runs, the accepted blueprint, the
 * stack, the product records and the project label. One small read, no lock. When it has not moved, a sync reads no records.
 */
export async function recordsMark(db: Executor, tenantId: string, projectId: string): Promise<string> {
  const [row] = await db.execute(sql`SELECT concat_ws('|', ${`${BRAIN_GENERATOR.version}:${RECORDS_READER_VERSION}`}::text,
    (SELECT coalesce(max(sequence), 0) FROM events WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND type IN ('verification.passed', 'verification.failed', 'change.proposed', 'change.merged', 'plan.accepted', 'approval.granted', 'approval.denied', 'run.reduced_scope_accepted')),
    (SELECT count(*) || ':' || count(superseded_by) || ':' || coalesce(max(created_at)::text, '') FROM decisions WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT count(*) || ':' || coalesce(max(resolved_at)::text, '') FROM approvals WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND outcome IN ('granted', 'denied')),
    (SELECT count(*) || ':' || coalesce(sum(current_revision), 0) FROM task_status WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT count(*) FROM task_revisions WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT count(*) || ':' || coalesce(max(plan_revision), 0) FROM runs WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT coalesce(max(accepted_blueprint_version), 0) FROM project_onboardings WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT coalesce(max(revision), 0) FROM project_stacks WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT coalesce(max(seq), 0) FROM product_records WHERE tenant_id = ${tenantId} AND project_id = ${projectId}),
    (SELECT classification FROM projects WHERE tenant_id = ${tenantId} AND project_id = ${projectId})) AS mark`);
  return String(row?.['mark'] ?? '');
}

/**
 * The version of `recordSources`, the code that reads records into sources. It is part of the records fingerprint with the generator's version, so a deploy that
 * changes either reads every project's records again. Raise it whenever that code changes what it produces.
 */
export const RECORDS_READER_VERSION = '5';

/** A source that could not be stored: its id and a code, never its text. */
export type SkipReport = (skip: { readonly sourceId: string; readonly code: 'brain_source_invalid' }) => void;

interface Writer {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly projectId: string;
  seq: number;
  changed: boolean;
  readonly onSkip: SkipReport;
}

/** Stores the next revision of a source, or skips a draft that does not validate (and says so), so one bad record can never roll every sync back. */
async function writeRevision(w: Writer, d: Draft, previous: BrainSourceRevision | undefined, at: Date): Promise<BrainSourceRevision | null> {
  const rev: BrainSourceRevision = { ...d, revision: (previous?.revision ?? 0) + 1, contentSha256: contentSha(d), seq: w.seq + 1, recordedAt: at.toISOString() };
  const checked = BrainSourceRevisionSchema.safeParse(rev);
  if (!checked.success) {
    w.onSkip({ sourceId: d.sourceId.slice(0, 200), code: 'brain_source_invalid' });
    return null;
  }
  w.seq += 1;
  w.changed = true;
  const r = checked.data;
  await w.tx.insert(schema.brainSources).values({
    tenantId: w.tenantId, projectId: w.projectId, sourceId: r.sourceId, revision: r.revision, kind: r.kind, title: r.title, standing: r.standing,
    classification: r.classification, allowedUse: r.allowedUse, provenance: r.provenance, derivedFrom: r.derivedFrom, taskId: r.taskId, sections: r.sections,
    contentSha256: r.contentSha256, seq: r.seq, recordedAt: at,
  });
  return r;
}

/** Compiles from what is stored now and publishes it as the next version, with its support graph. */
async function publish(w: Writer, version: number, at: Date): Promise<BrainCompilation> {
  const state = await loadBrain(w.tx, w.tenantId, w.projectId);
  const compilation = compileBrain({
    revisions: state.revisions, revocations: state.revocations, kept: new Set(state.resolutions.map((r) => r.conflictId)),
    previous: state.compilation?.pages.flatMap((p) => p.claims) ?? [], version, generatedAt: at.toISOString(),
  });
  await w.tx.insert(schema.brainCompilations).values({
    tenantId: w.tenantId, projectId: w.projectId, version, generatorId: compilation.generator.id, generatorVersion: compilation.generator.version, generatedAt: at,
    watermark: compilation.watermark, pages: compilation.pages, conflicts: compilation.conflicts,
  });
  const edges = new Map<string, typeof schema.brainClaimSupports.$inferInsert>();
  const edge = (claim: BrainClaim, relation: string, sourceId: string, revision: number, anchor: string): void => {
    const row = { tenantId: w.tenantId, projectId: w.projectId, version, claimId: claim.claimId, relation, sourceId, revision, anchor };
    edges.set(JSON.stringify([claim.claimId, relation, sourceId, revision, anchor]), row);
  };
  for (const claim of compilation.pages.flatMap((p) => p.claims)) {
    for (const c of claim.citations) edge(claim, 'cites', c.sourceId, c.revision, c.anchor);
    for (const r of claim.roots) edge(claim, 'rests_on', r, 0, '');
    for (const c of claim.disputedBy) edge(claim, 'disputed_by', c.sourceId, c.revision, c.anchor);
  }
  const rows = [...edges.values()];
  for (let i = 0; i < rows.length; i += 500) await w.tx.insert(schema.brainClaimSupports).values(rows.slice(i, i + 500));
  await w.tx.update(schema.brainHeads).set({ lastSeq: w.seq, compiledVersion: version }).where(where(schema.brainHeads, w.tenantId, w.projectId));
  return compilation;
}

const quiet: SkipReport = () => undefined;

/**
 * Compiles on change. Under the project's brain lock: `change` runs first (an owner's note, a revocation, a settled conflict, a runner's manifest); then, only when the
 * records' fingerprint moved since the last sync, the records are read and every changed one becomes a new source revision; then, when anything was written (or
 * nothing was ever compiled), the pages are compiled. Resolves true when it compiled.
 */
export async function syncBrain(db: Db, tenantId: string, projectId: string, at: Date, change?: (w: Writer, state: BrainState) => Promise<void>, onSkip: SkipReport = quiet): Promise<boolean> {
  return withTx(db, async (tx) => {
    const head = await lockHead(tx, tenantId, projectId);
    const w: Writer = { tx, tenantId, projectId, seq: head.lastSeq, changed: false, onSkip };
    const state = await loadBrain(tx, tenantId, projectId);
    if (change) await change(w, state);
    const mark = await recordsMark(tx, tenantId, projectId);
    if (mark !== head.recordsMark || head.compiledVersion === 0) {
      const latest = new Map<string, BrainSourceRevision>();
      for (const r of state.revisions) if ((latest.get(r.sourceId)?.revision ?? 0) < r.revision) latest.set(r.sourceId, r);
      const produced = new Set<string>();
      for (const d of await recordSources(tx, tenantId, projectId)) {
        produced.add(d.sourceId);
        const prev = latest.get(d.sourceId);
        if (prev && prev.contentSha256 === contentSha(d)) continue;
        await writeRevision(w, d, prev, at);
      }
      // A record that is gone (a task replanned away) leaves an empty revision behind, so its claims go stale rather than staying current forever.
      for (const prev of latest.values()) {
        if (produced.has(prev.sourceId) || prev.kind === 'note' || prev.kind === 'repo_manifest' || prev.sections.length === 0) continue;
        await writeRevision(w, { ...prev, title: `${prev.title} (no longer in the records)`.slice(0, 200), sections: [] }, prev, at);
      }
      await tx.update(schema.brainHeads).set({ recordsMark: mark }).where(where(schema.brainHeads, tenantId, projectId));
    }
    if (w.changed || head.compiledVersion === 0) {
      await publish(w, head.compiledVersion + 1, at);
      return true;
    }
    return false;
  });
}

/** Whether the last compilation already read the records as they are now: one unlocked fingerprint read, the same check the periodic pass makes. */
export async function brainCurrent(db: Executor, tenantId: string, projectId: string): Promise<boolean> {
  const [head] = await db.select().from(schema.brainHeads).where(where(schema.brainHeads, tenantId, projectId));
  return head !== undefined && head.compiledVersion > 0 && head.recordsMark === (await recordsMark(db, tenantId, projectId));
}

/**
 * The periodic pass: compiles each of the tenant's projects whose records moved (a verifier's verdict, a merge the reconciler saw) without waiting for anyone to look.
 * One unlocked fingerprint read per project when nothing moved. Resolves with the projects it compiled.
 */
export async function refreshBrains(ctx: { db: Db; tenantId: string; now: () => Date; onSkip?: SkipReport; onError?: (entry: { projectId: string; error: string; code: unknown }) => void }): Promise<string[]> {
  const compiled: string[] = [];
  const projects = await ctx.db.select({ projectId: schema.projects.projectId }).from(schema.projects).where(eq(schema.projects.tenantId, ctx.tenantId)).orderBy(asc(schema.projects.projectId));
  for (const { projectId } of projects) {
    // One project that cannot be compiled never stalls the others. It is reported by error name and code only: a failed query's parameters can hold source text.
    try {
      const [head] = await ctx.db.select().from(schema.brainHeads).where(where(schema.brainHeads, ctx.tenantId, projectId));
      const current = head !== undefined && head.compiledVersion > 0 && head.recordsMark === (await recordsMark(ctx.db, ctx.tenantId, projectId));
      if (!current && (await syncBrain(ctx.db, ctx.tenantId, projectId, ctx.now(), undefined, ctx.onSkip))) compiled.push(projectId);
    } catch (err) {
      ctx.onError?.({ projectId, error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code ?? null });
    }
    // Product events written before the project had a run, appended once it has one. Its own try: a backlog that cannot be written never stalls the Brain, and the
    // reverse.
    try {
      await flushProductEvents(ctx.db, ctx.tenantId, projectId, ctx.now());
    } catch (err) {
      ctx.onError?.({ projectId, error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown } | null)?.code ?? null });
    }
  }
  return compiled;
}

// ---- the bundle at claim ------------------------------------------------------------------------------------------

/**
 * The context bundle for one claimed attempt, recorded with it. Runs after the claim committed, outside its transaction, and compiles nothing: it serves the last
 * compilation, re-checked for revocation and for what this attempt may see. Reads: the spec, the last compilation, the revocations, and the revisions (sections of
 * the latest revision of each source only, for the staleness check).
 */
export async function bundleForAttempt(db: Db, lease: { tenantId: string; projectId: string; taskId: string; revision: number; attemptId: string; location: BrainDestination; streamable?: boolean | undefined }, at: Date): Promise<BrainBundle | null> {
  const row = await loadSpecRow(db, lease);
  const spec = TaskSpecSchema.safeParse(row?.spec);
  if (!spec.success) return null;
  const s = spec.data;
  const { tenantId, projectId } = lease;
  const [head] = await db.select().from(schema.brainHeads).where(where(schema.brainHeads, tenantId, projectId));
  const [c] = await db.select().from(schema.brainCompilations).where(where(schema.brainCompilations, tenantId, projectId)).orderBy(desc(schema.brainCompilations.version)).limit(1);
  const compilation = c ? BrainCompilationSchema.parse({ version: c.version, generator: { id: c.generatorId, version: c.generatorVersion }, generatedAt: c.generatedAt.toISOString(), watermark: c.watermark, pages: c.pages, conflicts: c.conflicts }) : null;
  const revocations = (await db.select().from(schema.brainRevocations).where(where(schema.brainRevocations, tenantId, projectId))).map(toRevocation);
  const rows = await db.execute(sql`SELECT source_id, revision, kind, title, standing, classification, allowed_use, provenance, derived_from, task_id, content_sha256, seq, recorded_at,
      CASE WHEN revision = max(revision) OVER (PARTITION BY source_id) THEN sections ELSE '[]'::jsonb END AS sections
    FROM brain_sources WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`);
  const revisions = rows.map((r) => toRevision({
    tenantId, projectId, sourceId: String(r['source_id']), revision: Number(r['revision']), kind: String(r['kind']), title: String(r['title']), standing: String(r['standing']),
    classification: String(r['classification']), allowedUse: r['allowed_use'] as string[], provenance: r['provenance'] as Record<string, unknown>, derivedFrom: r['derived_from'] as unknown[],
    taskId: (r['task_id'] as string | null) ?? null, sections: r['sections'] as unknown[], contentSha256: String(r['content_sha256']), seq: Number(r['seq']), recordedAt: new Date(r['recorded_at'] as string),
  }));
  // One cheap fingerprint read: when the records moved since the last sync (a verdict the periodic pass has not read yet), the bundle says so rather than calling
  // its claims current.
  const recordsPending = head?.recordsMark !== (await recordsMark(db, tenantId, projectId));
  const bundle = buildContextBundle({
    compilation, revisions, revocations, sourceHead: head?.lastSeq ?? 0, destination: lease.location, recordsPending,
    // Anything but a clear yes from the claim is treated as output that may leave the device: restricted claims are then left out.
    streamable: lease.streamable !== false,
    task: { taskId: s.taskId, baseSha: s.baseSha, criteria: [...s.requirementIds, ...s.acceptanceCheckIds, ...(s.criteria ?? []).map((x) => x.id)], dependsOn: s.dependencies.map((d) => d.taskId), paths: s.allowedPaths },
  });
  await db.insert(schema.brainBundles).values({ tenantId, projectId, attemptId: lease.attemptId, taskId: s.taskId, destination: lease.location, compilationVersion: bundle.compilationVersion, bundle, createdAt: at }).onConflictDoNothing();
  return bundle;
}

// ---- views --------------------------------------------------------------------------------------------------------

async function brainView(db: Executor, tenantId: string, projectId: string, now: Date) {
  const state = await loadBrain(db, tenantId, projectId);
  const latest = new Map<string, BrainSourceRevision>();
  for (const r of state.revisions) if ((latest.get(r.sourceId)?.revision ?? 0) < r.revision) latest.set(r.sourceId, r);
  const revokedIds = new Set(state.revocations.map((r) => r.sourceId));
  const resolved = new Set(state.resolutions.map((r) => r.conflictId));
  // Open conflicts come from the current compilation; settled ones from the snapshot kept with their resolution.
  const open = (state.compilation?.conflicts ?? []).filter((c) => !resolved.has(c.conflictId)).map((c) => ({ ...c, state: 'open' as const, resolvedBy: null, resolvedAt: null }));
  const kept = state.resolutions.filter((r) => r.conflict !== null).map((r) => ({ ...(r.conflict as Record<string, unknown>), state: r.outcome, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt.toISOString() }));
  return {
    projectId,
    observedAt: now.toISOString(),
    sourceHead: state.lastSeq,
    indexLag: Math.max(0, state.lastSeq - (state.compilation?.watermark ?? 0)),
    compilation: state.compilation,
    sources: [...latest.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)).map((r) => ({
      sourceId: r.sourceId, kind: r.kind, title: r.title, standing: r.standing, classification: r.classification, allowedUse: r.allowedUse, provenance: r.provenance,
      latestRevision: r.revision, recordedAt: r.recordedAt, revoked: revokedIds.has(r.sourceId), sectionCount: r.sections.length,
    })),
    revocations: state.revocations,
    conflicts: [...open, ...kept],
  };
}

// ---- routes -------------------------------------------------------------------------------------------------------

const ownerOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
  return req.principal.uid;
};

export function registerBrainRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  /** A record that cannot be stored: logged by id and code, and the sync goes on without it. */
  const onSkip: SkipReport = (skip) => app.log.warn(skip, 'a Project Brain source could not be stored and was skipped');
  const sync = (projectId: string, change?: Parameters<typeof syncBrain>[4]) => syncBrain(db, config.tenantId, projectId, now(), change, onSkip);

  // Compile on change: after an owner write that changes what sources are read from (a plan accepted, an approval resolved, reduced scope accepted, a reclassification
  // decided, a stack saved, a product record written, a project activated), just before the answer is sent. It runs outside that write's transaction and takes only the brain lock. A failure is logged; the next
  // periodic pass or owner read compiles it.
  const project = async (url: string, id: string): Promise<string | null> => {
    if (url.startsWith('/v1/projects/') || url.startsWith('/v1/onboarding/')) return id;
    if (url.startsWith('/v1/runs/')) return (await db.select({ p: schema.runs.projectId }).from(schema.runs).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.runId, id))))[0]?.p ?? null;
    if (url.startsWith('/v1/approvals/')) return (await db.select({ p: schema.approvals.projectId }).from(schema.approvals).where(and(eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.approvalId, id))))[0]?.p ?? null;
    return null;
  };
  const CHANGES = /^\/v1\/(?:runs\/[^/]+\/(?:plan-revisions|accept-reduced-scope)|approvals\/[^/]+\/resolve|projects\/[^/]+\/(?:draft-reclassifications|stack|product\/(?:brief|outcome-plans|releases|outcome-reviews))|onboarding\/[^/]+\/activate)$/;
  // Before the answer is sent: the write has committed by then, and a caller that reads the Brain next sees the compile. Its failure never changes the answer.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'POST' || reply.statusCode >= 300 || req.principal?.kind !== 'owner' || !CHANGES.test(req.routeOptions.url ?? '')) return payload;
    try {
      const projectId = await project(req.routeOptions.url ?? '', (req.params as { id?: string }).id ?? '');
      if (projectId && (await db.select({ p: schema.projects.projectId }).from(schema.projects).where(and(eq(schema.projects.tenantId, config.tenantId), eq(schema.projects.projectId, projectId)))).length > 0) await sync(projectId);
    } catch (err) {
      app.log.warn({ error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown } | null)?.code ?? null }, 'compiling the Project Brain after a change failed; the next pass retries');
    }
    return payload;
  });
  const projectOf = async (req: FastifyRequest): Promise<string> => {
    ownerOf(req);
    const id = (req.params as { id: string }).id;
    await requireProject(db, config.tenantId, id);
    return id;
  };

  app.get('/v1/projects/:id/brain', auth, async (req) => {
    const projectId = await projectOf(req);
    // Reads records only when their fingerprint moved since the last sync, and compiles only when that wrote something.
    await sync(projectId);
    return brainView(db, config.tenantId, projectId, now());
  });

  app.get('/v1/projects/:id/brain/sources/:sourceId/revisions/:revision', auth, async (req) => {
    const projectId = await projectOf(req);
    const { sourceId, revision } = req.params as { sourceId: string; revision: string };
    const n = Number(revision);
    const [row] = Number.isInteger(n) && n > 0 ? await db.select().from(schema.brainSources).where(and(where(schema.brainSources, config.tenantId, projectId), eq(schema.brainSources.sourceId, sourceId), eq(schema.brainSources.revision, n))) : [];
    if (!row) throw new AppError(404, 'brain_source_not_found', 'no such source revision');
    const [revoked] = await db.select().from(schema.brainRevocations).where(and(where(schema.brainRevocations, config.tenantId, projectId), eq(schema.brainRevocations.sourceId, sourceId)));
    return { ...toRevision(row), revocation: revoked ? toRevocation(revoked) : null };
  });

  app.post('/v1/projects/:id/brain/notes', auth, async (req, reply) => {
    const projectId = await projectOf(req);
    const uid = ownerOf(req);
    const body = parseBody(BrainNoteRequestSchema, req.body);
    const all = [body.title, ...body.sections.flatMap((s) => [s.heading, s.text])];
    if (all.some((s) => redactSecrets(s) !== s)) throw new AppError(400, 'credential_in_input', 'the note contains something shaped like a secret; it was not stored');
    const project = await requireProject(db, config.tenantId, projectId);
    const sourceId = `note:${newId('n').slice(2)}`;
    let stored: BrainSourceRevision | null = null;
    await sync(projectId, async (w, state) => {
      for (const p of body.derivedFrom ?? []) if (!state.revisions.some((r) => r.sourceId === p.sourceId && r.revision === p.revision)) throw invalidRequest('derivedFrom names a source revision that does not exist');
      const classification = label(project.classification, body.classification ?? project.classification);
      stored = await writeRevision(w, draft({
        sourceId, kind: 'note', title: text(body.title, 200) || 'Note', standing: 'proposed', classification, provenance: { origin: 'owner', ref: sourceId, recordedBy: uid }, taskId: null,
        derivedFrom: body.derivedFrom ?? [],
        sections: body.sections.map((s, i) => sec(`section-${i + 1}`, s.heading, s.text, s.key ?? `note:${sourceId.slice(5)}:${i + 1}`)),
      }), undefined, now());
      if (stored === null) throw invalidRequest('the note could not be stored as a source');
    });
    return reply.code(201).send({ source: stored, brain: await brainView(db, config.tenantId, projectId, now()) });
  });

  app.post('/v1/projects/:id/brain/sources/:sourceId/revoke', auth, async (req) => {
    const projectId = await projectOf(req);
    const uid = ownerOf(req);
    const { sourceId } = req.params as { sourceId: string };
    const body = parseBody(BrainRevokeRequestSchema, req.body);
    if (redactSecrets(body.reason) !== body.reason) throw new AppError(400, 'credential_in_input', 'the reason contains something shaped like a secret');
    await sync(projectId, async (w, state) => {
      if (!state.revisions.some((r) => r.sourceId === sourceId)) throw new AppError(404, 'brain_source_not_found', 'no such source');
      if (state.revocations.some((r) => r.sourceId === sourceId)) throw new AppError(409, 'brain_source_revoked', 'this source is already revoked');
      w.seq += 1;
      w.changed = true;
      await w.tx.insert(schema.brainRevocations).values({ tenantId: config.tenantId, projectId, sourceId, reason: text(body.reason, 200), revokedBy: uid, revokedAt: now(), seq: w.seq });
    });
    return brainView(db, config.tenantId, projectId, now());
  });

  app.post('/v1/projects/:id/brain/conflicts/:conflictId/keep', auth, async (req) => {
    const projectId = await projectOf(req);
    const uid = ownerOf(req);
    const { conflictId } = req.params as { conflictId: string };
    await sync(projectId, async (w, state) => {
      if (state.resolutions.some((r) => r.conflictId === conflictId)) throw new AppError(409, 'brain_conflict_resolved', 'this conflict is already settled');
      const conflict = (state.compilation?.conflicts ?? []).find((c) => c.conflictId === conflictId);
      if (!conflict) throw new AppError(404, 'brain_conflict_not_found', 'no such open conflict');
      await w.tx.insert(schema.brainConflictResolutions).values({ tenantId: config.tenantId, projectId, conflictId, outcome: 'kept_accepted', resolvedBy: uid, resolvedAt: now(), conflict });
      w.changed = true;
    });
    return brainView(db, config.tenantId, projectId, now());
  });

  app.get('/v1/projects/:id/attempts/:attemptId/context', auth, async (req) => {
    const projectId = await projectOf(req);
    const { attemptId } = req.params as { attemptId: string };
    const [row] = await db.select().from(schema.brainBundles).where(and(where(schema.brainBundles, config.tenantId, projectId), eq(schema.brainBundles.attemptId, attemptId)));
    if (!row) throw new AppError(404, 'attempt_not_found', 'no context bundle was recorded for this attempt');
    return { attemptId, taskId: row.taskId, destination: row.destination, recordedAt: row.createdAt.toISOString(), bundle: row.bundle };
  });

  // A runner's manifest of its checkout at the task's base commit, for the attempt it holds. Work whose data stays on the device does not send one.
  app.post('/v1/runners/brain/manifest', { onRequest: [ctx.runner] }, async (req) => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    const body = parseBody(BrainManifestRequestSchema, req.body);
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: body.lease.attemptId, fence: body.lease.fence });
    const [a] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, p.tenantId), eq(schema.attempts.attemptId, body.lease.attemptId)));
    if (!leaseHolds(a, p.runnerId, body.lease, now())) throw stale;
    if (a.detail['terminalStreamable'] !== true) throw new AppError(403, 'brain_manifest_restricted', 'a manifest is not accepted for work whose data stays on the device');
    const project = await requireProject(db, p.tenantId, a.projectId);
    const m: RepoManifest = body.manifest;
    // A path whose key or anchor would not fit is not recorded; the answer and an unkeyed section say how many were left out and why.
    const skipped = m.docs.flatMap((doc, index) => (doc.path.length > REPO_MANIFEST_DOC_PATH_MAX ? [{ index, reason: 'path_too_long' as const }] : []));
    const docs = m.docs.filter((doc) => doc.path.length <= REPO_MANIFEST_DOC_PATH_MAX);
    await syncBrain(db, p.tenantId, a.projectId, now(), async (w, state) => {
      const sourceId = `repo_manifest:${a.projectId}`;
      const prev = state.revisions.filter((r) => r.sourceId === sourceId).sort((x, y) => y.revision - x.revision)[0];
      const d = draft({
        sourceId, kind: 'repo_manifest', title: 'Repository manifest', standing: 'accepted', classification: label(project.classification), taskId: null,
        provenance: { origin: 'runner', ref: m.commit, recordedBy: p.runnerId },
        sections: [
          sec('repo/commit', 'Commit', m.commit, 'repo:commit'),
          sec('repo/files', 'Files', `${m.fileCount} files, ${m.totalBytes} bytes`, 'repo:files'),
          ...[...docs].sort((x, y) => (x.path < y.path ? -1 : 1)).map((doc) => sec(`docs/${doc.path}`, doc.path, `sha256 ${doc.sha256}, ${doc.bytes} bytes`, `repo:doc:${doc.path}`)),
          ...(skipped.length > 0 ? [sec('repo/skipped', 'Documents not recorded', `${skipped.length} document path${skipped.length === 1 ? ' was' : 's were'} too long to record.`)] : []),
        ],
      });
      if (prev && prev.contentSha256 === contentSha(d)) return;
      await writeRevision(w, d, prev, now());
    }, onSkip);
    return { recorded: true, skipped };
  });
}
