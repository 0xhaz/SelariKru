import { z } from 'zod';

export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'secret'] as const;
export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

const RANK: Record<Classification, number> = { public: 0, internal: 1, restricted: 2, secret: 3 };

export function strongest(a: Classification, b: Classification): Classification {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Derived content (summaries, embeddings, logs, patches) inherits the strongest source label. */
export function deriveClassification(sources: readonly Classification[]): Classification | undefined {
  let out: Classification | undefined;
  for (const s of sources) out = out === undefined ? s : strongest(out, s);
  return out;
}

export interface ClassificationProposal {
  readonly label: Classification;
  /** True when a lower label was proposed and ignored. */
  readonly loweringIgnored: boolean;
}

/** A model may suggest a label but never lower the derived one. */
export function applyProposedClassification(derived: Classification, proposed: Classification): ClassificationProposal {
  const label = strongest(derived, proposed);
  return { label, loweringIgnored: RANK[proposed] < RANK[derived] };
}
