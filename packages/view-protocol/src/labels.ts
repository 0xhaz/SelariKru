import type { InferenceMode } from '@selarikru/policy';

/**
 * The two independent axes. Assistant inference: where the browser assistant's model runs. Worker execution: where the coding worker's
 * sandbox runs. A local worker may call a cloud model, so neither implies the other.
 */
export const INFERENCE_LABELS: Readonly<Record<InferenceMode, string>> = {
  ONLY_ON_DEVICE: 'Device only',
  PREFER_ON_DEVICE: 'Device preferred',
  ONLY_IN_CLOUD: 'Cloud only',
  PREFER_IN_CLOUD: 'Cloud preferred',
};
export const EXECUTION_LABELS = { local: 'Local sandbox', cloud: 'Cloud sandbox', unknown: 'Execution unknown' } as const;
export const OBSERVED_SOURCE_LABELS = { on_device: 'Observed on device', in_cloud: 'Observed in cloud', unknown: 'Source unknown' } as const;
export const MODEL_ROUTE_LABELS = { device: 'Model on device', cloud: 'Model in cloud', unknown: 'Model route unknown' } as const;
