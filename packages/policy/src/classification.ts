import { z } from 'zod';

export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'secret'] as const;
export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

const RANK: Record<Classification, number> = { public: 0, internal: 1, restricted: 2, secret: 3 };

const isLabel = (x: unknown): x is Classification => ClassificationSchema.safeParse(x).success;

/** Fails closed: an unknown label is treated as `secret`. */
export function strongest(a: Classification, b: Classification): Classification {
  if (!isLabel(a) || !isLabel(b)) return 'secret';
  return RANK[a] >= RANK[b] ? a : b;
}

/** Derived content (summaries, embeddings, logs, patches) inherits the strongest source label. Any invalid element yields undefined. */
export function deriveClassification(sources: readonly Classification[]): Classification | undefined {
  let out: Classification | undefined;
  for (const s of sources) {
    if (!isLabel(s)) return undefined;
    out = out === undefined ? s : strongest(out, s);
  }
  return out;
}

export interface ClassificationProposal {
  readonly label: Classification;
  /** True when a lower label was proposed and ignored. */
  readonly loweringIgnored: boolean;
  /** True when the proposal was not a valid label and was ignored. */
  readonly invalidIgnored: boolean;
}

/** A model may suggest a label but never lower the derived one. Invalid proposals are ignored. */
export function applyProposedClassification(derived: Classification, proposed: unknown): ClassificationProposal {
  if (!isLabel(proposed)) return { label: derived, loweringIgnored: false, invalidIgnored: true };
  return { label: strongest(derived, proposed), loweringIgnored: RANK[proposed] < RANK[derived], invalidIgnored: false };
}
