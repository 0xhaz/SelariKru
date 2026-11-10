import { createHash } from 'node:crypto';

const h8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

/**
 * Sandbox names carry their owner's scope: a short stable hash of the owner identity (for a runner, its tenant and
 * runner id; for a benchmark trial, the trial's own scope). Sweeps and reconciliation list and remove only sandboxes in
 * their own scope, so two runners on one machine, or a benchmark trial and the owner's live runner, never remove each
 * other's sandboxes.
 */
export const OUR_SANDBOX = /^selarikru-s([0-9a-f]{8})-t([0-9a-f]{8})-a([0-9a-f]{8})$/;

/** Names from before scopes existed. Still ours to stop or remove when named, but never swept automatically: their owner is unknown. */
export const LEGACY_SANDBOX = /^selarikru-t([0-9a-f]{8})-a([0-9a-f]{8})$/;

/** The 8-hex scope of an owner identity such as `tenant:runner`. */
export function scopeId(owner: string): string {
  if (owner.trim() === '') throw new Error('a sandbox scope needs a non-empty owner identity');
  return h8(owner);
}

/** Stable and derived from identity, so a replacement attempt can find (and reconcile) the old worker by task, within its owner's scope. */
export function sandboxName(owner: string, taskId: string, attemptId: string): string {
  return `selarikru-s${scopeId(owner)}-t${h8(taskId)}-a${h8(attemptId)}`;
}

export function taskPrefix(owner: string, taskId: string): string {
  return `selarikru-s${scopeId(owner)}-t${h8(taskId)}-`;
}

/** Managed by some selarikru scope (or a legacy name): what the command guard allows a verb on. */
export const isOurSandbox = (name: string): boolean => OUR_SANDBOX.test(name) || LEGACY_SANDBOX.test(name);
export const isLegacySandbox = (name: string): boolean => LEGACY_SANDBOX.test(name);
/** In exactly this owner's scope. */
export const inScope = (name: string, owner: string): boolean => OUR_SANDBOX.exec(name)?.[1] === scopeId(owner);
