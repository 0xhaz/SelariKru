import { z } from 'zod';
import { EventEnvelopeSchema } from '@selarikru/domain';
import { ProvenanceSchema } from './common.ts';

/**
 * A view event is a real domain event envelope (same names, same actor kinds, same payload bag) plus the provenance of the source
 * that delivered it. A live source adds `observed`; the mock adds `simulated`. Nothing here is a parallel event vocabulary.
 */
export const ProjectViewEventSchema = EventEnvelopeSchema.extend({ provenance: ProvenanceSchema });
export type ProjectViewEvent = z.infer<typeof ProjectViewEventSchema>;
