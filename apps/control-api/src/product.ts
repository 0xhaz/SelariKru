import { randomUUID } from 'node:crypto';
import {
  BlueprintContentSchema, BrainSectionSchema, briefSeed, briefState, buildProductTrace, canConfirmBrief, latestProductRecords, milestoneSummaries, OutcomePlanContentSchema,
  OutcomeReviewContentSchema, PRODUCT_NOTICE, ProblemBriefContentSchema, productLabel, ProductRecordSchema, ReleaseNoteContentSchema, TaskSpecSchema,
  type Actor, type BrainCitation, type BrainClassification, type ProblemBriefContent, type ProductRecord, type ProductRecordKind, type TraceInput, type TraceRun,
} from '@selarikru/domain';
import { schema, withTx, type Db, type Executor, type Tx } from '@selarikru/persistence';
import { LeaseRefSchema, OutcomePlanRequestSchema, OutcomeReviewRequestSchema, ProductBriefProposalRequestSchema, ProductBriefRequestSchema, redactSecrets, ReleaseNoteRequestSchema } from '@selarikru/protocol';
import { loadRunEvidence } from '@selarikru/workflow';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './app.ts';
import { brainCurrent, syncBrain } from './brain.ts';
import { AppError, invalidRequest, staleRevision } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { eventRunFor } from './settings.ts';
import { leaseHolds, lockLease, requireProject, staleLease, writeEvent } from './store.ts';

/**
 * Product-learning records (docs/product-engineer-alignment.md §4 and phase 1 of §7): the problem brief, outcome plans, manual release notes and manual outcome reviews, and
 * the trace from each accepted requirement through its implementation evidence to its outcome. No analytics, no experiment service, no model: the trace and the milestone
 * summaries are derived on read by the domain code from records this server already holds.
 *
 * Locking: an owner write takes the project's `product_heads` row first, with no other lock held; a worker's proposal takes its lease's attempt row first (the lease is checked
 * again under that lock, so a revoke or expiry that committed first wins), then `product_heads`. Then the revision or proposal, and last the events (the event sequence comes
 * after every other lock, as everywhere). Everything else consulted (plans, candidates, verification records, pull requests, Brain revisions) is read without a lock. No path
 * here takes the scheduler lock, a run row, a status row or the brain lock, and no other path takes `product_heads`. A Brain compile follows an owner write after its
 * transaction committed, through the Brain's `onSend` hook. See the lock order in services/workflow/src/verification.ts.
 *
 * Events: every write is recorded with who made it. An event needs a run, so a record written while the project has none (a brief confirmed during setup) is stored with its
 * event detail and the event is appended, in log order and marked `deferred`, by the next product write once a run exists or right after the project is activated.
 *
 * Authority: only an owner session writes or confirms. A worker can only propose a brief, kept apart from the brief's revision line, for the attempt it holds and only when that
 * attempt's data may leave the device. Events carry ids, kinds and revisions, never record text. Text is redacted for secrets before it is stored. A review never touches a
 * task: its follow-up is a proposal that enters a plan only through a plan revision.
 */

/** Pending worker proposals kept per project. A newer one past this drops the oldest, and the drop is counted. */
export const BRIEF_PROPOSAL_CAP = 5;

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

interface PlanTask { readonly taskId: string; readonly runId: string; readonly title: string; readonly status: string; readonly revision: number; readonly evidenceIds: string[]; readonly criteria: { id: string; text: string }[]; readonly classification: string; readonly current: boolean }

const idsOf = (spec: unknown): { ids: string[]; criteria: { id: string; text: string }[]; parsed: z.infer<typeof TaskSpecSchema> | null } => {
  const p = TaskSpecSchema.safeParse(spec);
  if (!p.success) return { ids: [], criteria: [], parsed: null };
  const criteria = (p.data.criteria ?? []).map((c) => ({ id: c.id, text: c.text }));
  return { ids: [...new Set([...p.data.requirementIds, ...criteria.map((c) => c.id)])], criteria, parsed: p.data };
};

/**
 * The runs a trace reads, oldest first: every run with a plan, a pull request or a release note. Each run's tasks at their current revision. A task of the latest planned run is
 * in the current plan.
 */
async function tracedRuns(db: Executor, tenantId: string, projectId: string, records: readonly ProductRecord[]) {
  const runs = await db.select().from(schema.runs).where(where(schema.runs, tenantId, projectId)).orderBy(asc(schema.runs.createdAt), asc(schema.runs.runId));
  const prs = await db.select().from(schema.changeRequests).where(where(schema.changeRequests, tenantId, projectId));
  const released = new Set(latestProductRecords(records).flatMap((r) => (r.kind === 'release_note' ? [r.content.runId] : [])));
  const traced = runs.filter((r) => r.planRevision !== null || prs.some((p) => p.runId === r.runId) || released.has(r.runId));
  const currentRunId = runs.filter((r) => r.planRevision !== null).at(-1)?.runId ?? null;
  const ids = traced.map((r) => r.runId);
  const rows = ids.length === 0 ? [] : await db.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId, status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision }).from(schema.taskStatus).innerJoin(schema.taskRevisions, and(
    eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
    eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
  )).where(and(where(schema.taskStatus, tenantId, projectId), inArray(schema.taskRevisions.runId, ids))).orderBy(asc(schema.taskStatus.taskId));
  const tasks: PlanTask[] = rows.flatMap((r) => {
    const { ids: evidenceIds, criteria, parsed } = idsOf(r.spec);
    return parsed ? [{ taskId: parsed.taskId, runId: r.runId, title: parsed.title, status: r.status, revision: r.revision, evidenceIds, criteria, classification: parsed.classification, current: r.runId === currentRunId }] : [];
  });
  return { traced, tasks, prs, currentRunId };
}

async function acceptedBlueprint(db: Executor, tenantId: string, projectId: string) {
  const [o] = await db.select().from(schema.projectOnboardings).where(and(where(schema.projectOnboardings, tenantId, projectId), isNotNull(schema.projectOnboardings.acceptedBlueprintVersion)));
  if (!o) return null;
  const [bp] = await db.select().from(schema.projectBlueprints).where(and(where(schema.projectBlueprints, tenantId, projectId), eq(schema.projectBlueprints.version, o.acceptedBlueprintVersion!)));
  const p = BlueprintContentSchema.safeParse(bp?.content);
  return p.success ? p.data : null;
}

/** Every requirement this project ever accepted: the accepted blueprint's criteria and those of any task revision. */
async function everAccepted(db: Executor, tenantId: string, projectId: string): Promise<Set<string>> {
  const out = new Set((await acceptedBlueprint(db, tenantId, projectId))?.acceptanceCriteria.map((c) => c.id) ?? []);
  for (const r of await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(where(schema.taskRevisions, tenantId, projectId))) for (const id of idsOf(r.spec).ids) out.add(id);
  return out;
}

interface Inputs { readonly trace: TraceInput; readonly tasks: PlanTask[]; readonly blueprint: Awaited<ReturnType<typeof acceptedBlueprint>>; readonly prs: (typeof schema.changeRequests.$inferSelect)[] }

async function loadInputs(db: Executor, ctx: AppContext, tenantId: string, projectId: string, records: readonly ProductRecord[], briefProposals: number): Promise<Inputs> {
  const { traced, tasks, prs } = await tracedRuns(db, tenantId, projectId, records);
  const blueprint = await acceptedBlueprint(db, tenantId, projectId);
  const requirements = new Map<string, string | null>();
  for (const c of blueprint?.acceptanceCriteria ?? []) requirements.set(c.id, c.text);
  for (const t of tasks) for (const c of t.criteria) if (!requirements.get(c.id)) requirements.set(c.id, c.text);
  for (const t of tasks) for (const id of t.evidenceIds) if (!requirements.has(id)) requirements.set(id, null);
  const bar = ctx.evidence ? { trusted: ctx.evidence.trusted(), artifacts: ctx.evidence.artifacts } : null;
  const runs: TraceRun[] = [];
  for (const { runId } of traced) {
    // Read with the bar the pull-request route uses. A store that cannot be read counts no pass, as on the snapshot.
    const mine = tasks.filter((t) => t.runId === runId);
    const ev = mine.length === 0 ? null : await loadRunEvidence(db, { tenantId, projectId, runId }, mine.map((t) => ({ taskId: t.taskId, revision: t.revision, status: t.status, requirementIds: t.evidenceIds })), bar).catch(() => null);
    const pr = prs.find((p) => p.runId === runId);
    runs.push({
      runId,
      candidate: ev?.evidence.candidate ? { sha: ev.evidence.candidate.sha, live: ev.evidence.candidate.live, recordId: ev.evidence.candidate.recordId, recordValid: ev.evidence.candidate.recordValid } : null,
      criteria: (ev?.evidence.criteria ?? []).map((c) => ({ criterionId: c.criterionId, state: c.state, verified: c.verified, candidateSha: c.candidateSha, recordId: c.check?.recordId ?? null })),
      pullRequest: pr ? { prNumber: pr.prNumber, url: pr.url, status: pr.status, mergeCommitSha: pr.mergeCommitSha } : null,
    });
  }
  return {
    trace: {
      requirements: [...requirements.entries()].map(([id, text]) => ({ id, text })),
      tasks: tasks.map((t) => ({ taskId: t.taskId, runId: t.runId, title: t.title, status: t.status, requirementIds: t.evidenceIds, current: t.current })), runs, records, briefProposals,
    },
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

const CITABLE_MAX = 60;

/** Evidence a review or brief can cite: the latest revision of each live Brain source and its anchors, labelled. Bounded. */
async function citable(db: Executor, tenantId: string, projectId: string) {
  const rows = await db.select({ sourceId: schema.brainSources.sourceId, revision: schema.brainSources.revision, title: schema.brainSources.title, sections: schema.brainSources.sections, classification: schema.brainSources.classification })
    .from(schema.brainSources).where(where(schema.brainSources, tenantId, projectId)).orderBy(asc(schema.brainSources.sourceId), desc(schema.brainSources.revision));
  const revoked = new Set((await db.select({ s: schema.brainRevocations.sourceId }).from(schema.brainRevocations).where(where(schema.brainRevocations, tenantId, projectId))).map((r) => r.s));
  const out: { sourceId: string; revision: number; anchor: string; label: string; classification: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sourceId) || revoked.has(r.sourceId)) continue;
    seen.add(r.sourceId);
    for (const s of r.sections) {
      const p = BrainSectionSchema.safeParse(s);
      if (p.success && out.length < CITABLE_MAX) out.push({ sourceId: r.sourceId, revision: r.revision, anchor: p.data.anchor, label: `${r.title}: ${p.data.heading}`.slice(0, 200), classification: r.classification });
    }
  }
  return out;
}

const toProposal = (r: typeof schema.productBriefProposals.$inferSelect) => {
  const c = ProblemBriefContentSchema.safeParse(r.content);
  return c.success ? [{ proposalId: r.proposalId, proposedBy: { kind: 'worker' as const, id: r.proposedBy }, attemptId: r.attemptId, proposedAt: r.proposedAt.toISOString(), classification: r.classification, content: c.data }] : [];
};

// ---- the view -----------------------------------------------------------------------------------------------------------------------

export async function productView(db: Executor, ctx: AppContext, tenantId: string, projectId: string, now: Date) {
  const records = await loadProductRecords(db, tenantId, projectId);
  const proposalRows = await db.select().from(schema.productBriefProposals).where(where(schema.productBriefProposals, tenantId, projectId)).orderBy(desc(schema.productBriefProposals.seq));
  const [head] = await db.select().from(schema.productHeads).where(where(schema.productHeads, tenantId, projectId));
  const inputs = await loadInputs(db, ctx, tenantId, projectId, records, proposalRows.length);
  const brief = briefState(records);
  const latest = latestProductRecords(records);
  // The form starts from the owner's own latest text, or a draft from the onboarding brief. Never from a worker's proposal: that is used only on request.
  let seed: ProblemBriefContent | null = brief.latest?.content ?? null;
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
    brief: {
      confirmed: brief.confirmed, latest: brief.latest, seed, revision: brief.latest?.revision ?? 0,
      proposals: proposalRows.flatMap(toProposal), droppedProposals: head?.droppedProposals ?? 0, proposalCap: BRIEF_PROPOSAL_CAP,
    },
    plans: latest.filter((r) => r.kind === 'outcome_plan'),
    releases,
    reviews: latest.filter((r) => r.kind === 'outcome_review'),
    followUps: latest.flatMap((r) => (r.kind === 'outcome_review' && r.content.followUp
      ? [{ reviewRecordId: r.recordId, title: r.content.followUp.title, requirementIds: r.content.followUp.requirementIds, reason: r.content.followUp.reason, decision: r.content.decision, state: 'proposed' as const }] : [])),
    requirements: inputs.trace.requirements,
    mergedRuns: inputs.prs.filter((p) => p.status === 'merged' && p.mergeCommitSha !== null).sort((a, b) => (a.runId < b.runId ? -1 : 1))
      .map((p) => ({ runId: p.runId, prNumber: p.prNumber, mergeCommitSha: p.mergeCommitSha!, released: releases.some((r) => r.kind === 'release_note' && r.content.runId === p.runId) })),
    citable: await citable(db, tenantId, projectId),
    trace: buildProductTrace(inputs.trace),
    milestones: milestoneSummaries(inputs.trace),
  };
}

// ---- writing ------------------------------------------------------------------------------------------------------------------------

/** Takes the product lock. Always the first lock of an owner write, and the second (after the lease's attempt row) of a worker's. */
async function lockHead(tx: Tx, tenantId: string, projectId: string) {
  await tx.insert(schema.productHeads).values({ tenantId, projectId }).onConflictDoNothing();
  const [head] = await tx.select().from(schema.productHeads).where(where(schema.productHeads, tenantId, projectId)).for('update');
  return head!;
}

/**
 * Appends the events of every record past the head's evented position, up to `upTo`, in log order, when the project has a run; otherwise leaves them waiting. Held under the
 * product lock, and the event sequence is the last thing it takes.
 */
async function flushEvents(tx: Tx, tenantId: string, projectId: string, head: { eventedSeq: number }, upTo: number, at: Date, runHint: string | null = null): Promise<void> {
  if (head.eventedSeq >= upTo) return;
  const runId = await eventRunFor(tx, tenantId, projectId, runHint);
  if (runId === null) return;
  const rows = await tx.select().from(schema.productRecords).where(and(where(schema.productRecords, tenantId, projectId), gt(schema.productRecords.seq, head.eventedSeq), lte(schema.productRecords.seq, upTo))).orderBy(asc(schema.productRecords.seq));
  for (const r of rows) {
    await writeEvent(tx, at, {
      projectId, runId, taskId: runId, aggregateRevision: r.seq, type: 'product.recorded', actor: { kind: 'human', id: r.confirmedBy ?? r.proposedBy },
      payload: { recordId: r.recordId, kind: r.kind, revision: r.revision, status: r.status, classification: r.classification, ...r.eventDetail, ...(r.seq !== upTo || r.recordedAt.getTime() !== at.getTime() ? { deferred: true, recordedAt: r.recordedAt.toISOString() } : {}) },
    });
  }
  await tx.update(schema.productHeads).set({ eventedSeq: upTo }).where(where(schema.productHeads, tenantId, projectId));
}

/** Appends any events still waiting for a run. For the activation hook and a write that has nothing else to record. */
export async function flushProductEvents(db: Db, tenantId: string, projectId: string, at: Date): Promise<void> {
  await withTx(db, async (tx) => {
    const head = await lockHead(tx, tenantId, projectId);
    await flushEvents(tx, tenantId, projectId, head, head.lastSeq, at);
  });
}

interface WriteSpec {
  readonly tenantId: string;
  readonly projectId: string;
  readonly recordId: string;
  readonly kind: ProductRecordKind;
  readonly status: ProductRecord['status'];
  readonly classification: BrainClassification;
  readonly content: unknown;
  readonly by: string;
  readonly confirmedBy: string | null;
  /** The revision last read. */
  readonly expectedRevision: number;
  readonly detail: Record<string, unknown>;
  /** A worker proposal the owner explicitly started from: removed from the pending list in this write. */
  readonly fromProposalId?: string | undefined;
  readonly at: Date;
}

/** The product lock, the revision, then the events. See the note at the top of this file. */
async function writeRecord(db: Db, w: WriteSpec): Promise<ProductRecord> {
  return withTx(db, async (tx) => {
    const head = await lockHead(tx, w.tenantId, w.projectId);
    const [prev] = await tx.select({ revision: schema.productRecords.revision }).from(schema.productRecords)
      .where(and(where(schema.productRecords, w.tenantId, w.projectId), eq(schema.productRecords.recordId, w.recordId))).orderBy(desc(schema.productRecords.revision)).limit(1);
    const current = prev?.revision ?? 0;
    if (w.expectedRevision !== current) throw staleRevision(current, 'this record');
    if (w.fromProposalId !== undefined) {
      const gone = await tx.delete(schema.productBriefProposals).where(and(where(schema.productBriefProposals, w.tenantId, w.projectId), eq(schema.productBriefProposals.proposalId, w.fromProposalId))).returning({ id: schema.productBriefProposals.proposalId });
      if (gone.length === 0) throw new AppError(404, 'product_proposal_not_found', 'that proposal is no longer pending; nothing was saved');
    }
    const seq = head.lastSeq + 1;
    const [row] = await tx.insert(schema.productRecords).values({
      tenantId: w.tenantId, projectId: w.projectId, recordId: w.recordId, revision: current + 1, kind: w.kind, status: w.status, classification: w.classification, content: w.content as Record<string, unknown>,
      proposedByKind: 'human', proposedBy: w.by, confirmedBy: w.confirmedBy, eventDetail: w.detail, seq, recordedAt: w.at,
    }).returning();
    await tx.update(schema.productHeads).set({ lastSeq: seq }).where(where(schema.productHeads, w.tenantId, w.projectId));
    await flushEvents(tx, w.tenantId, w.projectId, head, seq, w.at);
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
    return { projectId, uid: req.principal.uid, project, actor: { kind: 'human' as const, id: req.principal.uid } satisfies Actor };
  };
  const view = (projectId: string) => productView(db, ctx, tenantId, projectId, now());
  const raise = (l: string | undefined) => l ?? 'public';

  // Product events written while the project had no run are appended once activation has made its first run, after that request committed. A failure is logged; the next
  // product write appends them.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'POST' || reply.statusCode >= 300 || req.principal?.kind !== 'owner' || req.routeOptions.url !== '/v1/onboarding/:id/activate') return payload;
    const projectId = (req.params as { id?: string }).id ?? '';
    try {
      if ((await db.select({ p: schema.projects.projectId }).from(schema.projects).where(and(eq(schema.projects.tenantId, tenantId), eq(schema.projects.projectId, projectId)))).length > 0) await flushProductEvents(db, tenantId, projectId, now());
    } catch (err) {
      app.log.warn({ error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown } | null)?.code ?? null }, 'appending deferred product events failed; the next product write retries');
    }
    return payload;
  });

  app.get('/v1/projects/:id/product', auth, async (req) => {
    const { projectId } = await ownerOf(req);
    // The seed cites the accepted brief's revision in the Project Brain. The Brain is compiled first only when its records moved since the last sync.
    if (!(await brainCurrent(db, tenantId, projectId))) {
      await syncBrain(db, tenantId, projectId, now()).catch((err: unknown) => app.log.warn({ error: err instanceof Error ? err.name : 'unknown' }, 'the Project Brain could not be compiled before the product view'));
    }
    return view(projectId);
  });

  app.post('/v1/projects/:id/product/brief', auth, async (req, reply) => {
    const { projectId, uid, project, actor } = await ownerOf(req);
    const body = parseBody(ProductBriefRequestSchema, req.body);
    if (body.confirm && !canConfirmBrief(actor.kind)) throw new AppError(403, 'wrong_principal_type', 'only a person can confirm a brief');
    const { content, redacted } = clean(ProblemBriefContentSchema, body.content);
    const classification = productLabel(project.classification, raise(body.classification), ...(await citedLabels(db, tenantId, projectId, content.evidence)));
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: 'brief', kind: 'problem_brief', status: body.confirm ? 'confirmed' : 'proposed', classification, content, by: uid, confirmedBy: body.confirm ? uid : null,
      expectedRevision: body.expectedRevision, fromProposalId: body.fromProposalId, at: now(),
      detail: { action: body.confirm ? 'brief_confirmed' : 'brief_saved', ...(body.fromProposalId !== undefined ? { fromProposalId: body.fromProposalId } : {}) },
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  /** The labels of the traced tasks that carry these requirements. A plan about restricted work is restricted. */
  const taskLabels = async (projectId: string, requirementIds: readonly string[]) =>
    (await tracedRuns(db, tenantId, projectId, await loadProductRecords(db, tenantId, projectId))).tasks.filter((t) => t.evidenceIds.some((id) => requirementIds.includes(id))).map((t) => t.classification);
  const requireAccepted = async (projectId: string, ids: readonly string[]) => {
    const known = await everAccepted(db, tenantId, projectId);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new AppError(422, 'product_requirement_unknown', `this project never accepted the requirement ${unknown.join(', ')}`);
  };

  app.post('/v1/projects/:id/product/outcome-plans', auth, async (req, reply) => {
    const { projectId, uid, project } = await ownerOf(req);
    const body = parseBody(OutcomePlanRequestSchema, req.body);
    const { content, redacted } = clean(OutcomePlanContentSchema, body.content);
    await requireAccepted(projectId, content.requirementIds);
    const records = await loadProductRecords(db, tenantId, projectId);
    if (body.recordId !== null && !records.some((r) => r.recordId === body.recordId && r.kind === 'outcome_plan')) throw new AppError(404, 'product_record_not_found', 'no such outcome plan');
    const classification = productLabel(project.classification, raise(body.classification), ...(await taskLabels(projectId, content.requirementIds)));
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: body.recordId ?? `plan:${randomUUID()}`, kind: 'outcome_plan', status: 'recorded', classification, content, by: uid, confirmedBy: null,
      expectedRevision: body.recordId === null ? 0 : body.expectedRevision, at: now(), detail: { action: body.recordId === null ? 'outcome_plan_added' : 'outcome_plan_revised' },
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  /** The requirements the run's tasks carry, and their labels. */
  const runTasks = async (projectId: string, runId: string) => {
    const specs = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(where(schema.taskRevisions, tenantId, projectId), eq(schema.taskRevisions.runId, runId)));
    const parsed = specs.map((s) => idsOf(s.spec));
    return { ids: new Set(parsed.flatMap((p) => p.ids)), labels: parsed.map((p) => p.parsed?.classification ?? 'secret') };
  };

  app.post('/v1/projects/:id/product/releases', auth, async (req, reply) => {
    const { projectId, uid, project } = await ownerOf(req);
    const body = parseBody(ReleaseNoteRequestSchema, req.body);
    const { content, redacted } = clean(ReleaseNoteContentSchema, body.content);
    const [run] = await db.select().from(schema.runs).where(and(where(schema.runs, tenantId, projectId), eq(schema.runs.runId, content.runId)));
    if (!run) throw new AppError(404, 'run_not_found', 'no such run in this project');
    const [pr] = await db.select().from(schema.changeRequests).where(and(where(schema.changeRequests, tenantId, projectId), eq(schema.changeRequests.runId, content.runId)));
    // A release follows a merge a person made on GitHub. Nothing here deploys, and a merge alone is not a release.
    if (pr?.status !== 'merged' || pr.mergeCommitSha === null) throw new AppError(409, 'product_not_merged', 'a release note needs a merged run, and a person merges on GitHub; nothing was stored');
    const classification = productLabel(project.classification, raise(body.classification), ...(await runTasks(projectId, content.runId)).labels);
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: `release:${randomUUID()}`, kind: 'release_note', status: 'recorded', classification, content, by: uid, confirmedBy: null,
      expectedRevision: 0, at: now(), detail: { action: 'release_note_recorded', runId: content.runId },
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  app.post('/v1/projects/:id/product/outcome-reviews', auth, async (req, reply) => {
    const { projectId, uid, project } = await ownerOf(req);
    const body = parseBody(OutcomeReviewRequestSchema, req.body);
    const { content, redacted } = clean(OutcomeReviewContentSchema, body.content);
    const plan = await latestOf(db, tenantId, projectId, content.planRecordId);
    const release = await latestOf(db, tenantId, projectId, content.releaseRecordId);
    if (plan?.kind !== 'outcome_plan') throw new AppError(404, 'product_record_not_found', 'no such outcome plan');
    if (release?.kind !== 'release_note') throw new AppError(404, 'product_record_not_found', 'no such release note');
    // The release must be of a run that carried what the plan is about, or the review would judge one change by another's release.
    const carried = (await runTasks(projectId, release.content.runId)).ids;
    const outside = plan.content.requirementIds.filter((id) => !carried.has(id));
    if (outside.length > 0) throw new AppError(422, 'product_requirement_mismatch', `the released run ${release.content.runId} does not carry ${outside.join(', ')}, which this outcome plan is about`);
    if (content.followUp) await requireAccepted(projectId, content.followUp.requirementIds);
    const classification = productLabel(project.classification, raise(body.classification), plan.classification, release.classification, ...(await citedLabels(db, tenantId, projectId, content.evidence)));
    // A review records a decision. It touches no task: a follow-up stays a proposal until a person puts it in a plan revision.
    const record = await writeRecord(db, {
      tenantId, projectId, recordId: `review:${randomUUID()}`, kind: 'outcome_review', status: 'recorded', classification, content, by: uid, confirmedBy: null, expectedRevision: 0, at: now(),
      detail: { action: 'outcome_review_recorded', decision: content.decision, followUpProposed: content.followUp !== null, planRecordId: plan.recordId, releaseRecordId: release.recordId },
    });
    return reply.code(201).send({ record, redacted, product: await view(projectId) });
  });

  // A worker's proposed brief, for the attempt it holds. Only ever a proposal, kept beside the brief, and never from work whose data stays on the device.
  app.post('/v1/runners/product/brief-proposal', { onRequest: [ctx.runner] }, async (req, reply) => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    // The attempt is checked before the body is read: restricted work is refused whatever it sent.
    const leaseOnly = z.object({ lease: LeaseRefSchema }).safeParse(req.body ?? {});
    if (!leaseOnly.success) throw invalidRequest('request body failed validation', [{ path: 'lease', message: 'a lease is required' }]);
    const lease = leaseOnly.data.lease;
    const [pre] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, p.tenantId), eq(schema.attempts.attemptId, lease.attemptId)));
    if (!leaseHolds(pre, p.runnerId, lease, now())) throw staleLease(lease);
    if (pre.detail['terminalStreamable'] !== true) throw new AppError(403, 'product_proposal_restricted', 'a proposal is not accepted from work whose data stays on the device');
    const body = parseBody(ProductBriefProposalRequestSchema, req.body);
    const project = await requireProject(db, p.tenantId, pre.projectId);
    const { content } = clean(ProblemBriefContentSchema, body.content);
    const classification = productLabel(project.classification, ...(await citedLabels(db, p.tenantId, pre.projectId, content.evidence)));
    const proposalId = `proposal_${randomUUID()}`;
    await withTx(db, async (tx) => {
      const at = now();
      // The lease again, under the attempt row's lock: a revoke or expiry that committed first wins.
      const a = await lockLease(tx, p.tenantId, p.runnerId, lease, at);
      if (a.detail['terminalStreamable'] !== true) throw new AppError(403, 'product_proposal_restricted', 'a proposal is not accepted from work whose data stays on the device');
      const head = await lockHead(tx, p.tenantId, a.projectId);
      const pseq = head.proposalSeq + 1;
      await tx.insert(schema.productBriefProposals).values({ tenantId: p.tenantId, projectId: a.projectId, proposalId, content: content as unknown as Record<string, unknown>, classification, proposedBy: p.runnerId, attemptId: a.attemptId, seq: pseq, proposedAt: at });
      const all = await tx.select({ id: schema.productBriefProposals.proposalId }).from(schema.productBriefProposals).where(where(schema.productBriefProposals, p.tenantId, a.projectId))
        .orderBy(desc(schema.productBriefProposals.seq));
      const drop = all.slice(BRIEF_PROPOSAL_CAP).map((x) => x.id).filter((id) => id !== proposalId);
      if (drop.length > 0) await tx.delete(schema.productBriefProposals).where(and(where(schema.productBriefProposals, p.tenantId, a.projectId), inArray(schema.productBriefProposals.proposalId, drop)));
      await tx.update(schema.productHeads).set({ proposalSeq: pseq, droppedProposals: head.droppedProposals + drop.length }).where(where(schema.productHeads, p.tenantId, a.projectId));
      await flushEvents(tx, p.tenantId, a.projectId, head, head.lastSeq, at, a.taskId);
      const runId = await eventRunFor(tx, p.tenantId, a.projectId, a.taskId);
      if (runId === null) throw new AppError(409, 'product_needs_run', 'this attempt has no run to record the proposal against');
      await writeEvent(tx, at, {
        projectId: a.projectId, runId, taskId: runId, attemptId: a.attemptId, aggregateRevision: head.lastSeq, type: 'product.proposed', actor: { kind: 'worker', id: p.runnerId },
        payload: { proposalId, kind: 'problem_brief', classification, action: 'brief_proposed', dropped: drop.length },
      });
    });
    return reply.code(201).send({ proposalId, status: 'proposed' });
  });
}
