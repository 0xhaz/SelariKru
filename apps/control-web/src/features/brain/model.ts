import { formatAge, type Tone } from '@selarikru/ui';
import type { BrainCitation, BrainClaimStatus, BrainOmissionReason } from '@selarikru/domain';
import type { AttemptContextView, BrainView } from '@selarikru/view-protocol';

/**
 * The Brain view and the drawer's Context tab, as plain data. Claim and source text is carried as strings and rendered as text nodes: it is data from sources, never
 * markup and never an instruction.
 */

export interface CitationLink { readonly label: string; readonly href: string }
export interface ClaimRow {
  readonly claimId: string;
  readonly key: string;
  readonly heading: string;
  readonly text: string;
  readonly status: { readonly label: string; readonly tone: Tone; readonly detail: string };
  /** False: this claim is not served to workers now. */
  readonly served: boolean;
  readonly restricted: boolean;
  readonly classification: string;
  readonly citations: readonly CitationLink[];
  readonly disputedBy: readonly CitationLink[];
  readonly conflictId: string | null;
}
export interface PageModel { readonly id: string; readonly title: string; readonly classification: string; readonly claims: readonly ClaimRow[] }
export interface SourceRow {
  readonly sourceId: string;
  readonly title: string;
  readonly kind: string;
  readonly standing: string;
  readonly classification: string;
  readonly use: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly provenance: string;
  readonly state: 'In use' | 'Revoked';
  readonly canRevoke: boolean;
  readonly href: string;
}
export interface BrainModel {
  readonly empty: boolean;
  readonly freshness: { readonly version: string; readonly compiled: string | null; readonly compiledAt: string | null; readonly lag: string; readonly generator: string | null };
  readonly counts: Readonly<Record<BrainClaimStatus, number>>;
  readonly pages: readonly PageModel[];
  readonly sources: readonly SourceRow[];
}

const STATUS: Readonly<Record<BrainClaimStatus, { label: string; tone: Tone; detail: string }>> = {
  current: { label: 'Current', tone: 'success', detail: 'Supported by a current source revision.' },
  disputed: { label: 'Disputed', tone: 'warning', detail: 'A newer source states a different value. The accepted value stands until a person decides.' },
  stale: { label: 'Stale', tone: 'warning', detail: 'Its source changed and no longer states this. Not served to workers.' },
  unsupported: { label: 'Unsupported', tone: 'danger', detail: 'Every source behind it was revoked. Not served to workers.' },
};
const LABEL: Readonly<Record<string, string>> = { public: 'Public', internal: 'Internal', restricted: 'Restricted', secret: 'Secret' };
const KIND: Readonly<Record<string, string>> = { brief: 'Brief', criteria: 'Criteria', plan: 'Plan', decision: 'Decision', verification: 'Verification', repo_manifest: 'Repository manifest', note: 'Note' };
const labelOf = (c: string): string => LABEL[c] ?? 'Unknown label';
const isRestricted = (c: string): boolean => c !== 'public' && c !== 'internal';

export const citationHref = (c: BrainCitation): string => `#/brain?${new URLSearchParams({ source: c.sourceId, rev: String(c.revision), anchor: c.anchor }).toString()}`;
const cite = (c: BrainCitation): CitationLink => ({ label: `${c.sourceId} · revision ${c.revision} · ${c.anchor}`, href: citationHref(c) });

/** The citation a `#/brain?source=…&rev=…&anchor=…` link names, or null. */
export function parseCitationTarget(q: URLSearchParams): BrainCitation | null {
  const sourceId = q.get('source');
  const rev = Number(q.get('rev'));
  if (!sourceId || !Number.isInteger(rev) || rev < 1) return null;
  return { sourceId, revision: rev, anchor: q.get('anchor') ?? '' };
}

const changes = (n: number, past = false): string => (n === 0 ? 'Up to date' : `${n} source change${n === 1 ? (past ? ' was' : ' is') : past ? 's were' : 's are'} not compiled yet`);

export function brainModel(view: BrainView, nowMs: number): BrainModel {
  const c = view.compilation;
  const pages = (c?.pages ?? []).map((p) => ({
    id: p.page, title: p.title, classification: labelOf(p.classification),
    claims: p.claims.map((cl): ClaimRow => ({
      claimId: cl.claimId, key: cl.key, heading: cl.heading, text: cl.text, status: STATUS[cl.status], served: cl.status === 'current' || cl.status === 'disputed',
      restricted: isRestricted(cl.classification), classification: labelOf(cl.classification), citations: cl.citations.map(cite), disputedBy: cl.disputedBy.map(cite), conflictId: cl.conflictId,
    })),
  }));
  const counts = { current: 0, disputed: 0, stale: 0, unsupported: 0 };
  for (const p of c?.pages ?? []) for (const cl of p.claims) counts[cl.status] += 1;
  return {
    empty: c === null,
    freshness: {
      version: c ? `Version ${c.version}` : 'Not compiled yet', compiledAt: c?.generatedAt ?? null, compiled: c ? formatAge(nowMs - Date.parse(c.generatedAt)) : null,
      lag: changes(view.indexLag), generator: c ? `${c.generator.id} ${c.generator.version}` : null,
    },
    counts, pages,
    sources: view.sources.map((s) => ({
      sourceId: s.sourceId, title: s.title, kind: KIND[s.kind] ?? s.kind, standing: s.standing === 'accepted' ? 'Accepted' : 'Proposed (a note, never accepted scope)',
      classification: labelOf(s.classification), use: s.allowedUse.includes('cloud') ? 'Local and cloud workers' : 'Local workers only', revision: s.latestRevision, recordedAt: s.recordedAt,
      provenance: `${s.provenance.origin}: ${s.provenance.ref}`, state: s.revoked ? 'Revoked' : 'In use', canRevoke: !s.revoked,
      href: citationHref({ sourceId: s.sourceId, revision: s.latestRevision, anchor: '' }),
    })),
  };
}

export interface ConflictCard {
  readonly conflictId: string;
  readonly title: string;
  readonly accepted: string;
  readonly proposed: string;
  readonly acceptedCitation: CitationLink;
  readonly proposedCitation: CitationLink;
  readonly consequence: string;
  readonly href: string;
}

/** One decision proposal per open conflict. Settling it can only keep the accepted value: changing accepted scope goes through its own workflow. */
export function conflictCards(view: BrainView | null): ConflictCard[] {
  return (view?.conflicts ?? []).filter((c) => c.state === 'open').map((c) => ({
    conflictId: c.conflictId, title: `A source disputes ${c.key}`, accepted: c.accepted.text, proposed: c.proposed.text, acceptedCitation: cite(c.accepted), proposedCitation: cite(c.proposed),
    consequence: 'Nothing changes accepted scope by itself. Keep the accepted value here, or change the criterion through a new blueprint version or a replan.',
    href: `#/brain?conflict=${encodeURIComponent(c.conflictId)}`,
  }));
}

const OMISSION: Readonly<Record<BrainOmissionReason, string>> = {
  revoked: 'Revoked source', stale: 'Stale', restricted_for_destination: 'Restricted for this destination', too_large: 'Too large to include', out_of_scope: 'Out of scope for this task',
};

export interface ContextModel {
  readonly destination: string;
  readonly recordedAt: string;
  readonly version: string;
  readonly lag: string;
  readonly claims: readonly { readonly claimId: string; readonly key: string; readonly heading: string; readonly text: string; readonly status: string; readonly citations: readonly CitationLink[] }[];
  readonly omissions: readonly { readonly id: string; readonly kind: string; readonly reason: string }[];
  readonly pinned: readonly string[];
}

export function contextModel(ctx: AttemptContextView | null): ContextModel | null {
  if (!ctx) return null;
  const b = ctx.bundle;
  return {
    destination: ctx.destination === 'cloud' ? 'Cloud worker' : 'Local worker', recordedAt: ctx.recordedAt,
    version: b.compilationVersion === null ? 'Nothing was compiled yet' : `Version ${b.compilationVersion}`, lag: changes(b.indexLag, true),
    claims: b.claims.map((c) => ({ claimId: c.claimId, key: c.key, heading: c.heading, text: c.text, status: c.status === 'disputed' ? 'Disputed' : 'Current', citations: c.citations.map(cite) })),
    omissions: b.omissions.map((o) => ({ id: o.id, kind: o.kind === 'claim' ? 'Claim' : 'Source', reason: OMISSION[o.reason] })),
    pinned: b.pinned.map((p) => `${p.sourceId} · revision ${p.revision}`),
  };
}
