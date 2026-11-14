import type { SdkGrounding } from '@selarikru/inference-firebase-web';
import { create } from 'zustand';
import { cloudRefusal, type BriefCheck, type BriefDraft } from './brief.ts';
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
  readonly runs: Readonly<Record<string, RunBrief>>;
  set(runId: string, fn: (r: RunBrief) => Partial<RunBrief>): void;
}
export const pmBrief = create<BriefStore>((set) => ({
  runs: {},
  set: (runId, fn) => set((s) => { const cur = s.runs[runId] ?? EMPTY_RUN_BRIEF; return { runs: { ...s.runs, [runId]: { ...cur, ...fn(cur) } } }; }),
}));

/** The approved brief's hash for a run, or null: none approved now (edited since approval, restricted, or this tab was reloaded). */
export function approvedBriefSha(runId: string): string | null {
  const d = pmBrief.getState().runs[runId]?.draft ?? null;
  return d && cloudRefusal(d) === null ? d.approvedSha256 : null;
}
