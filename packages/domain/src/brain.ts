import { z } from 'zod';
import { stackInScope, stackKeyPath } from './stack.ts';
import { sanitizeTerminalText } from './terminal.ts';

/**
 * The minimal Project Brain (docs/second-brain.md §3, §4, §7). Four ideas, all deterministic:
 *
 * - A source revision is immutable evidence: structured sections, each with an anchor (a heading path), recorded with its provenance, classification and allowed use.
 *   Revoking a source is a recorded state, never a deletion.
 * - A compilation derives pages of claims from the latest revision of every source. Each claim cites the source revisions and anchors that support it, carries the
 *   generator id and version, the time and the source watermark, and a status. No model is involved: the same inputs always give the same pages.
 * - Support is transitive. A source derived from another adds no independent support, so a repeated claim is never corroboration, and revoking a root takes its
 *   copies with it. Independent evidence keeps a claim current.
 * - The context bundle a worker gets is filtered for its destination and its task, and names everything it left out and why.
 *
 * Source text is data. Nothing here reads a source as an instruction, and nothing a source says can change a grant, a path, policy, scope or an approval.
 */

export const BRAIN_GENERATOR = { id: 'selarikru.brain.structured', version: '1' } as const;

/** `product`: an owner's product-learning record (a confirmed problem brief, an outcome plan, a release note, an outcome review). */
export const BRAIN_SOURCE_KINDS = ['brief', 'criteria', 'plan', 'decision', 'verification', 'repo_manifest', 'note', 'stack', 'product'] as const;
export const BrainSourceKindSchema = z.enum(BRAIN_SOURCE_KINDS);
export type BrainSourceKind = z.infer<typeof BrainSourceKindSchema>;

/** `accepted`: approved through its own workflow (an accepted blueprint or plan, a recorded decision, a verifier's verdict, a runner's manifest). `proposed`: anything else, such as an owner's note. */
export const BRAIN_STANDINGS = ['accepted', 'proposed'] as const;
export type BrainStanding = (typeof BRAIN_STANDINGS)[number];

export const BRAIN_CLAIM_STATUSES = ['current', 'stale', 'disputed', 'unsupported'] as const;
export type BrainClaimStatus = (typeof BRAIN_CLAIM_STATUSES)[number];

export const BRAIN_PAGES = ['overview', 'architecture', 'decisions'] as const;
export type BrainPageId = (typeof BRAIN_PAGES)[number];
export const BRAIN_PAGE_TITLES: Readonly<Record<BrainPageId, string>> = { overview: 'Project overview', architecture: 'Architecture and constraints', decisions: 'Decision log' };

/** `accepted_source_revoked`: the key's accepted value was revoked and only a different proposal remains, which is never served as accepted. `not_a_claim`: a section that states no claim. */
export const BRAIN_OMISSION_REASONS = ['revoked', 'stale', 'restricted_for_destination', 'too_large', 'out_of_scope', 'accepted_source_revoked', 'not_a_claim'] as const;
export type BrainOmissionReason = (typeof BRAIN_OMISSION_REASONS)[number];

export const BRAIN_DESTINATIONS = ['local', 'cloud'] as const;
export type BrainDestination = (typeof BRAIN_DESTINATIONS)[number];

const BRAIN_CLASSIFICATIONS = ['public', 'internal', 'restricted', 'secret'] as const;
export const BrainClassificationSchema = z.enum(BRAIN_CLASSIFICATIONS);
export type BrainClassification = z.infer<typeof BrainClassificationSchema>;
const RANK: Readonly<Record<BrainClassification, number>> = { public: 0, internal: 1, restricted: 2, secret: 3 };

/** The stronger label. Anything that is not a label is `secret`: fails closed. */
export function strongerLabel(a: unknown, b: unknown): BrainClassification {
  const pa = BrainClassificationSchema.safeParse(a);
  const pb = BrainClassificationSchema.safeParse(b);
  if (!pa.success || !pb.success) return 'secret';
  return RANK[pa.data] >= RANK[pb.data] ? pa.data : pb.data;
}

/** Where content of this label may be used. Restricted and secret stay on the device: a cloud destination never gets them. Same rule as live output (`isTerminalStreamable`). */
export const allowedUseFor = (classification: unknown): BrainDestination[] => (classification === 'public' || classification === 'internal' ? ['local', 'cloud'] : ['local']);

/** A claim key: a stable, structured name such as `criterion:FB-03` or `task:T1`. No spaces, so it cannot carry a sentence. */
export const BrainKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,159}$/, 'expected a structured key');
/** A heading path inside one source, such as `criteria/FB-03`. */
export const BrainAnchorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/, 'expected an anchor');
/** `kind:name`. A stack source is named by its component's path, so `/` is allowed, and `stack:.` names the repository root. */
export const BrainSourceIdSchema = z.string().regex(/^[a-z_]+:[A-Za-z0-9.][A-Za-z0-9_.:/@-]{0,159}$/, 'expected a source id');

export const BRAIN_SECTION_TEXT_MAX = 2000;
export const BrainSectionSchema = z.strictObject({
  anchor: BrainAnchorSchema,
  heading: z.string().min(1).max(200),
  text: z.string().max(BRAIN_SECTION_TEXT_MAX),
  /** Present when this section states a claim. A section without one is kept as evidence but states nothing on a page. */
  key: BrainKeySchema.optional(),
});
export type BrainSection = z.infer<typeof BrainSectionSchema>;

export const BrainRevisionRefSchema = z.strictObject({ sourceId: BrainSourceIdSchema, revision: z.number().int().min(1) });
export type BrainRevisionRef = z.infer<typeof BrainRevisionRefSchema>;
export const BrainCitationSchema = z.strictObject({ sourceId: BrainSourceIdSchema, revision: z.number().int().min(1), anchor: BrainAnchorSchema });
export type BrainCitation = z.infer<typeof BrainCitationSchema>;

export const BrainProvenanceSchema = z.strictObject({
  /** What produced it: `onboarding`, `plan`, `decisions`, `approvals`, `events`, `runner`, `owner`. */
  origin: z.string().regex(/^[a-z_]{1,40}$/),
  /** The record it was read from, by id. */
  ref: z.string().min(1).max(200),
  /** Who recorded it: an owner uid, a runner id, or `control-api`. */
  recordedBy: z.string().min(1).max(200),
});
export type BrainProvenance = z.infer<typeof BrainProvenanceSchema>;

export const BrainSourceRevisionSchema = z.strictObject({
  sourceId: BrainSourceIdSchema,
  revision: z.number().int().min(1),
  kind: BrainSourceKindSchema,
  title: z.string().min(1).max(200),
  standing: z.enum(BRAIN_STANDINGS),
  classification: BrainClassificationSchema,
  allowedUse: z.array(z.enum(BRAIN_DESTINATIONS)),
  provenance: BrainProvenanceSchema,
  /** Sources this one was made from. A derived source adds no independent support. */
  derivedFrom: z.array(BrainRevisionRefSchema).max(20),
  /** Present when the source is about one task: its claims are in scope only for that task and the tasks that depend on it. */
  taskId: z.string().min(1).nullable(),
  sections: z.array(BrainSectionSchema).max(200),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Position in the project's source log. The watermark of a compilation is the last position it read. */
  seq: z.number().int().min(1),
  recordedAt: z.iso.datetime(),
});
export type BrainSourceRevision = z.infer<typeof BrainSourceRevisionSchema>;

export const BrainRevocationSchema = z.strictObject({
  sourceId: BrainSourceIdSchema,
  /** A code or a short owner sentence. Never shown to a worker. */
  reason: z.string().min(1).max(200),
  revokedBy: z.string().min(1).max(200),
  revokedAt: z.iso.datetime(),
  seq: z.number().int().min(1),
});
export type BrainRevocation = z.infer<typeof BrainRevocationSchema>;

export const BrainClaimSchema = z.strictObject({
  claimId: z.string().min(1),
  page: z.enum(BRAIN_PAGES),
  key: BrainKeySchema,
  heading: z.string().min(1).max(200),
  text: z.string().max(BRAIN_SECTION_TEXT_MAX),
  status: z.enum(BRAIN_CLAIM_STATUSES),
  /** `accepted` when a live accepted source states it (or, unsupported, when its accepted source was revoked). `proposed`: only proposals state it. Never served as accepted. */
  standing: z.enum(BRAIN_STANDINGS).default('accepted'),
  /** Every source revision and anchor stating exactly this text. */
  citations: z.array(BrainCitationSchema).min(1),
  /** The independent roots behind the citations, transitively. Two citations with one root are one piece of evidence. */
  roots: z.array(BrainSourceIdSchema),
  /** Roots that are still live: not revoked, at a current revision. Zero means nothing supports the claim now. */
  liveSupport: z.number().int().min(0),
  /** Live sources stating a different value for the same key against an accepted value: they dispute it, or, when the accepted source was revoked, wait without an accepted value. */
  disputedBy: z.array(BrainCitationSchema),
  conflictId: z.string().nullable(),
  classification: BrainClassificationSchema,
  allowedUse: z.array(z.enum(BRAIN_DESTINATIONS)),
  /** Scope: a claim about one task. Null for project-wide claims. */
  taskId: z.string().nullable(),
  /** The commit a repository claim describes, so a bundle for another base can say it is stale. */
  commit: z.string().nullable(),
  generator: z.strictObject({ id: z.string(), version: z.string() }),
  generatedAt: z.iso.datetime(),
  watermark: z.number().int().min(0),
});
export type BrainClaim = z.infer<typeof BrainClaimSchema>;

export const BrainConflictSchema = z.strictObject({
  conflictId: z.string().min(1),
  key: BrainKeySchema,
  accepted: BrainCitationSchema.extend({ text: z.string() }),
  proposed: BrainCitationSchema.extend({ text: z.string() }),
  classification: BrainClassificationSchema,
});
export type BrainConflict = z.infer<typeof BrainConflictSchema>;

export const BrainPageSchema = z.strictObject({ page: z.enum(BRAIN_PAGES), title: z.string(), classification: BrainClassificationSchema, claims: z.array(BrainClaimSchema) });
export type BrainPage = z.infer<typeof BrainPageSchema>;

export const BrainCompilationSchema = z.strictObject({
  version: z.number().int().min(1),
  generator: z.strictObject({ id: z.string(), version: z.string() }),
  generatedAt: z.iso.datetime(),
  watermark: z.number().int().min(0),
  pages: z.array(BrainPageSchema),
  conflicts: z.array(BrainConflictSchema),
});
export type BrainCompilation = z.infer<typeof BrainCompilationSchema>;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** A conflict's id: the key and the exact source revision that disputes it. */
export const brainConflictId = (key: string, ref: BrainRevisionRef): string => `conflict:${key}:${ref.sourceId}@${ref.revision}`;
const conflictIdOf = (key: string, c: { rev: BrainSourceRevision }): string => brainConflictId(key, c.rev);

/** Source text as it is stored: control, bidi and zero-width characters removed, so nothing hidden can ride along, and bounded. */
export const cleanSourceText = (s: string, max = BRAIN_SECTION_TEXT_MAX): string => sanitizeTerminalText(s).slice(0, max);

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const refKey = (r: { sourceId: string; revision: number }): string => `${r.sourceId}@${r.revision}`;
const citationOrder = (a: BrainCitation, b: BrainCitation): number => byString(a.sourceId, b.sourceId) || a.revision - b.revision || byString(a.anchor, b.anchor);

const PAGE_OF_KIND: Readonly<Record<BrainSourceKind, BrainPageId>> = {
  brief: 'overview', note: 'overview', product: 'overview', criteria: 'architecture', plan: 'architecture', repo_manifest: 'architecture', stack: 'architecture', decision: 'decisions', verification: 'decisions',
};

export interface CompileInput {
  /** Every stored revision of every source. Old revisions are kept for citations and for the support walk. */
  readonly revisions: readonly BrainSourceRevision[];
  readonly revocations: readonly BrainRevocation[];
  /** Conflicts the owner settled by keeping the accepted value. The proposing source then stops disputing that key. */
  readonly kept: ReadonlySet<string>;
  /** The claims of the last compilation, so a claim whose source changed underneath it is shown as stale once rather than vanishing. */
  readonly previous: readonly BrainClaim[];
  readonly version: number;
  readonly generatedAt: string;
}

interface Candidate {
  readonly rev: BrainSourceRevision;
  readonly section: BrainSection;
  readonly key: string;
  readonly text: string;
}

/** The latest revision of every source. */
export function latestRevisions(revisions: readonly BrainSourceRevision[]): Map<string, BrainSourceRevision> {
  const out = new Map<string, BrainSourceRevision>();
  for (const r of revisions) {
    const have = out.get(r.sourceId);
    if (!have || r.revision > have.revision) out.set(r.sourceId, r);
  }
  return out;
}

/**
 * The independent roots of a revision, transitively: itself when it was made from nothing, otherwise the roots of what it was made from. A cycle or a missing parent
 * ends the walk at that revision, which then counts as its own root (fails toward less support, never more).
 */
export function rootsOf(ref: BrainRevisionRef, all: ReadonlyMap<string, BrainSourceRevision>, seen: ReadonlySet<string> = new Set()): string[] {
  const rev = all.get(refKey(ref));
  if (!rev || rev.derivedFrom.length === 0 || seen.has(refKey(ref))) return [ref.sourceId];
  const next = new Set(seen).add(refKey(ref));
  const roots = new Set<string>();
  for (const p of rev.derivedFrom) {
    if (!all.has(refKey(p))) {
      roots.add(ref.sourceId);
      continue;
    }
    for (const r of rootsOf(p, all, next)) roots.add(r);
  }
  return [...roots].sort(byString);
}

/** Every source id a revision rests on, itself included. Revoking any of them takes this revision's support away. */
function dependsOn(ref: BrainRevisionRef, all: ReadonlyMap<string, BrainSourceRevision>, seen: Set<string> = new Set()): Set<string> {
  const out = new Set<string>([ref.sourceId]);
  if (seen.has(refKey(ref))) return out;
  seen.add(refKey(ref));
  for (const p of all.get(refKey(ref))?.derivedFrom ?? []) for (const s of dependsOn(p, all, seen)) out.add(s);
  return out;
}

/**
 * Derives the pages. Pure and deterministic: the same revisions, revocations, kept conflicts, previous claims, version and time give byte-identical output.
 *
 * For each key, the value is the one an accepted source states (the lowest source id wins between two accepted sources, so the choice does not depend on input order),
 * else the one a proposed source states. A live proposed source that states another value for a key an accepted source holds makes the claim `disputed` and records a
 * conflict for a person to decide; the accepted value stays the claim's text. Nothing here changes accepted scope.
 */
export function compileBrain(input: CompileInput): BrainCompilation {
  const all = new Map(input.revisions.map((r) => [refKey(r), r]));
  const latest = latestRevisions(input.revisions);
  const revoked = new Set(input.revocations.map((r) => r.sourceId));
  const watermark = Math.max(0, ...input.revisions.map((r) => r.seq), ...input.revocations.map((r) => r.seq));
  const generator = { id: BRAIN_GENERATOR.id, version: BRAIN_GENERATOR.version };
  const live = (rev: BrainSourceRevision): boolean => ![...dependsOn(rev, all)].some((s) => revoked.has(s));

  const groups = new Map<string, Candidate[]>();
  for (const rev of [...latest.values()].sort((a, b) => byString(a.sourceId, b.sourceId))) {
    for (const section of rev.sections) {
      if (section.key === undefined) continue;
      const list = groups.get(section.key) ?? [];
      list.push({ rev, section, key: section.key, text: norm(section.text) });
      groups.set(section.key, list);
    }
  }

  const claims: BrainClaim[] = [];
  const conflicts: BrainConflict[] = [];
  const cite = (c: Candidate): BrainCitation => ({ sourceId: c.rev.sourceId, revision: c.rev.revision, anchor: c.section.anchor });

  for (const key of [...groups.keys()].sort(byString)) {
    // A conflict a person settled by keeping the accepted value is bound to that exact source revision: a later revision that disputes again is shown again.
    const cands = groups.get(key)!.filter((c) => !input.kept.has(conflictIdOf(key, c)));
    if (cands.length === 0) continue;
    const accepted = cands.filter((c) => c.rev.standing === 'accepted');
    const liveFirst = (c: Candidate): boolean => live(c.rev);
    // A proposal never takes an accepted value's place: when every accepted source is revoked the key keeps its accepted head, unsupported.
    const head = accepted.length > 0 ? (accepted.find(liveFirst) ?? accepted[0]!) : (cands.find(liveFirst) ?? cands[0]!);
    const supports = cands.filter((c) => c.text === head.text);
    // Against an accepted value, any live source stating another value disputes it, accepted or proposed.
    const disputers = head.rev.standing === 'accepted' ? cands.filter((c) => c.text !== head.text && live(c.rev)) : [];
    const roots = [...new Set(supports.flatMap((c) => rootsOf(c.rev, all)))].sort(byString);
    const liveSupports = supports.filter((c) => live(c.rev));
    const liveRoots = [...new Set(liveSupports.flatMap((c) => rootsOf(c.rev, all)))];
    const headLive = live(head.rev);
    const everyone = [...supports, ...disputers];
    const classification = everyone.reduce<BrainClassification>((acc, c) => strongerLabel(acc, c.rev.classification), 'public');
    const allowedUse = BRAIN_DESTINATIONS.filter((d) => everyone.every((c) => c.rev.allowedUse.includes(d)) && allowedUseFor(classification).includes(d));
    const page = PAGE_OF_KIND[(accepted[0] ?? head).rev.kind];
    const recorded = headLive ? disputers : [];
    const conflictId = recorded[0] ? conflictIdOf(key, recorded[0]) : null;
    for (const d of recorded) {
      conflicts.push({
        conflictId: conflictIdOf(key, d), key, classification: strongerLabel(head.rev.classification, d.rev.classification),
        accepted: { ...cite(head), text: head.text }, proposed: { ...cite(d), text: d.text },
      });
    }
    const status: BrainClaimStatus = liveRoots.length === 0 ? 'unsupported' : recorded.length > 0 ? 'disputed' : 'current';
    claims.push({
      claimId: `${page}:${key}`, page, key, heading: head.section.heading, text: head.text, status,
      standing: liveSupports.some((c) => c.rev.standing === 'accepted') || (status === 'unsupported' && head.rev.standing === 'accepted') ? 'accepted' : 'proposed',
      citations: supports.map(cite).sort(citationOrder), roots, liveSupport: liveRoots.length, disputedBy: disputers.map(cite).sort(citationOrder), conflictId,
      classification, allowedUse, taskId: head.rev.taskId, commit: head.rev.kind === 'repo_manifest' ? commitOf(head.rev) : null,
      generator, generatedAt: input.generatedAt, watermark,
    });
  }

  // A claim an earlier compilation held whose source no longer states it (the anchor went away in a newer revision) stays, as stale, citing the revision that did state
  // it, until a source states the key again. A revoked source's claim is unsupported instead. Neither is served, and every bundle names it as left out.
  const present = new Set(claims.map((c) => c.key));
  for (const prev of [...input.previous].sort((a, b) => byString(a.key, b.key))) {
    if (present.has(prev.key) || prev.status === 'unsupported') continue;
    const gone = prev.citations.some((c) => revoked.has(c.sourceId));
    claims.push({ ...prev, status: gone ? 'unsupported' : 'stale', liveSupport: 0, disputedBy: [], conflictId: null, generator, generatedAt: input.generatedAt, watermark });
    present.add(prev.key);
  }

  const pages = BRAIN_PAGES.map((page) => {
    const list = claims.filter((c) => c.page === page).sort((a, b) => byString(a.key, b.key));
    return { page, title: BRAIN_PAGE_TITLES[page], classification: list.reduce<BrainClassification>((acc, c) => strongerLabel(acc, c.classification), 'public'), claims: list };
  });
  conflicts.sort((a, b) => byString(a.conflictId, b.conflictId));
  return { version: input.version, generator, generatedAt: input.generatedAt, watermark, pages, conflicts };
}

function commitOf(rev: BrainSourceRevision): string | null {
  const s = rev.sections.find((x) => x.key === 'repo:commit');
  return s && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s.text.trim()) ? s.text.trim() : null;
}

/** Whether a citation names a stored revision and an anchor that revision has. Every citation a compilation writes must pass this. */
export function citationResolves(c: BrainCitation, revisions: readonly BrainSourceRevision[]): boolean {
  const rev = revisions.find((r) => r.sourceId === c.sourceId && r.revision === c.revision);
  return rev !== undefined && rev.sections.some((s) => s.anchor === c.anchor);
}

// ---- the task context bundle ------------------------------------------------------------------------------------------

export const BRAIN_BUNDLE_MAX_TEXT_CHARS = 12_000;
export const BRAIN_BUNDLE_MAX_CLAIM_CHARS = 1_200;

export const BrainBundleClaimSchema = z.strictObject({
  claimId: z.string().min(1),
  page: z.enum(BRAIN_PAGES),
  key: BrainKeySchema,
  heading: z.string().max(200),
  text: z.string().max(BRAIN_SECTION_TEXT_MAX),
  status: z.enum(['current', 'disputed']),
  /** `accepted` only when a cited, live source is accepted. A proposal is shown to the worker as proposed, never as accepted scope. */
  standing: z.enum(BRAIN_STANDINGS),
  citations: z.array(BrainCitationSchema).min(1),
});
export type BrainBundleClaim = z.infer<typeof BrainBundleClaimSchema>;

/** What was left out. Ids and codes only: an omission never carries the text it withheld. */
export const BrainOmissionSchema = z.strictObject({
  kind: z.enum(['claim', 'source', 'section']),
  /** A claim id, or a source id. */
  id: z.string().min(1).max(420),
  reason: z.enum(BRAIN_OMISSION_REASONS),
});
export type BrainOmission = z.infer<typeof BrainOmissionSchema>;

export const BrainBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  destination: z.enum(BRAIN_DESTINATIONS),
  taskId: z.string().min(1),
  /** The compilation served. Null when none exists yet. */
  compilationVersion: z.number().int().min(1).nullable(),
  generator: z.strictObject({ id: z.string(), version: z.string() }),
  /** The source log position the compilation read, and the position the log has reached now. */
  watermark: z.number().int().min(0),
  sourceHead: z.number().int().min(0),
  /** Changes the compilation has not read yet: source-log entries past its watermark, and at least 1 when the records moved since the last sync. */
  indexLag: z.number().int().min(0),
  /** The records sources are read from (verdicts, decisions, the plan) moved since the last sync, so some claims may be out of date. */
  recordsPending: z.boolean().default(false),
  compiledAt: z.iso.datetime().nullable(),
  /** The exact accepted source revisions the served claims rest on. */
  pinned: z.array(BrainRevisionRefSchema),
  claims: z.array(BrainBundleClaimSchema),
  omissions: z.array(BrainOmissionSchema),
});
export type BrainBundle = z.infer<typeof BrainBundleSchema>;

export interface BundleTask {
  readonly taskId: string;
  readonly baseSha: string;
  /** Requirement, criterion and acceptance-check ids this task is judged on. */
  readonly criteria: readonly string[];
  /** Tasks this one depends on: their claims are in scope too. */
  readonly dependsOn: readonly string[];
  /** The paths the task may change. A component's stack claim (`component:<path>…`) is in scope only for the components these touch (the repository root's always). Absent: the root's only. */
  readonly paths?: readonly string[];
}

export interface BundleInput {
  readonly compilation: BrainCompilation | null;
  /** Every stored revision, for the serve-time checks. */
  readonly revisions: readonly BrainSourceRevision[];
  /** Revocations as they stand now, which may be newer than the compilation. */
  readonly revocations: readonly BrainRevocation[];
  /** The source log's position now. */
  readonly sourceHead: number;
  readonly destination: BrainDestination;
  /**
   * Whether the attempt's output may leave the device (the claim's `streamable`). A streamable attempt, wherever it runs, is served only what a cloud worker may see:
   * restricted and secret claims go only to a local attempt whose output stays on the device.
   */
  readonly streamable?: boolean;
  /** The records moved since the last sync (the server compares the records' fingerprint with the one the last sync stored). */
  readonly recordsPending?: boolean;
  readonly task: BundleTask;
  readonly maxTextChars?: number;
}

const CRITERION_KEY = /^criterion:(.+)$/;

/**
 * The task's context: the claims it may see, with citations, pinned to the source revisions they rest on, and every claim and source left out with its reason.
 * Pure. Revocation and the destination are checked again here, at serve time, so a compilation that lags a revocation cannot serve what it no longer supports.
 */
export function buildContextBundle(input: BundleInput): BrainBundle {
  const max = input.maxTextChars ?? BRAIN_BUNDLE_MAX_TEXT_CHARS;
  const all = new Map(input.revisions.map((r) => [refKey(r), r]));
  const latest = latestRevisions(input.revisions);
  const revoked = new Set(input.revocations.map((r) => r.sourceId));
  const inScopeTasks = new Set([input.task.taskId, ...input.task.dependsOn]);
  const criteria = new Set(input.task.criteria);
  const omissions: BrainOmission[] = [];
  const served: BrainBundleClaim[] = [];
  const pinned = new Map<string, BrainRevisionRef>();
  const c = input.compilation;
  // Output that may leave the device gets only what a cloud worker may see. Fails closed: only an explicit `false` keeps output on the device.
  const reach: BrainDestination = input.streamable === false ? input.destination : 'cloud';
  const permitted = (classification: string, allowedUse: readonly string[]): boolean => allowedUse.includes(input.destination) && allowedUse.includes(reach) && allowedUseFor(classification).includes(reach);
  const isDead = (x: BrainRevisionRef): boolean => [...dependsOn(x, all)].some((s) => revoked.has(s));
  let used = 0;

  const deadNow = (cl: BrainClaim): boolean => cl.citations.every(isDead);
  // Stale now: a citation's source has a newer revision that no longer states this text at all.
  const staleNow = (cl: BrainClaim): boolean => cl.citations.every((x) => {
    const now = latest.get(x.sourceId);
    return now !== undefined && now.revision !== x.revision && !now.sections.some((s) => s.key === cl.key && norm(s.text) === cl.text);
  });
  /** Why each source's claims were left out, for sources none of whose claims were served. */
  const dropped = new Map<string, BrainOmissionReason>();
  const servedFrom = new Set<string>();
  /** Sources that make a left-out claim restricted for this bundle. */
  const restricting = new Set<string>();

  for (const page of c?.pages ?? []) {
    for (const cl of page.claims) {
      const omit = (reason: BrainOmissionReason): void => {
        omissions.push({ kind: 'claim', id: cl.claimId, reason });
        for (const x of cl.citations) if (!dropped.has(x.sourceId)) dropped.set(x.sourceId, reason);
      };
      // Checked first: a claim this bundle may not see is named only through the sources that restrict it, never by its key, whatever else is true of it.
      if (!permitted(cl.classification, cl.allowedUse)) {
        for (const x of [...cl.citations, ...cl.disputedBy]) {
          const r = all.get(refKey(x));
          if (r && !permitted(r.classification, r.allowedUse)) restricting.add(x.sourceId);
        }
        continue;
      }
      if (cl.status === 'unsupported' || deadNow(cl)) { omit(cl.standing === 'accepted' && cl.disputedBy.some((x) => !isDead(x)) ? 'accepted_source_revoked' : 'revoked'); continue; }
      if (cl.status === 'stale' || staleNow(cl) || (cl.commit !== null && cl.commit !== input.task.baseSha)) { omit('stale'); continue; }
      const crit = CRITERION_KEY.exec(cl.key);
      const component = stackKeyPath(cl.key);
      if ((cl.taskId !== null && !inScopeTasks.has(cl.taskId)) || (crit !== null && !criteria.has(crit[1]!)) || (component !== null && !stackInScope(component, input.task.paths ?? []))) { omit('out_of_scope'); continue; }
      const size = cl.text.length + cl.heading.length;
      if (cl.text.length > BRAIN_BUNDLE_MAX_CLAIM_CHARS || used + size > max) { omit('too_large'); continue; }
      used += size;
      const citations = cl.citations.filter((x) => !isDead(x));
      for (const x of citations) { pinned.set(refKey(x), { sourceId: x.sourceId, revision: x.revision }); servedFrom.add(x.sourceId); }
      const standing = citations.some((x) => all.get(refKey(x))?.standing === 'accepted') ? 'accepted' : 'proposed';
      served.push({ claimId: cl.claimId, page: cl.page, key: cl.key, heading: cl.heading, text: cl.text, status: cl.status === 'disputed' ? 'disputed' : 'current', standing, citations });
    }
  }

  // Sources, by their latest revision: revoked, not for this destination at all, or every claim they state left out; then the sections that state no claim.
  for (const rev of [...latest.values()].sort((a, b) => byString(a.sourceId, b.sourceId))) {
    if (revoked.has(rev.sourceId)) { omissions.push({ kind: 'source', id: rev.sourceId, reason: 'revoked' }); continue; }
    if (!permitted(rev.classification, rev.allowedUse) || restricting.has(rev.sourceId)) { omissions.push({ kind: 'source', id: rev.sourceId, reason: 'restricted_for_destination' }); continue; }
    const why = dropped.get(rev.sourceId);
    if (why !== undefined && !servedFrom.has(rev.sourceId)) omissions.push({ kind: 'source', id: rev.sourceId, reason: why });
    for (const sec of rev.sections) if (sec.key === undefined) omissions.push({ kind: 'section', id: `${rev.sourceId}@${rev.revision}#${sec.anchor}`, reason: 'not_a_claim' });
  }

  return {
    schemaVersion: 1, destination: input.destination, taskId: input.task.taskId,
    compilationVersion: c?.version ?? null, generator: c?.generator ?? { id: BRAIN_GENERATOR.id, version: BRAIN_GENERATOR.version },
    watermark: c?.watermark ?? 0, sourceHead: input.sourceHead, compiledAt: c?.generatedAt ?? null,
    indexLag: Math.max(input.recordsPending === true ? 1 : 0, input.sourceHead - (c?.watermark ?? 0)), recordsPending: input.recordsPending === true,
    pinned: [...pinned.values()].sort((a, b) => byString(a.sourceId, b.sourceId) || a.revision - b.revision),
    claims: served, omissions,
  };
}

/**
 * The labels of what a context bundle actually holds (H5 fix round 3), for a call whose route keeps it on the device. A bundle that cannot be read is restricted. A
 * claim carries no label of its own yet (a carry), so each served claim counts as internal; restricted or secret sources reach a task's own label, which the call
 * counts separately. A bundle with no claims carries no content. A device bundle on a cloud-capable route is judged by where it was built instead: restricted.
 */
export function bundleContentLabels(bundle: unknown): string[] {
  if (bundle === null || bundle === undefined) return [];
  const b = BrainBundleSchema.safeParse(bundle);
  if (!b.success) return ['restricted'];
  return b.data.claims.length === 0 ? [] : ['internal'];
}
