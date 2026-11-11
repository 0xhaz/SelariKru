// What happened between two office worlds in a row (H7 fix), and the walk and effect each happening gets. SelariKru's own.
//
// Walking and effects are decoration, but every one follows a real change in the snapshot (or, for a cloud call, a call this browser really has in
// flight). Nothing is invented: no message, walk or burst appears without its event.

import type { ErrandStep } from './actors/errands.ts';
import type { OfficeWorld } from './model.ts';

export type OfficeEvent =
  /** An attempt started for the worker's task: it fetches the plan, then sits down. */
  | { readonly kind: 'claimed'; readonly agentId: string }
  /** The worker's task has a new revision (a replan). */
  | { readonly kind: 'replanned'; readonly agentId: string }
  /** A cloud AI call for its task is in flight; it ends when the record lands. */
  | { readonly kind: 'cloudCallStarted'; readonly agentId: string }
  | { readonly kind: 'cloudCallEnded'; readonly agentId: string }
  /** A device AI call for its task is in flight (round 4: the robot waits at the roof's device box). */
  | { readonly kind: 'deviceCallStarted'; readonly agentId: string }
  | { readonly kind: 'deviceCallEnded'; readonly agentId: string }
  /** A new conforming record says the call fell back from this device to the cloud. */
  | { readonly kind: 'fellBackToCloud'; readonly agentId: string }
  /** The worker's attempt ended well: its change set is published. */
  | { readonly kind: 'published'; readonly agentId: string }
  | { readonly kind: 'prOpened'; readonly agentIds: readonly string[]; readonly num: number }
  | { readonly kind: 'prMerged'; readonly agentIds: readonly string[]; readonly num: number }
  /** The worker now needs a person. */
  | { readonly kind: 'needsYou'; readonly agentId: string }
  /** A person answered an approval for the worker's task. */
  | { readonly kind: 'answered'; readonly agentId: string }
  /** A candidate passed verification. */
  | { readonly kind: 'verified'; readonly parcelId: string }
  /** The record says a candidate failed verification or was rejected: it goes back to the run's PLAN table. */
  | { readonly kind: 'changes'; readonly parcelId: string; readonly label: string; readonly agentIds: readonly string[] };

export function officeEvents(prev: OfficeWorld | null, next: OfficeWorld): OfficeEvent[] {
  // A new epoch (another project, a new demo session, a loop that wrapped) is a fresh start, never a change: nothing is dispatched.
  if (prev === null || prev.epoch !== next.epoch) return [];
  const out: OfficeEvent[] = [];
  const before = new Map(prev.cues.map((c) => [c.agentId, c]));
  for (const c of next.cues) {
    const b = before.get(c.agentId);
    if (!b) continue;
    const id = c.agentId;
    if (c.attemptId !== null && c.attemptRunning && c.attemptId !== b.attemptId) out.push({ kind: 'claimed', agentId: id });
    else if (c.taskId !== null && c.taskId === b.taskId && c.taskRevision !== null && b.taskRevision !== null && c.taskRevision > b.taskRevision) out.push({ kind: 'replanned', agentId: id });
    if (c.attemptId !== null && c.attemptId === b.attemptId && b.attemptRunning && !c.attemptRunning && c.attemptOutcome === 'succeeded') out.push({ kind: 'published', agentId: id });
    if (c.cloudCall && !b.cloudCall) out.push({ kind: 'cloudCallStarted', agentId: id });
    if (!c.cloudCall && b.cloudCall) out.push({ kind: 'cloudCallEnded', agentId: id });
    if (c.deviceCall && !b.deviceCall) out.push({ kind: 'deviceCallStarted', agentId: id });
    if (!c.deviceCall && b.deviceCall) out.push({ kind: 'deviceCallEnded', agentId: id });
    if (c.recordId !== null && c.recordId !== b.recordId && c.fellBackToCloud) out.push({ kind: 'fellBackToCloud', agentId: id });
    if (c.needsYou && !b.needsYou) out.push({ kind: 'needsYou', agentId: id });
  }
  const answered = new Set(prev.resolvedApprovals.map((a) => a.approvalId));
  for (const a of next.resolvedApprovals) {
    if (answered.has(a.approvalId) || a.taskId === null) continue;
    for (const c of next.cues) if (c.taskId === a.taskId) out.push({ kind: 'answered', agentId: c.agentId });
  }
  const onRun = (runId: string): string[] => next.cues.filter((c) => c.runId === runId).map((c) => c.agentId);
  const oldPrs = new Map(prev.prs.map((p) => [p.num, p]));
  for (const pr of next.prs) {
    const was = oldPrs.get(pr.num);
    if (!was) out.push({ kind: 'prOpened', agentIds: onRun(pr.runId), num: pr.num });
    else if (pr.merged && !was.merged) out.push({ kind: 'prMerged', agentIds: onRun(pr.runId), num: pr.num });
  }
  const nowParcels = new Map(next.parcels.map((p) => [p.id, p]));
  for (const p of prev.parcels) {
    const now = nowParcels.get(p.id);
    if (now && p.stage === 'to_gate' && now.stage === 'verified') out.push({ kind: 'verified', parcelId: p.id });
  }
  // CHANGES only from the record: a failed verification on a live candidate, or a rejected one. A candidate that was replaced, or evidence that went
  // away, retires its parcel quietly.
  const judged = new Map(prev.verdicts.map((v) => [v.id, v.outcome]));
  for (const v of next.verdicts) {
    const was = judged.get(v.id);
    if (was === undefined || was === v.outcome) continue;
    if ((v.outcome === 'failed' || v.outcome === 'rejected') && was !== 'failed' && was !== 'rejected') out.push({ kind: 'changes', parcelId: v.id, label: v.label, agentIds: onRun(v.id.split(':')[0]!) });
  }
  return out;
}

/** The walk an event sends a robot on. Events with no walk return no steps. */
export function errandFor(e: OfficeEvent): ErrandStep[] {
  switch (e.kind) {
    case 'claimed':
    case 'replanned': return [{ to: 'plan', linger: 1.2, emote: 'talk' }, { to: 'seat' }];
    case 'cloudCallStarted': return [{ to: 'roofCloud', hold: 'call' }];
    case 'deviceCallStarted': return [{ to: 'roofDevice', hold: 'call' }];
    case 'fellBackToCloud': return [{ to: 'roofDevice', linger: 1 }, { to: 'roofCloud', linger: 2 }, { to: 'seat' }];
    case 'published': return [{ to: 'drop', carry: true, linger: 0.6, emote: 'ok' }, { to: 'seat' }];
    case 'prOpened': return [{ to: 'prs', linger: 1.5 }, { to: 'seat' }];
    case 'prMerged': return [{ to: 'here', emote: 'heart', linger: 2 }];
    case 'needsYou': return [{ to: 'seat', emote: 'talk' }];
    case 'answered': return [{ to: 'here', emote: 'mail', linger: 2 }];
    default: return [];
  }
}

export type EffectPoint = 'plan' | 'actions' | 'gate' | { readonly agent: string };

export type OfficeEffect =
  | { readonly kind: 'envelope'; readonly from: EffectPoint; readonly to: EffectPoint }
  | { readonly kind: 'burst'; readonly at: 'gate' }
  | { readonly kind: 'text'; readonly at: 'gate'; readonly text: string; readonly tone: 'pass' | 'fail' }
  | { readonly kind: 'gate'; readonly look: 'changes' }
  | { readonly kind: 'flyBack'; readonly label: string; readonly to: EffectPoint };

/** The effects an event shows. Under reduced motion the scene shows only their end state (no flight, no burst). */
export function effectsFor(e: OfficeEvent): OfficeEffect[] {
  switch (e.kind) {
    case 'needsYou': return [{ kind: 'envelope', from: { agent: e.agentId }, to: 'actions' }];
    case 'answered': return [{ kind: 'envelope', from: 'plan', to: { agent: e.agentId } }];
    case 'verified': return [{ kind: 'burst', at: 'gate' }, { kind: 'text', at: 'gate', text: 'VERIFIED', tone: 'pass' }];
    case 'changes': return [
      // The candidate belongs to the run, not one worker, so it flies back to the PLAN table.
      { kind: 'text', at: 'gate', text: 'CHANGES', tone: 'fail' }, { kind: 'gate', look: 'changes' }, { kind: 'flyBack', label: e.label, to: 'plan' },
    ];
    default: return [];
  }
}
