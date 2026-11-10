import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { composePrompt, narrowSchema, payloadSha256, systemInstructionFor } from '@selarikru/inference-firebase-web/models';
import type { Manifest } from '../manifest.ts';

/**
 * Track A requests, composed exactly as the product's assistant adapter composes them: the fixture's system
 * instruction, then the fixture prompt followed by its allowed requirement IDs in fixed order (`composePrompt`), with
 * the response schema's requirement-ID enum narrowed to that fixture. `payloadSha256` is the logical digest of the
 * UTF-8 system instruction and prompt, the same function the browser adapter records. Nothing here depends on the
 * route, so both routes send identical payloads.
 */

const FixtureSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  allowedRequirementIds: z.array(z.string().min(1)).min(1),
  humanReviewFacts: z.array(z.string()),
  forbiddenMandatoryScope: z.array(z.string()),
});

export const BriefFixturesSchema = z.object({
  version: z.string(),
  dataClassification: z.literal('synthetic_cloud_permitted'),
  systemInstruction: z.string().min(1),
  outputSchema: z.record(z.string(), z.unknown()),
  fixtures: z.array(FixtureSchema).min(1),
  reviewMethod: z.string(),
});
export type BriefFixtures = z.infer<typeof BriefFixturesSchema>;
export type BriefFixture = z.infer<typeof FixtureSchema>;

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/** Reads the manifest's fixture file and checks it is the one the manifest plans: the same ids, and the product's own system instruction. */
export function loadBriefFixtures(manifest: Manifest, repoRoot: string): BriefFixtures {
  const path = isAbsolute(manifest.assistant.fixtureFile) ? manifest.assistant.fixtureFile : join(repoRoot, manifest.assistant.fixtureFile);
  const parsed = BriefFixturesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new FixtureError(`the brief fixtures are not valid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const fixtures = parsed.data;
  const ids = new Set(fixtures.fixtures.map((f) => f.id));
  const missing = manifest.assistant.fixtureIds.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new FixtureError(`the manifest plans fixtures the file does not have: ${missing.join(', ')}`);
  if (fixtures.systemInstruction !== systemInstructionFor('draftBrief')) throw new FixtureError('the fixture system instruction differs from the assistant adapter\'s draftBrief instruction');
  return fixtures;
}

export interface ComposedRequest {
  readonly fixtureId: string;
  readonly systemInstruction: string;
  readonly prompt: string;
  /** Sent with the request: the shared schema with requirement IDs narrowed to this fixture. */
  readonly responseSchema: Readonly<Record<string, unknown>>;
  readonly payloadSha256: string;
  /** UTF-8 bytes of the logical payload. Bytes, labelled as bytes: never provider tokens. */
  readonly inputBytes: number;
}

export async function composeRequest(fixtures: BriefFixtures, fixtureId: string): Promise<ComposedRequest> {
  const fixture = fixtures.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) throw new FixtureError(`no fixture ${fixtureId}`);
  const systemInstruction = fixtures.systemInstruction;
  const prompt = composePrompt(fixture.prompt, fixture.allowedRequirementIds);
  return {
    fixtureId, systemInstruction, prompt,
    responseSchema: narrowSchema('draftBrief', fixture.allowedRequirementIds),
    payloadSha256: await payloadSha256(systemInstruction, prompt),
    inputBytes: Buffer.byteLength(`${systemInstruction}\n\n${prompt}`, 'utf8'),
  };
}
