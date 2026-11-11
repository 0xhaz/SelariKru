// The rooftop inference deck (H7 round 4): two boxes, ON THIS DEVICE (Gemini Nano) and CLOUD (Gemini), lit by the same facts as the rest of the app's
// hybrid view. Counts are each task's last route record in the run, as the top-bar counter counts them; "expected" is a call this browser has in flight;
// a fallback is a conforming record only, and a route violation is a discard on the box that answered, never a fallback. SelariKru's own.

import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import { isRouteViolation } from '../features/hybrid/model.ts';
import type { OfficeCall } from './model.ts';

export interface RoofBox {
  readonly place: 'device' | 'cloud';
  /** Tasks whose last call in the run ran here, conforming and not a fallback (a fallback has its own count). */
  readonly count: number;
  /** Short names of the tasks with a call in flight that is expected to run here. */
  readonly expected: readonly string[];
  /** The latest conforming call that ran here. The scene shows it solid for a moment when it is new. */
  readonly observed: { readonly task: string; readonly recordId: string } | null;
  /** The latest answer from here that broke its route: discarded, never a fallback. */
  readonly violation: { readonly task: string; readonly recordId: string } | null;
  /** Device box only: a call for a restricted or locked task is in flight, so it stays on this device. */
  readonly locked: boolean;
}

export interface OfficeRoof {
  readonly device: RoofBox;
  readonly cloud: RoofBox;
  /** The latest conforming fallback (this device to the cloud, or back). */
  readonly fellBack: { readonly task: string; readonly recordId: string } | null;
  readonly fellBackCount: number;
  readonly summary: string;
}

const short = (title: string): string => title.toUpperCase().slice(0, 10).trim();

export function roofState(snapshot: ProjectViewSnapshot, runId: string | null, calls: readonly OfficeCall[]): OfficeRoof {
  type Latest = { task: string; recordId: string; at: number } | null;
  const newer = (a: Latest, b: Latest): Latest => (a === null || (b !== null && b.at > a.at) ? b : a);
  const counts = { device: 0, cloud: 0, fellBack: 0, unknown: 0, violation: 0 };
  let devSeen: Latest = null; let cloudSeen: Latest = null; let fell: Latest = null; let devBad: Latest = null; let cloudBad: Latest = null;
  for (const t of Object.values(snapshot.tasks)) {
    const r = runId !== null && t.runId === runId ? t.route?.lastObserved : null;
    if (!r) continue;
    const item = { task: t.title ?? t.taskId, recordId: r.recordId, at: Date.parse(r.reportedAt) };
    if (isRouteViolation(r)) {
      counts.violation += 1;
      if (r.observedSource === 'ON_DEVICE') devBad = newer(devBad, item);
      else if (r.observedSource === 'IN_CLOUD') cloudBad = newer(cloudBad, item);
      continue;
    }
    if (r.status !== 'ok') continue;
    if (r.observedSource === 'UNKNOWN') { counts.unknown += 1; continue; }
    if (r.fellBack === true && r.conformance === 'conforms') { counts.fellBack += 1; fell = newer(fell, item); }
    else if (r.observedSource === 'ON_DEVICE') counts.device += 1;
    else counts.cloud += 1;
    if (r.observedSource === 'ON_DEVICE') devSeen = newer(devSeen, item);
    else cloudSeen = newer(cloudSeen, item);
  }
  const title = (taskId: string): string => short(snapshot.tasks[taskId]?.title ?? taskId);
  const flying = (place: 'device' | 'cloud') => calls.filter((c) => c.place === place).map((c) => title(c.taskId));
  const locked = calls.some((c) => c.place === 'device' && (snapshot.tasks[c.taskId]?.route?.lock ?? null) !== null);
  const strip = (x: Latest) => (x === null ? null : { task: x.task, recordId: x.recordId });
  const device: RoofBox = { place: 'device', count: counts.device, expected: flying('device'), observed: strip(devSeen), violation: strip(devBad), locked };
  const cloud: RoofBox = { place: 'cloud', count: counts.cloud, expected: flying('cloud'), observed: strip(cloudSeen), violation: strip(cloudBad), locked: false };
  const plural = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
  let summary = `Roof: ${plural(counts.device)} on this device, ${counts.cloud} in the cloud, ${counts.fellBack} fell back.`;
  if (counts.unknown > 0) summary += ` ${counts.unknown} ran somewhere not shown.`;
  if (counts.violation > 0) summary += ` ${counts.violation} route violation${counts.violation === 1 ? '' : 's'}, discarded.`;
  if (device.expected.length + cloud.expected.length > 0) {
    const parts: string[] = [];
    if (device.expected.length > 0) parts.push(`${device.expected.length} expected on this device${locked ? ' (restricted, locked to this device)' : ''}`);
    if (cloud.expected.length > 0) parts.push(`${cloud.expected.length} expected in the cloud`);
    summary += ` In flight: ${parts.join(', ')}.`;
  }
  return { device, cloud, fellBack: strip(fell), fellBackCount: counts.fellBack, summary };
}
