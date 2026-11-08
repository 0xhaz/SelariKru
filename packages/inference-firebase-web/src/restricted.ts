import { canonicalJson, err, ok, type Result } from '@selarikru/domain';
import { deriveClassification, type Classification, type PolicyDecision } from '@selarikru/policy';
import type { AssistantProposal } from './adapter.ts';

/**
 * Memory-only holder for drafts derived from restricted (or secret) sources. It has no I/O: it imports no
 * network, storage or telemetry API, so there is nothing for content to leak into. Content is held on
 * non-enumerable properties so serializing a draft or the hold (JSON, logging, structured clone into a
 * checkpoint) yields only metadata.
 */
export interface LocalDraft {
  readonly id: string;
  /** Derived from the sources by the strongest label. A model cannot change it. */
  readonly classification: Classification;
  /** Non-enumerable: present on the object, absent from JSON and enumeration. */
  readonly proposal: AssistantProposal;
}

export interface HoldInput {
  readonly id: string;
  readonly sourceClassifications: readonly Classification[];
  readonly proposal: AssistantProposal;
}

export class RestrictedDraftHold {
  readonly #drafts = new Map<string, LocalDraft>();

  hold(input: HoldInput): LocalDraft {
    const classification = deriveClassification(input.sourceClassifications);
    if (classification === undefined) throw new Error('draft needs at least one validly classified source');
    const draft = { id: input.id, classification } as { id: string; classification: Classification; proposal?: AssistantProposal };
    Object.defineProperty(draft, 'proposal', { value: input.proposal, enumerable: false });
    Object.defineProperty(draft, 'toString', { value: () => `[LocalDraft ${input.id} ${classification}]`, enumerable: false });
    Object.freeze(draft);
    this.#drafts.set(input.id, draft as LocalDraft);
    return draft as LocalDraft;
  }

  get(id: string): LocalDraft | undefined {
    return this.#drafts.get(id);
  }

  discard(id: string): void {
    this.#drafts.delete(id);
  }

  clear(): void {
    this.#drafts.clear();
  }

  toJSON(): { held: number } {
    return { held: this.#drafts.size };
  }
}

/** What the browser sends to ask for a reclassification: identifiers, labels and a reason. Never draft text. */
export interface ReclassificationRequest {
  readonly draftId: string;
  readonly contentSha256: string;
  readonly sourceClassification: Classification;
  readonly targetClassification: 'public' | 'internal';
  readonly reason: string;
}

export function reclassificationRequest(
  draft: LocalDraft,
  contentSha256: string,
  reason: string,
  targetClassification: 'public' | 'internal' = 'internal',
): ReclassificationRequest {
  if (draft.classification === 'secret') throw new Error('secret drafts are never published');
  if (reason.trim() === '') throw new Error('a reclassification needs a reason');
  return { draftId: draft.id, contentSha256, sourceClassification: draft.classification, targetClassification, reason: reason.trim() };
}

/** SHA-256 over the canonical JSON of the draft's data. The server computes the same over what it is shown. */
export async function draftContentSha256(draft: LocalDraft): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(draft.proposal.data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returned by the server after it evaluated `modify_policy` for the authenticated owner and persisted the decision. */
export interface ReclassificationGrant {
  readonly grantId: string;
  readonly draftId: string;
  readonly contentSha256: string;
  readonly sourceClassification: Classification;
  readonly targetClassification: 'public' | 'internal';
  readonly decision: PolicyDecision;
}

export interface PublishedDraft {
  readonly id: string;
  readonly classification: Classification;
  readonly reclassifiedFrom: Classification;
  readonly grantId: string;
  /** The recorded server `evaluate` decision that permitted it. */
  readonly decision: PolicyDecision;
}

/**
 * A restricted draft stays restricted. This local gate refuses unless a server grant is presented that is bound to this
 * exact draft ID and content hash, lowers the label, and carries an allow decision. The browser cannot evaluate policy;
 * the server independently verifies the same grant before it accepts anything derived from the draft.
 */
export async function publishDraft(draft: LocalDraft, grant: ReclassificationGrant | undefined): Promise<Result<PublishedDraft, string>> {
  if (draft.classification === 'public' || draft.classification === 'internal') return err('not_restricted: nothing to reclassify');
  if (draft.classification === 'secret') return err('secret drafts are never published');
  if (!grant) return err('source_restricted: publishing needs a separate permitted policy change');
  if (grant.draftId !== draft.id) return err('grant_not_for_this_draft');
  if (grant.sourceClassification !== draft.classification) return err('grant_source_mismatch');
  if (grant.targetClassification !== 'public' && grant.targetClassification !== 'internal') return err('invalid_target_classification');
  if (grant.contentSha256 !== (await draftContentSha256(draft))) return err('grant_content_mismatch');
  if (grant.decision?.decision !== 'allow' || grant.decision.record !== 'policy_decision') return err('grant_decision_not_allow');
  return ok({ id: draft.id, classification: grant.targetClassification, reclassifiedFrom: draft.classification, grantId: grant.grantId, decision: grant.decision });
}
