import type { DeviceReadiness, InferenceMode, ObservedSource, ProposalStatus } from '@selarikru/inference-firebase-web';

export type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

export const POLICY_LABEL: Record<InferenceMode, string> = {
  ONLY_ON_DEVICE: 'Device only',
  PREFER_ON_DEVICE: 'Device preferred',
  ONLY_IN_CLOUD: 'Cloud only',
  PREFER_IN_CLOUD: 'Cloud preferred',
};

export const POLICY_HINT: Record<InferenceMode, string> = {
  ONLY_ON_DEVICE: 'Never leaves this device. Blocked if the model is not ready.',
  PREFER_ON_DEVICE: 'Device first. Cloud only if this source is approved for it.',
  ONLY_IN_CLOUD: 'Cloud model only. Needs source approval.',
  PREFER_IN_CLOUD: 'Cloud first. Device if the cloud is unavailable and approved.',
};

export const MODES: readonly InferenceMode[] = ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'];

export function readinessLabel(d: DeviceReadiness | null): { text: string; tone: Tone } {
  switch (d) {
    case 'available': return { text: 'Ready: device model installed', tone: 'success' };
    case 'downloadable': return { text: 'Needs download', tone: 'warning' };
    case 'downloading': return { text: 'Downloading', tone: 'active' };
    case 'evicted': return { text: 'Needs re-download: the browser removed the model', tone: 'warning' };
    case 'unavailable': return { text: 'Unavailable in this browser', tone: 'danger' };
    case 'unknown': return { text: 'Unknown: the browser did not say', tone: 'neutral' };
    default: return { text: 'Checking', tone: 'neutral' };
  }
}

export const STATUS_LABEL: Record<ProposalStatus, { text: string; tone: Tone }> = {
  ok: { text: 'Response received', tone: 'success' },
  invalid: { text: 'Invalid output', tone: 'warning' },
  blocked: { text: 'Blocked by data policy', tone: 'warning' },
  route_violation: { text: 'Route violation', tone: 'danger' },
  unverified_source: { text: 'Source not verified', tone: 'danger' },
  error: { text: 'Request failed', tone: 'danger' },
};

export function sourceText(source: ObservedSource, status: ProposalStatus | 'demo' | 'idle' | 'generating'): { text: string; tone: Tone } {
  if (status === 'idle') return { text: 'Not requested yet', tone: 'neutral' };
  if (status === 'generating') return { text: 'Waiting for a response', tone: 'neutral' };
  if (status === 'demo') return { text: 'Demo data: no model ran', tone: 'neutral' };
  if (status === 'blocked') return { text: 'No response: blocked before any model call', tone: 'neutral' };
  if (status === 'error' && source === 'UNKNOWN') return { text: 'No response: the request failed', tone: 'neutral' };
  if (source === 'ON_DEVICE') return { text: 'On-device (reported by the SDK response)', tone: 'success' };
  if (source === 'IN_CLOUD') return { text: 'Cloud (reported by the SDK response)', tone: 'active' };
  return { text: 'Unknown: the SDK response did not report a source', tone: 'warning' };
}

/** Explains why a request did not run. Never includes prompt text. */
export function blockedExplanation(reason: string | null): { what: string; remedy: string } {
  const r = reason ?? 'unspecified';
  if (r.startsWith('device_')) {
    const state = r.slice('device_'.length);
    const why =
      state === 'downloadable' ? 'The on-device model is not downloaded yet.' :
      state === 'downloading' ? 'The on-device model is still downloading.' :
      state === 'unavailable' ? 'This browser cannot run the on-device model.' :
      state === 'evicted' ? 'The browser removed the on-device model.' :
      'The on-device model state is unknown.';
    return {
      what: `${why} This source must stay on the device, so there is no cloud fallback.`,
      remedy: state === 'downloadable' || state === 'evicted' ? 'Download the on-device model, then try again.' : state === 'downloading' ? 'Wait for the download to finish, then try again.' : 'Use a supported browser, or keep the work local without a draft.',
    };
  }
  switch (r) {
    case 'restricted_on_device_only':
    case 'secret_excluded_from_model_context':
      return { what: 'This source cannot be sent to a model that might run in the cloud.', remedy: 'Use Device only on a supported browser.' };
    case 'missing_policy':
    case 'missing_preferred_mode':
      return { what: 'No data policy is set for this request.', remedy: 'Choose a requested policy.' };
    case 'no_sources':
    case 'unclassified_source':
      return { what: 'The source has no valid classification.', remedy: 'Classify the source, then try again.' };
    case 'no_allowed_requirement_ids':
      return { what: 'The brief has no allowed requirement IDs, so a draft cannot be checked.', remedy: 'Pick a brief with requirement IDs.' };
    case 'missing_destination:firebase_cloud_inference':
      return { what: 'This source is not approved for cloud inference.', remedy: 'Approve the source for cloud inference, or choose a device policy.' };
    case 'cloud_source_without_approval':
      return { what: 'A cloud response arrived for a request that was not approved for the cloud.', remedy: 'Nothing was kept. Report this; do not retry in the cloud.' };
    case 'source_not_shown_on_device':
      return { what: 'The response did not prove it came from the device, so the output was withheld.', remedy: 'Check the browser and try again.' };
    default:
      return { what: 'Data policy stopped this request.', remedy: 'Check the requested policy and the source approval.' };
  }
}

export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function fallbackFlag(mode: InferenceMode): boolean {
  return mode === 'PREFER_ON_DEVICE' || mode === 'PREFER_IN_CLOUD';
}
