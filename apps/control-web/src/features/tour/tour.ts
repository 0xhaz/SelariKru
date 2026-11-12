/**
 * H9 item 4: the first-visit guided demo story. Six short steps, each on a real screen of the demo data, pointing at the real element that shows it. Plain words;
 * it works the same under ?demo (dev) and in the hosted demo. Hand-rolled, with the app's own components: no tour library.
 */
export const TOUR_FIXTURE = 'feature-delivery';
const T = (local: string): string => `${TOUR_FIXTURE}.${local}`;

export interface TourStep {
  readonly title: string;
  readonly body: string;
  /** Where the step is shown. */
  readonly hash: string;
  /** What it points at: CSS selectors in order of preference (` || ` between them), or `roof:device` for the rooftop's ON THIS DEVICE box on the office canvas. */
  readonly target: string;
  /** Step 4 only: the real offline and reconnect actions. */
  readonly offline?: true;
  /** H9 fix round 1 (M2): asks the PM for a plan on demo data, through the PM panel itself. */
  readonly pm?: true;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Drafted on this device',
    body: 'The project brief was drafted by Gemini Nano, in this browser. The rooftop box ON THIS DEVICE lights up for every call that ran here, and counts them.',
    hash: '#/office', target: 'roof:device',
  },
  {
    title: 'Too big for Nano: planned in the cloud',
    body: 'The API task reads more text than Nano can take in one call, so its AI steps run Cloud first, with Gemini through Firebase. The route, and the reason, are shown on the task.',
    hash: `#/pipeline?task=${T('api')}`, target: `[data-testid="pipeline-row"][data-task-id="${T('api')}"] [data-testid="runs-on"]`,
  },
  {
    title: 'Restricted: Local only, never the cloud',
    body: 'The end-to-end checks read restricted data. Their AI steps are locked to Local only: they run on this device or wait, and nothing about them is sent to the cloud.',
    hash: `#/pipeline?task=${T('e2e')}`, target: `[data-testid="pipeline-row"][data-task-id="${T('e2e')}"] [data-testid="runs-on"]`,
  },
  {
    title: 'Offline, then reconnected',
    body: 'Go offline and run a Cloud only step: it is not an error, it waits here in Paused AI work. Reconnect, and it is checked again and sent: "Sent after reconnecting".',
    hash: '#/actions', target: '[data-testid="paused-work"]', offline: true,
  },
  {
    title: 'Ask the Project Manager',
    body: 'The Project Manager is an AI agent too. Ask it for a plan: it drafts one on demo data, and the plan is a proposal until you accept it.',
    hash: '#/pm', target: '[data-testid="pm-accept-plan"] || [data-testid="pm-question"]', pm: true,
  },
  {
    title: 'Where every call ran',
    body: 'AI calls lists every call from its route record, the PM\'s plan just now included: the route it asked for, and where it actually ran. Unknown stays unknown, and a restricted call shows its labels only.',
    hash: '#/calls', target: '[data-testid="ai-calls"]',
  },
];

/** The task the offline step runs: Cloud only, inside the accepted plan, so it is sent on its own once the connection is back. */
export const TOUR_OFFLINE_TASK = T('contract');

const KEY = 'selarikru.tour.offered';
type Store = Pick<Storage, 'getItem' | 'setItem'> | null;
const local = (): Store => (typeof localStorage === 'undefined' ? null : localStorage);

/** Whether the tour was offered (and put away) in this browser. Read in try/catch: blocked storage only means it is offered again. */
export function tourOffered(storage: Store = local()): boolean {
  try { return storage?.getItem(KEY) === '1'; } catch { return false; }
}

export function markTourOffered(storage: Store = local()): void {
  try { storage?.setItem(KEY, '1'); } catch { /* a convenience only */ }
}

/** The page that starts the tour: the demo project that shows every route, with the tour open, on the office. */
export function tourStartHref(href: string): string {
  const url = new URL(href);
  url.searchParams.set('fixture', TOUR_FIXTURE);
  url.searchParams.set('tour', '1');
  url.hash = '#/office';
  return url.toString();
}
