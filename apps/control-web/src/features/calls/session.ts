import { ROUTE_POLICY_LABELS } from '@selarikru/domain';
import type { TelemetryEvent } from '@selarikru/inference-firebase-web';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AiCallRow } from './model.ts';

/**
 * H9 fix round 1 (I1): the AI calls in this tab that are not task steps (the Assistant, the onboarding guide), from the adapter's own telemetry: the requested
 * mode and the observed source it already has. Kept in this tab only, in memory; nothing new goes to the server. Task steps (the agents, the PM) are listed
 * from their route records instead, so they are not kept here.
 */
export interface SessionCall {
  readonly at: string;
  readonly event: TelemetryEvent;
}

export interface SessionCallsState {
  readonly calls: readonly SessionCall[];
  add(e: TelemetryEvent): void;
}

const MAX = 200;

export function createSessionCalls(now: () => Date = () => new Date()): StoreApi<SessionCallsState> {
  return createStore<SessionCallsState>()((set) => ({
    calls: [],
    add: (e) => { if (!e.routed) set((s) => ({ calls: [...s.calls, { at: now().toISOString(), event: e }].slice(-MAX) })); },
  }));
}

/** This tab's log. */
export const sessionCalls = createSessionCalls();

const STEP: Readonly<Record<string, string>> = { draftBrief: 'Draft brief', suggestCriteria: 'Suggest criteria', draftTaskPlan: 'Draft task plan' };
const HIDDEN = 'Not shown (restricted)';
const CHECK: Readonly<Record<string, string>> = { passed: 'Passed', failed: 'Failed', not_run: 'Not run', needs_review: 'Needs review' };

export function sessionCallRows(calls: readonly SessionCall[]): AiCallRow[] {
  return [...calls].reverse().map(({ at, event: e }): AiCallRow => {
    const stopped = e.status === 'blocked' || e.status === 'error';
    const ran: AiCallRow['ran'] = stopped ? 'Did not run' : e.observedSource === 'ON_DEVICE' ? 'On this device' : e.observedSource === 'IN_CLOUD' ? 'Cloud' : 'Unknown';
    const how = stopped ? `Stopped before running${e.blockedReason ? `: ${e.blockedReason.replace(/_/g, ' ')}` : ''}` : ran === 'Unknown' ? 'Unknown' : 'As routed';
    return {
      id: `session:${e.requestId}`, taskId: '', task: 'Not a task step', taskHref: null, step: STEP[e.operation] ?? e.operation, at,
      requested: e.requestedMode ? `${ROUTE_POLICY_LABELS[e.requestedMode]} (${e.requestedMode})` : 'Not set', requestedSource: 'This tab only',
      ran, ranTone: ran === 'On this device' ? 'success' : ran === 'Cloud' ? 'active' : ran === 'Unknown' ? 'warning' : 'neutral',
      how: e.restricted ? HIDDEN : how, timing: e.restricted ? HIDDEN : (e.totalMs < 1000 ? `${Math.round(e.totalMs)} ms` : `${(e.totalMs / 1000).toFixed(1)} s`),
      check: e.restricted ? HIDDEN : CHECK[e.validationStatus] ?? e.validationStatus, lock: 'None', labels: e.restricted ? 'restricted' : 'Not reported', model: null, restricted: e.restricted,
    };
  });
}
