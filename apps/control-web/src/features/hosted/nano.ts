import type { DeviceReadiness } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';

/**
 * H9 item 3: what this browser can do when Gemini Nano is not available, per route, in plain words. Not an error: an expected state, said once and calmly. Read from
 * each task's route in the snapshot (its effective mode and lock), so the tasks named are the ones that will behave that way.
 */
export interface NanoBanner {
  readonly title: string;
  readonly lines: readonly { readonly route: string; readonly text: string }[];
  readonly href: string;
}

export const CHROME_AI_HELP = 'https://developer.chrome.com/docs/ai/get-started';

const TITLE: Readonly<Record<Exclude<DeviceReadiness, 'available'>, string>> = {
  unavailable: 'Gemini Nano is not available in this browser',
  downloadable: 'Gemini Nano is not downloaded in this browser yet',
  downloading: 'Gemini Nano is still downloading in this browser',
  unknown: 'This browser did not say whether Gemini Nano is available',
  evicted: 'Gemini Nano was removed from this browser and is not downloaded again yet',
};

const named = (rule: string, titles: readonly string[] | null): string => (titles === null || titles.length === 0 ? `${rule}.` : `${rule}: ${titles.join(', ')}.`);

export function nanoBanner(availability: DeviceReadiness, snapshot: ProjectViewSnapshot | null): NanoBanner | null {
  if (availability === 'available') return null;
  const tasks = snapshot ? Object.values(snapshot.tasks).filter((t) => t.route !== undefined && t.route !== null) : null;
  const pick = (test: (t: NonNullable<typeof tasks>[number]) => boolean): string[] | null => (tasks ? tasks.filter(test).map((t) => `${t.title ?? t.taskId}${t.route!.lock ? ' (restricted)' : ''}`) : null);
  return {
    title: TITLE[availability],
    lines: [
      { route: 'Local first → cloud', text: named('Runs in the cloud instead, labelled as a fallback', pick((t) => !t.route!.lock && t.route!.effective === 'PREFER_ON_DEVICE')) },
      { route: 'Cloud first and Cloud only', text: named('Run in the cloud as usual', pick((t) => !t.route!.lock && (t.route!.effective === 'PREFER_IN_CLOUD' || t.route!.effective === 'ONLY_IN_CLOUD'))) },
      { route: 'Local only and restricted', text: named('Blocked until Gemini Nano is available, never sent to the cloud', pick((t) => t.route!.lock !== null || t.route!.effective === 'ONLY_ON_DEVICE')) },
    ],
    href: CHROME_AI_HELP,
  };
}
