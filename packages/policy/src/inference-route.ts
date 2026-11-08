import { deriveClassification, ClassificationSchema, type Classification } from './classification.ts';
import { isDestinationGranted, type Source } from './destinations.ts';
import type { Policy } from './policy.ts';

export type { Source };

export const FIREBASE_CLOUD_ROUTE = 'firebase-ai-logic-cloud';
export const INFERENCE_MODES = ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

export interface Routed {
  readonly blocked: false;
  readonly mode: InferenceMode;
  readonly allowFallback: boolean;
  readonly reason: string;
  readonly policyVersion: string;
}
export interface Blocked {
  readonly blocked: true;
  readonly reason: string;
  readonly policyVersion: string;
}

/** Cloud approval needs an inference grant for this route covering the label, and an explicitly selected source. */
function cloudApproved(src: { id: string; classification: Classification }, policy: Policy): boolean {
  if (src.classification === 'restricted' || src.classification === 'secret') return false;
  if (!policy.selectedSources?.includes(src.id)) return false;
  return isDestinationGranted('inference', FIREBASE_CLOUD_ROUTE, src.classification, policy);
}

export function resolveInferenceMode(sources: readonly Source[], policy: Policy | undefined): Routed | Blocked {
  if (!policy) return { blocked: true, reason: 'missing_policy', policyVersion: 'unknown' };
  const v = policy.policyVersion;
  const blocked = (reason: string): Blocked => ({ blocked: true, reason, policyVersion: v });

  if (sources.length === 0) return blocked('no_sources');
  const classified: { id: string; classification: Classification }[] = [];
  for (const s of sources) {
    const c = ClassificationSchema.safeParse(s.classification);
    if (!c.success) return blocked('unclassified_source');
    classified.push({ id: s.id, classification: c.data });
  }
  const strongestLabel = deriveClassification(classified.map((s) => s.classification));
  if (strongestLabel === 'secret') return blocked('secret_excluded_from_model_context');
  if (strongestLabel === 'restricted') {
    return { blocked: false, mode: 'ONLY_ON_DEVICE', allowFallback: false, reason: 'restricted_on_device_only', policyVersion: v };
  }

  const mode = policy.preferredMode;
  if (!mode) return blocked('missing_preferred_mode');
  const cloudOk = classified.every((s) => cloudApproved(s, policy));
  const ok = (allowFallback: boolean, reason: string): Routed => ({ blocked: false, mode, allowFallback, reason, policyVersion: v });

  switch (mode) {
    case 'ONLY_ON_DEVICE':
      return ok(false, 'device_only');
    case 'PREFER_ON_DEVICE':
      return cloudOk ? ok(true, 'cloud_fallback_approved') : ok(false, 'cloud_fallback_not_approved');
    case 'ONLY_IN_CLOUD':
      return cloudOk ? ok(false, 'cloud_approved') : blocked('missing_destination:firebase_cloud_inference');
    case 'PREFER_IN_CLOUD':
      return cloudOk ? ok(true, 'cloud_approved') : blocked('missing_destination:firebase_cloud_inference');
    default:
      return blocked('invalid_mode');
  }
}
