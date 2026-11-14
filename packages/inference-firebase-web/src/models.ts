import type { InferenceMode } from '@selarikru/policy';

/** Pinned in T0.4 (spike evidence docs/evidence/spike-firebase.md). */
export const SDK_VERSION = '13.1.0';
export const CLOUD_MODEL = 'gemini-3.5-flash-lite';
export const MODEL_METADATA = { cloudModel: CLOUD_MODEL, sdkVersion: SDK_VERSION } as const;

/** The onboarding operations (draft wording, criteria and a plan before any task exists). */
export const OPERATIONS = ['draftBrief', 'suggestCriteria', 'draftTaskPlan'] as const;
export type OnboardingOperation = (typeof OPERATIONS)[number];
/** The catalog agents that have no onboarding twin. The brief and criteria agents reuse `draftBrief` and `suggestCriteria`. */
export const AGENT_ONLY_OPERATIONS = ['planTasks', 'breakDownTask', 'proposePatch', 'selectFiles', 'reviewChange', 'triageFailure', 'describePullRequest', 'pmAnswer', 'pmResearch', 'pmPlan', 'pmDelegate', 'pmBrief', 'pmVerify', 'pmVerifyNoWeb'] as const;
export type Operation = OnboardingOperation | (typeof AGENT_ONLY_OPERATIONS)[number];

type Schema = Record<string, unknown>;

const criterion = {
  type: 'object',
  additionalProperties: false,
  required: ['requirementId', 'text'],
  properties: {
    requirementId: { type: 'string' },
    text: { type: 'string', minLength: 1, maxLength: 400 },
  },
};

const criteria = { type: 'array', minItems: 1, maxItems: 8, items: criterion };

/** Base schemas. `requirementId(s)` is narrowed per request by `narrowSchema`; never sent un-narrowed. */
const SCHEMAS: Record<OnboardingOperation, Schema> = {
  draftBrief: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'acceptanceCriteria'],
    properties: { summary: { type: 'string', minLength: 1, maxLength: 400 }, acceptanceCriteria: criteria },
  },
  suggestCriteria: {
    type: 'object',
    additionalProperties: false,
    required: ['acceptanceCriteria'],
    properties: { acceptanceCriteria: criteria },
  },
  draftTaskPlan: {
    type: 'object',
    additionalProperties: false,
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'requirementIds', 'role'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', minLength: 1, maxLength: 600 },
            requirementIds: { type: 'array', minItems: 1, items: { type: 'string' } },
            role: { type: 'string', enum: ['backend', 'frontend'] },
          },
        },
      },
    },
  },
};

const SYSTEM_INSTRUCTIONS: Record<OnboardingOperation, string> = {
  draftBrief:
    'Draft a concise summary and 1–8 testable acceptance criteria using only the supplied scope. Return JSON matching the schema. Use the supplied requirement IDs. Do not add mandatory integrations, accounts or new features.',
  suggestCriteria:
    'Suggest 1–8 testable acceptance criteria using only the supplied scope. Return JSON matching the schema. Use the supplied requirement IDs. Do not add mandatory integrations, accounts or new features.',
  draftTaskPlan:
    'Draft a short ordered task plan using only the supplied scope. Return JSON matching the schema. Each task cites the supplied requirement IDs it serves and names its role: backend for the API and storage, frontend for the screen. Do not add mandatory integrations, accounts or new features.',
};

export function systemInstructionFor(op: OnboardingOperation): string {
  return SYSTEM_INSTRUCTIONS[op];
}

/** Deep copy of the operation's schema with every requirementId(s) enum narrowed to the allowed IDs. */
export function narrowSchema(op: OnboardingOperation, allowedIds: readonly string[]): Schema {
  const copy = structuredClone(SCHEMAS[op]);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'requirementId' && v && typeof v === 'object') (v as Schema)['enum'] = [...allowedIds];
      else if (k === 'requirementIds' && v && typeof v === 'object') {
        ((v as Schema)['items'] as Schema)['enum'] = [...allowedIds];
      } else walk(v);
    }
  };
  walk(copy);
  return copy;
}

/** Fixed order: task text, then allowed IDs. */
export function composePrompt(taskText: string, allowedIds: readonly string[]): string {
  return `${taskText}\n\nAllowed requirement IDs: ${allowedIds.join(', ')}. Use only these IDs. Several criteria may share one ID.`;
}

/** SHA-256 hex of the exact UTF-8 payload: system instruction, blank line, prompt. Browser-safe. */
export async function payloadSha256(systemInstruction: string, prompt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${systemInstruction}\n\n${prompt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ObservedSource = 'ON_DEVICE' | 'IN_CLOUD' | 'UNKNOWN';

export function mapInferenceSource(raw: string | undefined | null): ObservedSource {
  if (raw === 'on_device') return 'ON_DEVICE';
  if (raw === 'in_cloud') return 'IN_CLOUD';
  return 'UNKNOWN';
}

export type { InferenceMode };
