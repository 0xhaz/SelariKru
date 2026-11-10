import { randomUUID } from 'node:crypto';
import {
  BlueprintContentSchema, BrainSectionSchema, briefSeed, briefState, buildProductTrace, canConfirmBrief, latestProductRecords, milestoneSummaries, OutcomePlanContentSchema,
  OutcomeReviewContentSchema, PRODUCT_NOTICE, ProblemBriefContentSchema, productLabel, ProductRecordSchema, ReleaseNoteContentSchema, TaskSpecSchema,
  type Actor, type BrainCitation, type BrainClassification, type ProductRecord, type ProductRecordKind, type TraceInput, type TraceRun,
} from '@selarikru/domain';
import { schema, withTx, type Db, type Executor } from '@selarikru/persistence';
import { OutcomePlanRequestSchema, OutcomeReviewRequestSchema, ProductBriefProposalRequestSchema, ProductBriefRequestSchema, redactSecrets, ReleaseNoteRequestSchema } from '@selarikru/protocol';
import { loadRunEvidence } from '@selarikru/workflow';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from './app.ts';
import { syncBrain } from './brain.ts';
import { AppError, invalidRequest, staleRevision } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { eventRunFor } from './settings.ts';
import { requireProject, writeEvent } from './store.ts';

/**
 * Product-learning records (docs/product-engineer-alignment.md §4 and phase 1 of §7): the problem brief, outcome plans, manual release notes and manual outcome reviews, and
 * the trace from each accepted requirement through its implementation evidence to its outcome. No analytics, no experiment service, no model: the trace and the milestone
 * summaries are derived on read by the domain code from records this server already holds.
 *
 * Locking: a write takes the project's `product_heads` row first, with no other lock held, then appends its revision and, last, its event (the event sequence comes after every
 * other lock, as everywhere). Everything else it consults (the plan, candidates, verification records, pull requests, Brain revisions) is read without a lock. No path here takes
 * the scheduler lock, a run row, a status row or the brain lock, and no other path takes `product_heads`. A Brain compile follows an owner write after its transaction committed,
 * through the Brain's `onSend` hook. See the lock order in services/workflow/src/verification.ts.
 *
 * Authority: only an owner session writes or confirms. A worker can only propose a brief, for the attempt it holds and only when that attempt's data may leave the device; the
 * database refuses a worker's confirmed revision. Events carry ids, kinds and revisions, never record text. Owner and worker text is redacted for secrets before it is stored.
 * A review never touches a task: its follow-up is a proposal that enters a plan only through a plan revision.
 */

const where = <T extends { tenantId: unknown; projectId: unknown }>(t: T, tenantId: string, projectId: string) => and(eq(t.tenantId as never, tenantId), eq(t.projectId as never, projectId));

const toRecord = (r: typeof schema.productRecords.$inferSelect): ProductRecord | null => {
  const p = ProductRecordSchema.safeParse({
    recordId: r.recordId, kind: r.kind, revision: r.revision, status: r.status, classification: r.classification, proposedBy: { kind: r.proposedByKind, id: r.proposedBy },
    confirmedBy: r.confirmedBy, recordedAt: r.recordedAt.toISOString(), seq: r.seq, content: r.content,
  });
  return p.success ? p.data : null;
};

/** Every stored revision, in log order. A row this build cannot read is left out rather than guessed at. */
export async function loadProductRecords(db: Executor, tenantId: string, projectId: string): Promise<ProductRecord[]> {
  const rows = await db.select().from(schema.productRecords).where(where(schema.productRecords, tenantId, projectId)).orderBy(asc(schema.productRecords.seq));
  return rows.map(toRecord).filter((r): r is ProductRecord => r !== null);
}

/** Every string in a value with secret-shaped text replaced. */
function redactDeep<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const r = redactSecrets(v); if (r !== v) redacted = true; return r; }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, redacted };
}
/** Redacts, then validates again: redaction must not turn a valid record into an invalid one silently. */
function clean<S extends z.ZodType>(s: S, content: z.infer<S>): { content: z.infer<S>; redacted: boolean } {
  const r = redactDeep(content);
  const again = s.safeParse(r.value);
  if (!again.success) throw new AppError(400, 'credential_in_input', 'this contains something shaped like a secret where it cannot be redacted; nothing was stored');
  return { content: again.data, redacted: r.redacted };
}

// ---- reading the records a trace rests on ---------------------------------------------------------------------------------------

interface PlanTask { readonly taskId: string; readonly runId: string; readonly title: string; readonly status: string; readonly revision: number; readonly requirementIds: string[]; readonly evidenceIds: string[]; readonly criteria: { id: string; text: string }[]; readonly classification: string }

/** The current plan of the latest planned run: each task at its current revision. */
async function currentPlan(db: Executor, tenantId: string, projectId: string): Promise<PlanTask[]> {
  const [run] = await db.select().from(schema.runs).where(and(where(schema.runs, tenantId, projectId), isNotNull(schema.runs.planRevision))).orderBy(desc(schema.runs.createdAt), desc(schema.runs.runId)).limit(1);
  if (!run) return [];
  const rows = await db.select({ spec: schema.taskRevisions.spec, status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision }).from(schema.taskStatus).innerJoin(schema.taskRevisions, and(
    eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
    eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
  )).where(and(where(schema.taskStatus, tenantId, projectId), eq(schema.taskRevisions.runId, run.runId))).orderBy(asc(schema.taskStatus.taskId));
  return rows.flatMap((r) => {
    const p = TaskSpecSchema.safeParse(r.spec);
    if (!p.success) return [];
    const s = p.data;
    const criteria = (s.criteria ?? []).map((c) => ({ id: c.id, text: c.text }));
    return [{ taskId: s.taskId, runId: s.runId, title: s.title, status: r.status, revision: r.revision, requirementIds: [...s.requirementIds], evidenceIds: [...new Set([...s.requirementIds, ...criteria.map((c) => c.id)])], criteria, classification: s.classification }];
  });
}

async function acceptedBlueprint(db: Executor, tenantId: string, projectId: string) {
  const [o] = await db.select().from(schema.projectOnboardings).where(and(where(schema.projectOnboardings, tenantId, projectId), isNotNull(schema.projectOnboardings.acceptedBlueprintVersion)));
  if (!o) return null;
  const [bp] = await db.select().from(schema.projectBlueprints).where(and(where(schema.projectBlueprints, tenantId, projectId), eq(schema.projectBlueprints.version, o.acceptedBlueprintVersion!)));
  const p = BlueprintContentSchema.safeParse(bp?.content);
  return p.success ? p.data : null;
}

interface Inputs { readonly trace: TraceInput; readonly tasks: PlanTask[]; readonly blueprint: Awaited<ReturnType<typeof acceptedBlueprint>>; readonly prs: (typeof schema.changeRequests.$inferSelect)[] }

async function loadInputs(db: Executor, ctx: AppContext, tenantId: string, projectId: string, records: readonly ProductRecord[]): Promise<Inputs> {
  const tasks = await currentPlan(db, tenantId, projectId);
  const blueprint = await acceptedBlueprint(db, tenantId, projectId);
  const requirements = new Map<string, string | null>();
  for (const c of blueprint?.acceptanceCriteria ?? []) requirements.set(c.id, c.text);
  for (const t of tasks) for (const c of t.criteria) if (!requirements.get(c.id)) requirements.set(c.id, c.text);
  for (const t of tasks) for (const id of t.evidenceIds) if (!requirements.has(id)) requirements.set(id, null);
  const prs = await db.select().from(schema.changeRequests).where(where(schema.changeRequests, tenantId, projectId));
  const bar = ctx.evidence ? { trusted: ctx.evidence.trusted(), artifacts: ctx.evidence.artifacts } : null;
  const runs: TraceRun[] = [];
  for (const runId of [...new Set(tasks.map((t) => t.runId))].sort()) {
    // Read with the bar the pull-request route uses. A store that cannot be read counts no pass, as on the snapshot.
    const ev = await loadRunEvidence(db, { tenantId, projectId, runId }, tasks.filter((t) => t.runId === runId).map((t) => ({ taskId: t.taskId, revision: t.revision, status: t.status, requirementIds: t.evidenceIds })), bar).catch(() => null);
    const pr = prs.find((p) => p.runId === runId);
    runs.push({
      runId,
      candidate: ev?.evidence.candidate ? { sha: ev.evidence.candidate.sha, live: ev.evidence.candidate.live, recordId: ev.evidence.candidate.recordId, recordValid: ev.evidence.candidate.recordValid } : null,
      criteria: (ev?.evidence.criteria ?? []).map((c) => ({ criterionId: c.criterionId, state: c.state, verified: c.verified, candidateSha: c.candidateSha })),
      pullRequest: pr ? { prNumber: pr.prNumber, url: pr.url, status: pr.status, mergeCommitSha: pr.mergeCommitSha } : null,
    });
  }
  return {
    trace: { requirements: [...requirements.entries()].map(([id, text]) => ({ id, text })), tasks: tasks.map((t) => ({ taskId: t.taskId, runId: t.runId, title: t.title, status: t.status, requirementIds: t.evidenceIds })), runs, records },
    tasks, blueprint, prs,
  };
}

/** A citation resolves when the revision is stored and has the anchor. Returns each cited revision's label. */
async function citedLabels(db: Executor, tenantId: string, projectId: string, cites: readonly BrainCitation[]): Promise<BrainClassification[]> {
  const out: BrainClassification[] = [];
  for (const c of cites) {
    const [row] = await db.select({ sections: schema.brainSources.sections, classification: schema.brainSources.classification }).from(schema.brainSources)
      .where(and(where(schema.brainSources, tenantId, projectId), eq(schema.brainSources.sourceId, c.sourceId), eq(schema.brainSources.revision, c.revision)));
    const anchors = (row?.sections ?? []).map((s) => BrainSectionSchema.safeParse(s)).flatMap((p) => (p.success ? [p.data.anchor] : []));
    if (!row || !anchors.includes(c.anchor)) throw new AppError(422, 'product_citation_invalid', `the cited evidence ${c.sourceId}@${c.revision}#${c.anchor} is not a stored Project Brain revision and anchor`);
    out.push(productLabel(row.classification));
  }
  return out;
}

// ---- the view -----------------------------------------------------------------------------------------------------------------------

export async function productView(db: Executor, ctx: AppContext, tenantId: string, projectId: string, now: Date) {
  const records = await loadProductRecords(db, tenantId, projectId);
  const inputs = await loadInputs(db, ctx, tenantId, projectId, records);
  const brief = briefState(records);
  const latest = latestProductRecords(records);
  let seed = brief.latest?.content ?? null;
  if (seed === null && inputs.blueprint) {
    // The accepted brief as the Project Brain holds it, so the seed cites real revisions and anchors.
    const [src] = await db.select({ revision: schema.brainSources.revision, sections: schema.brainSources.sections }).from(schema.brainSources)
      .where(and(where(schema.brainSources, tenantId, projectId), eq(schema.brainSources.sourceId, `brief:${projectId}`))).orderBy(desc(schema.brainSources.revision)).limit(1);
    const anchors = (src?.sections ?? []).flatMap((s) => { const p = BrainSectionSchema.safeParse(s); return p.success && p.data.anchor.startsWith('goals/') ? [p.data.anchor] : []; });
    const onboarding = (await db.select({ by: schema.projectOnboardings.createdBy }).from(schema.projectOnboardings).where(where(schema.projectOnboardings, tenantId, projectId)))[0];
    seed = briefSeed({ owner: onboarding?.by ?? 'owner', goals: inputs.blueprint.goals, assumptions: inputs.blueprint.assumptions, nonGoals: inputs.blueprint.nonGoals, briefSource: src && anchors.length > 0 ? { sourceId: `brief:${projectId}`, revision: src.revision, anchors } : null });
  }
  const releases = latest.filter((r) => r.kind === 'release_note');
  return {
    projectId, observedAt: now.toISOString(), notice: PRODUCT_NOTICE,
    brief: { confirmed: brief.confirmed, latest: brief.latest, seed, revision: brief.latest?.revision ?? 0 },
    plans: latest.filter((r) => r.kind === 'outcome_plan'),
    releases,
    reviews: latest.filter((r) => r.kind === 'outcome_review'),
    followUps: latest.flatMap((r) => (r.kind === 'outcome_review' && r.content.followUp
      ? [{ reviewRecordId: r.recordId, title: r.content.followUp.title, requirementIds: r.content.followUp.requirementIds, reason: r.content.followUp.reason, decision: r.content.decision, state: 'proposed' as const }] : [])),
    requirements: inputs.trace.requirements,
    mergedRuns: inputs.prs.filter((p) => p.status === 'merged' && p.mergeCommitSha !== null).sort((a, b) => (a.runId < b.runId ? -1 : 1))
      .map((p) => ({ runId: p.runId, prNumber: p.prNumber, mergeCommitSha: p.mergeCommitSha!, released: releases.some((r) => r.kind === 'release_note' && r.content.runId === p.runId) })),
    trace: buildProductTrace(inputs.trace),
    milestones: milestoneSummaries(inputs.trace),
  };
}

// ---- writing ------------------------------------------------------------------------------------------------------------------------

interface WriteSpec {
  readonly tenantId: string;
  readonly projectId: string;
  readonly recordId: string;
  readonly kind: ProductRecordKind;
  readonly status: ProductRecord['status'];
  readonly classification: BrainClassification;
  readonly content: unknown;
  readonly proposedBy: { readonly kind: 'human' | 'worker'; readonly id: string };
  readonly confirmedBy: string | null;
  /** The revision last read; null appends the next revision whatever it is (a worker's proposal never overwrites). */
  readonly expectedRevision: number | null;
  readonly actor: Actor;
  readonly type: 'product.recorded' | 'product.proposed';
  readonly action: string;
  readonly extra?: Record<string, unknown>;
  readonly attemptId?: string;
  readonly taskId?: string | null;
  readonly at: Date;
}

/** The product lock, the revision, then the event. See the note at the top of this file. */
async function writeRecord(db: Db, w: WriteSpec): Promise<ProductRecord> {
  return withTx(db, async (tx) => {
    await tx.insert(schema.productHeads).values({ tenantId: w.tenantId, projectId: w.projectId }).onConflictDoNothing();
    const [head] = await tx.select().from(schema.productHeads).where(where(schema.productHeads, w.tenantId, w.projectId)).for('update');
    const [prev] = await tx.select({ revision: schema.productRecords.revision }).from(schema.productRecords)
      .where(and(where(schema.productRecords, w.tenantId, w.projectId), eq(schema.productRecords.recordId, w.recordId))).orderBy(desc(schema.productRecords.revision)).limit(1);
    const current = prev?.revision ?? 0;
    if (w.expectedRevision !== null && w.expectedRevision !== current) throw staleRevision(current, 'this record');
    const runId = await eventRunFor(tx, w.tenantId, w.projectId, w.taskId ?? null);
    if (runId === null) throw new AppError(409, 'product_needs_run', 'product records are kept with a run\'s history, and this project has no run yet; nothing was stored');
    const seq = head!.lastSeq + 1;
    const revision = current + 1;
    const [row] = await tx.insert(schema.productRecords).values({
      tenantId: w.tenantId, projectId: w.projectId, recordId: w.recordId, revision, kind: w.kind, status: w.status, classification: w.classification, content: w.content as Record<string, unknown>,
      proposedByKind: w.proposedBy.kind, proposedBy: w.proposedBy.id, confirmedBy: w.confirmedBy, seq, recordedAt: w.at,
    }).returning();
    await tx.update(schema.productHeads).set({ lastSeq: seq }).where(where(schema.productHeads, w.tenantId, w.projectId));
    await writeEvent(tx, w.at, {
      projectId: w.projectId, runId, taskId: runId, aggregateRevision: seq, type: w.type, actor: w.actor, ...(w.attemptId ? { attemptId: w.attemptId } : {}),
      payload: { recordId: w.recordId, kind: w.kind, revision, status: w.status, classification: w.classification, action: w.action, ...w.extra },
    });
    const rec = toRecord(row!);
    if (!rec) throw invalidRequest('the record could not be stored');
    return rec;
  });
}

const latestOf = async (db: Executor, tenantId: string, projectId: string, recordId: string): Promise<ProductRecord | null> =>
  latestProductRecords(await loadProductRecords(db, tenantId, projectId)).find((r) => r.recordId === recordId) ?? null;

// ---- routes ---------------------------------------------------------------------------------------------------------------------------

export function registerProductRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const tenantId = config.tenantId;
  const ownerOf = async (req: FastifyRequest) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const projectId = (req.params as { id: string }).id;
    const project = await requireProject(db, tenantId, projectId);
    return { projectId, uid: req.principal.uid, project, actor: { kind: 'human' as const, id: req.principal.uid } };
  };
  const view = (projectId: string) => productView(db, ctx, tenantId, projectId, now());
  const raise = (l: string | undefined) => l ?? 'public';

  app.get('/v1/projects/:id/product', auth, async (req) => {
    const { projectId } = await ownerOf(req);
    // The seed cites the accepted brief's revision in the Project Brain, so the Brain is brought up to date first. It reads records only when they moved.
    await syncBrain(db, tenantId, projectId, now()).catch((err: unknown) => app.log.warn({ error: err instanceof Error ? err.name : 'unknown' }, 'the Project Brain could not be compiled before the product view'));
    return view(projectId);
  });

  app.post('/v1/projects/:id/product/brief', auth, async (req, reply) => {
    const { projectId, uid, project, actor } = await ownerOf(req);
    const body = parseBody(ProductBriefRequestSchema, req.body);
    if (body.confirm && !canConfirmBrief(actor.kind)) throw new AppError(403, 'wrong_principal_type', 'only a person can confirm a brief');
    const { content, redacted } = clean(ProblemBriefContentSchema, body.content);
    const classification = productLabel(project.classification, raise(body.classification), ...(await citedLabels(db, tenantId, projectId, content.evidence)));
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: 'brief', kind: 'problem_brief', status: body.confirm ? 'confirmed' : 'proposed', classification, content, proposedBy: { kind: 'human', id: uid },
      confirmedBy: body.confirm ? uid : null, expectedRevision: body.expectedRevision, actor, type: 'product.recorded', action: body.confirm ? 'brief_confirmed' : 'brief_saved', at: now(),
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  /** The labels of the tasks that carry these requirements. A plan about restricted work is restricted. */
  const taskLabels = async (projectId: string, pick: (t: PlanTask) => boolean) => (await currentPlan(db, tenantId, projectId)).filter(pick).map((t) => t.classification);

  app.post('/v1/projects/:id/product/outcome-plans', auth, async (req, reply) => {
    const { projectId, uid, project, actor } = await ownerOf(req);
    const body = parseBody(OutcomePlanRequestSchema, req.body);
    const { content, redacted } = clean(OutcomePlanContentSchema, body.content);
    const records = await loadProductRecords(db, tenantId, projectId);
    const known = new Set((await loadInputs(db, ctx, tenantId, projectId, records)).trace.requirements.map((r) => r.id));
    const unknown = content.requirementIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new AppError(422, 'product_requirement_unknown', `this project has no accepted requirement ${unknown.join(', ')}`);
    if (body.recordId !== null && !records.some((r) => r.recordId === body.recordId && r.kind === 'outcome_plan')) throw new AppError(404, 'product_record_not_found', 'no such outcome plan');
    const classification = productLabel(project.classification, raise(body.classification), ...(await taskLabels(projectId, (t) => t.evidenceIds.some((id) => content.requirementIds.includes(id)))));
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: body.recordId ?? `plan:${randomUUID()}`, kind: 'outcome_plan', status: 'recorded', classification, content, proposedBy: { kind: 'human', id: uid }, confirmedBy: null,
      expectedRevision: body.recordId === null ? 0 : body.expectedRevision, actor, type: 'product.recorded', action: body.recordId === null ? 'outcome_plan_added' : 'outcome_plan_revised', at: now(),
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  app.post('/v1/projects/:id/product/releases', auth, async (req, reply) => {
    const { projectId, uid, project, actor } = await ownerOf(req);
    const body = parseBody(ReleaseNoteRequestSchema, req.body);
    const { content, redacted } = clean(ReleaseNoteContentSchema, body.content);
    const [run] = await db.select().from(schema.runs).where(and(where(schema.runs, tenantId, projectId), eq(schema.runs.runId, content.runId)));
    if (!run) throw new AppError(404, 'run_not_found', 'no such run in this project');
    const [pr] = await db.select().from(schema.changeRequests).where(and(where(schema.changeRequests, tenantId, projectId), eq(schema.changeRequests.runId, content.runId)));
    // A release follows a merge a person made on GitHub. Nothing here deploys, and a merge alone is not a release.
    if (pr?.status !== 'merged' || pr.mergeCommitSha === null) throw new AppError(409, 'product_not_merged', 'a release note needs a merged run, and a person merges on GitHub; nothing was stored');
    const specs = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(where(schema.taskRevisions, tenantId, projectId), eq(schema.taskRevisions.runId, content.runId)));
    const labels = specs.map((s) => { const p = TaskSpecSchema.safeParse(s.spec); return p.success ? p.data.classification : 'secret'; });
    const classification = productLabel(project.classification, raise(body.classification), ...labels);
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: `release:${randomUUID()}`, kind: 'release_note', status: 'recorded', classification, content, proposedBy: { kind: 'human', id: uid }, confirmedBy: null,
      expectedRevision: 0, actor, type: 'product.recorded', action: 'release_note_recorded', extra: { runId: content.runId }, at: now(),
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  app.post('/v1/projects/:id/product/outcome-reviews', auth, async (req, reply) => {
    const { projectId, uid, project, actor } = await ownerOf(req);
    const body = parseBody(OutcomeReviewRequestSchema, req.body);
    const { content, redacted } = clean(OutcomeReviewContentSchema, body.content);
    const plan = await latestOf(db, tenantId, projectId, content.planRecordId);
    const release = await latestOf(db, tenantId, projectId, content.releaseRecordId);
    if (plan?.kind !== 'outcome_plan') throw new AppError(404, 'product_record_not_found', 'no such outcome plan');
    if (release?.kind !== 'release_note') throw new AppError(404, 'product_record_not_found', 'no such release note');
    const classification = productLabel(project.classification, raise(body.classification), plan.classification, release.classification, ...(await citedLabels(db, tenantId, projectId, content.evidence)));
    // A review records a decision. It touches no task: a follow-up stays a proposal until a person puts it in a plan revision.
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: `review:${randomUUID()}`, kind: 'outcome_review', status: 'recorded', classification, content, proposedBy: { kind: 'human', id: uid }, confirmedBy: null,
      expectedRevision: 0, actor, type: 'product.recorded', action: 'outcome_review_recorded', extra: { decision: content.decision, followUpProposed: content.followUp !== null, planRecordId: plan.recordId, releaseRecordId: release.recordId }, at: now(),
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  // A worker's proposed brief, for the attempt it holds. Only ever a proposal, and never from work whose data stays on the device.
  app.post('/v1/runners/product/brief-proposal', { onRequest: [ctx.runner] }, async (req, reply) => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    const body = parseBody(ProductBriefProposalRequestSchema, req.body);
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: body.lease.attemptId, fence: body.lease.fence });
    const [a] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, p.tenantId), eq(schema.attempts.attemptId, body.lease.attemptId)));
    if (!a || a.runner !== p.runnerId || a.leaseFence !== body.lease.fence || a.leaseToken !== body.lease.leaseToken || a.endedAt !== null) throw stale;
    if (a.detail['terminalStreamable'] !== true) throw new AppError(403, 'product_proposal_restricted', 'a proposal is not accepted from work whose data stays on the device');
    const project = await requireProject(db, p.tenantId, a.projectId);
    const { content } = clean(ProblemBriefContentSchema, body.content);
    const classification = productLabel(project.classification, ...(await citedLabels(db, p.tenantId, a.projectId, content.evidence)));
    const record = await writeRecord(db, {
      tenantId: p.tenantId, projectId: a.projectId, recordId: 'brief', kind: 'problem_brief', status: 'proposed', classification, content, proposedBy: { kind: 'worker', id: p.runnerId }, confirmedBy: null,
      expectedRevision: null, actor: { kind: 'worker', id: p.runnerId }, type: 'product.proposed', action: 'brief_proposed', attemptId: a.attemptId, taskId: a.taskId, at: now(),
    });
    return reply.code(201).send({ recordId: record.recordId, revision: record.revision, status: record.status });
  });
}
