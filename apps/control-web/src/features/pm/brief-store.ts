import type { SdkGrounding } from '@selarikru/inference-firebase-web';
import { create } from 'zustand';
import type { AiCheckpoint } from '@selarikru/domain';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import { stopReasonFor } from '@selarikru/domain';
import { STOP_TEXT } from '../checkpoints/model.ts';
import { cloudRefusal, latestBrief, screenCheck, type BriefCheck, type BriefDraft } from './brief.ts';
import { pmRefusal } from './copy.ts';
import type { PmOutcome } from './runner.ts';
import type { BriefCheckKind } from './runner.ts';

/**
 * H13: the plan brief in this tab, per run: the notes as typed, the reviewed brief and the cloud check's result. The notes are also kept as a checkpoint (on this
 * device, and on the server when they may be); the reviewed brief and its approval live in this tab only, so a reload un-approves it and a paused check is
 * never sent with a brief nobody approved.
 */
export type FormatState =
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly simulated: boolean; readonly locked: boolean }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly message: string };
export type CheckState =
  | { readonly kind: BriefCheckKind; readonly status: 'running' }
  | { readonly kind: BriefCheckKind; readonly status: 'done'; readonly result: BriefCheck; readonly grounding: SdkGrounding | null; readonly briefSha256: string; readonly simulated: boolean; readonly resumed: boolean }
  | { readonly kind: BriefCheckKind; readonly status: 'paused'; readonly reason: string }
  | { readonly kind: BriefCheckKind; readonly status: 'failed'; readonly message: string };

export interface RunBrief {
  readonly points: string;
  readonly unsure: string;
  /** The owner marked the notes restricted. */
  readonly marked: boolean;
  /** A restricted turn (or restricted notes read back) is in them. */
  readonly restrictedTurns: boolean;
  readonly draft: BriefDraft | null;
  readonly format: FormatState | null;
  readonly check: CheckState | null;
}
export const EMPTY_RUN_BRIEF: RunBrief = { points: '', unsure: '', marked: false, restrictedTurns: false, draft: null, format: null, check: null };

interface BriefStore {
  /** By `briefKey(runId, taskId)`. */
  readonly runs: Readonly<Record<string, RunBrief>>;
  set(key: string, fn: (r: RunBrief) => Partial<RunBrief>): void;
}
export const pmBrief = create<BriefStore>((set) => ({
  runs: {},
  set: (key, fn) => set((s) => { const cur = s.runs[key] ?? EMPTY_RUN_BRIEF; return { runs: { ...s.runs, [key]: { ...cur, ...fn(cur) } } }; }),
}));

/** H13 fix round 1 (H3): one entry per run and subject task, as the notes checkpoint is: notes never follow the subject select to another task. */
export const briefKey = (runId: string, taskId: string): string => `${runId}\u0000${taskId}`;

/**
 * The approved brief's hash for a run and subject task (fix round 1, M3), or null: none approved now (edited since approval, or restricted). This tab's draft
 * decides when there is one; otherwise the kept reviewed brief does (fix round 1, I3), so an approval survives a reload.
 */
export function approvedBriefSha(runId: string, taskId: string, kept?: Readonly<Record<string, AiCheckpoint>>, snap?: ProjectViewSnapshot | null): string | null {
  const d = pmBrief.getState().runs[briefKey(runId, taskId)]?.draft ?? (kept ? latestBrief(kept, snap ?? null, runId, taskId) : null);
  return d && cloudRefusal(d) === null ? d.approvedSha256 : null;
}

/**
 * H13 fix round 1 (M2): what the panel shows after a paused check was sent again. A refusal shows as failed with its reason; a call that paused again as
 * paused; an ok one as done, and only while the brief it checked is still the one approved (`sha`).
 */
export function checkStateAfterResume(kind: BriefCheckKind, out: PmOutcome & { readonly simulated?: boolean }, sha: string | null): CheckState {
  if (out.kind === 'refused') return { kind, status: 'failed', message: pmRefusal(out.code) };
  const p = out.result.proposal;
  if (p.status === 'ok') {
    if (!sha) return { kind, status: 'failed', message: 'The brief changed after it was approved, so this check is not shown. Approve it and check it again.' };
    return { kind, status: 'done', result: screenCheck(kind, p.data, out.result.grounding ?? null), grounding: out.result.grounding ?? null, briefSha256: sha, simulated: out.simulated === true, resumed: true };
  }
  const stop = stopReasonFor(p.blockedReason);
  if (stop) return { kind, status: 'paused', reason: STOP_TEXT[stop] };
  return { kind, status: 'failed', message: pmRefusal(p.blockedReason ?? p.status) };
}
