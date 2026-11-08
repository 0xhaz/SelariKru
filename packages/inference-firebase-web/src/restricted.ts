import { err, ok, type Result } from '@selarikru/domain';
import { deriveClassification, evaluate, type Classification, type Policy, type PolicyDecision } from '@selarikru/policy';
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

/** Supplied by the authenticated administrator flow, never derived from model output. */
export interface PolicyChange {
  readonly actor: 'agent' | 'administrator' | 'unknown';
  readonly targetClassification: Exclude<Classification, 'secret'>;
  readonly reason: string;
}

export interface PublishedDraft {
  readonly id: string;
  readonly classification: Classification;
  readonly reclassifiedFrom: Classification;
  readonly reason: string;
  /** The recorded `evaluate` decision that permitted it. */
  readonly decision: PolicyDecision;
}

/**
 * A restricted draft stays restricted. It can be published to hosted coordination only after a separate,
 * explicit reclassification that `evaluate` allows for the administrator (`modify_policy`). Without that change,
 * with a secret source, or with a target that is not lower than the source label, this denies.
 */
export function publishDraft(draft: LocalDraft, policy: Policy | undefined, change?: PolicyChange): Result<PublishedDraft, string> {
  if (draft.classification === 'public' || draft.classification === 'internal') {
    return err('not_restricted: nothing to reclassify');
  }
  if (draft.classification === 'secret') return err('secret drafts are never published');
  if (!change) return err('source_restricted: publishing needs a separate permitted policy change');
  if (change.targetClassification !== 'public' && change.targetClassification !== 'internal') return err('invalid_target_classification');
  const decision = evaluate({ kind: 'modify_policy', actor: change.actor }, policy);
  if (decision.decision !== 'allow') return err(`policy_${decision.decision}: ${decision.reason}`);
  return ok({ id: draft.id, classification: change.targetClassification, reclassifiedFrom: draft.classification, reason: change.reason, decision });
}
