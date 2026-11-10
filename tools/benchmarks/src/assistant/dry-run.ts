import type { AssistantSdk } from '@selarikru/inference-firebase-web/bench';

/**
 * The assistant dry run's only stand-in: a scripted SDK behind the real bench bridge. It answers every request with a
 * schema-valid proposal that uses the first allowed requirement ID, from the requested route, and calls no model.
 * Records from it are `simulated`.
 */
export function scriptedSdk(): AssistantSdk {
  return {
    availability: async () => 'available',
    initializeDeviceModel: async () => undefined,
    createModel: (spec) => ({
      async generate(prompt) {
        const id = /Allowed requirement IDs: ([^,.]+)/.exec(prompt)?.[1] ?? 'FB-01';
        return {
          text: JSON.stringify({ summary: 'Dry run: a scripted proposal, not model output.', acceptanceCriteria: [{ requirementId: id, text: 'Dry run criterion.' }] }),
          inferenceSource: spec.mode === 'ONLY_ON_DEVICE' ? 'on_device' : 'in_cloud',
        };
      },
    }),
  };
}
