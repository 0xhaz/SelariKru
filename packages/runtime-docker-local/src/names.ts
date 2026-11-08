import { createHash } from 'node:crypto';

const h8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Every sandbox this runtime creates matches this. Nothing else is ever touched. */
export const OUR_SANDBOX = /^selarikru-t([0-9a-f]{8})-a([0-9a-f]{8})$/;

/** Stable and derived from identity, so a replacement attempt can find (and reconcile) the old worker by task. */
export function sandboxName(taskId: string, attemptId: string): string {
  return `selarikru-t${h8(taskId)}-a${h8(attemptId)}`;
}

export function taskPrefix(taskId: string): string {
  return `selarikru-t${h8(taskId)}-`;
}

export const isOurSandbox = (name: string): boolean => OUR_SANDBOX.test(name);
