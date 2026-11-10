import { Ajv } from 'ajv';
import type { BriefFixture, BriefFixtures } from './payload.ts';

/**
 * Deterministic structural validation of one proposal: the unmodified shared output schema from the fixture file, and
 * then the fixture's own check that every returned requirement ID is one that fixture allows. Semantic judgments
 * (retained facts, invented scope) are a route-blinded human review, not this.
 */

export interface Validation {
  readonly schemaValid: boolean;
  /** Failure categories, in check order. Empty when valid. */
  readonly failures: readonly string[];
}

export function validator(fixtures: BriefFixtures): (fixture: BriefFixture, text: string | null) => Validation {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const shared = ajv.compile(fixtures.outputSchema);
  return (fixture, text) => {
    if (text === null) return { schemaValid: false, failures: ['no_output'] };
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { schemaValid: false, failures: ['output_not_json'] };
    }
    if (!shared(data)) return { schemaValid: false, failures: ['schema_invalid'] };
    const ids = ((data as { acceptanceCriteria?: { requirementId: string }[] }).acceptanceCriteria ?? []).map((c) => c.requirementId);
    if (ids.some((id) => !fixture.allowedRequirementIds.includes(id))) return { schemaValid: false, failures: ['requirement_id_outside_fixture'] };
    return { schemaValid: true, failures: [] };
  };
}
