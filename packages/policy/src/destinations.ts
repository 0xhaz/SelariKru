import { ClassificationSchema, type Classification } from './classification.ts';
import type { Policy, Purpose } from './policy.ts';

export interface Source {
  readonly id: string;
  readonly classification?: Classification | undefined;
}

/**
 * True only when a grant for exactly this destination AND purpose lists the label.
 * A grant for one purpose never implies another. `secret` is never granted.
 */
export function isDestinationGranted(
  purpose: Purpose,
  destination: unknown,
  classification: unknown,
  policy: Policy | undefined,
): boolean {
  if (!policy || typeof destination !== 'string' || destination === '') return false;
  const c = ClassificationSchema.safeParse(classification);
  if (!c.success || c.data === 'secret') return false;
  return (policy.destinations ?? []).some(
    (g) => g.destination === destination && g.purpose === purpose && (g.classifications as readonly Classification[]).includes(c.data),
  );
}
