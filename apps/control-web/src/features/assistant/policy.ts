import { FIREBASE_CLOUD_ROUTE, type InferenceMode, type Policy } from '@selarikru/policy';
import type { BriefOption } from './fixtures.ts';

/**
 * Local request policy for this browser session. It decides what the adapter may ask for; the server stays the
 * authority for anything that becomes work. Cloud approval is granted only for non-restricted sources, and only
 * when the engineer says this source may use cloud inference.
 */
export function buildPolicy(mode: InferenceMode, brief: BriefOption, cloudPermitted: boolean): Policy {
  const grant = cloudPermitted && !brief.restricted;
  return {
    policyVersion: 'browser-session.1',
    preferredMode: mode,
    selectedSources: grant ? [brief.id] : [],
    destinations: grant ? [{ destination: FIREBASE_CLOUD_ROUTE, purpose: 'inference', classifications: ['public', 'internal'] }] : [],
  };
}
