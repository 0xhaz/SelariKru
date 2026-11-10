import { sha256Hex } from './sha256.ts';

/**
 * Checkpoint continuation (docs/architecture.md §4): unfinished local work continues on a cloud-location runner from an explicit, persisted checkpoint, the approved base
 * SHA plus the attempt's own change set against it, every file hashed. A checkpoint is untrusted input: the control plane checks it against these rules before it is stored,
 * and the successor checks every hash again before its worker starts. It is never a copy of a home directory, model memory, sandbox state or an environment file.
 *
 * "Cloud runner" here means an enrolled runner whose location is `cloud`. Hosted cloud infrastructure is a later task (T7.3).
 */

/** What one checkpoint may carry. Larger work is not resumed: the owner is offered a restart from the persisted input instead. */
export const CHECKPOINT_LIMITS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxExclusions: 500, maxDiffChars: 6 * 1024 * 1024, maxDiffLines: 20_000 } as const;

/** One file's review diff against the base: every line of both sides, each marked kept (' '), added ('+') or removed ('-'). Null lines: binary, or too large to show. */
export interface CheckpointDiff {
  readonly binary: boolean;
  readonly lines: readonly (readonly [' ' | '+' | '-', string])[] | null;
  readonly added: number;
  readonly removed: number;
}

/** The text a diff says the file becomes: its kept and added lines. */
export const diffPostImage = (lines: readonly (readonly [string, string])[]): string => lines.filter(([op]) => op !== '-').map(([, t]) => t).join('\n');

/** Why a path was left out of a checkpoint. Path and reason only: an excluded file's content never leaves the machine. */
export const EXCLUSION_REASONS = ['secret_file_name', 'secret_content', 'outside_allowed_paths', 'not_a_regular_file', 'reserved_path', 'too_large'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** Names that carry credentials by convention. Matched on the file name, case-insensitively, wherever the file sits. */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(?:\..*)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^\.?(?:npmrc|netrc|pgpass|htpasswd|git-credentials|pypirc|dockercfg)$/i,
  /^credentials?(?:\.[a-z0-9]+)?$/i,
  /^secrets?(?:\.[a-z0-9]+)?$/i,
  /service[-_]?account.*\.json$/i,
  /^.*[-_.]credentials?\.(?:json|ya?ml|toml|ini|txt)$/i,
];
/** Directories that only ever hold credentials. */
const SECRET_DIRS = new Set(['.aws', '.ssh', '.gnupg', '.docker', '.kube']);

/** `secret_file_name` when a path's name or a directory on it holds credentials by convention, else null. */
export function secretFileReason(path: string): 'secret_file_name' | null {
  const segs = path.split('/');
  const name = segs.at(-1) ?? '';
  if (segs.slice(0, -1).some((s) => SECRET_DIRS.has(s.toLowerCase()))) return 'secret_file_name';
  return SECRET_NAMES.some((re) => re.test(name)) ? 'secret_file_name' : null;
}

/** Whether a path is inside the task's allowed paths: whole path segments, as the completion gate matches them. */
export const insideAllowedPaths = (path: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => {
    const n = a.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    return n !== '' && (path === n || path.startsWith(`${n}/`));
  });

/** One file of a checkpoint as the record keeps it: path, change, post-image hash and size. Content is held apart and never shown. */
export interface CheckpointFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  /** sha256 of the file's bytes after the change. Null for a deletion. */
  readonly sha256: string | null;
  readonly size: number | null;
  readonly executable: boolean;
}

export interface CheckpointExclusion {
  readonly path: string;
  readonly reason: ExclusionReason;
}

/**
 * The checkpoint's patch hash: sha256 over the base SHA and every file's path, change, post-image hash and mode, in path order. Both sides compute it from the same fields, so a
 * file added, dropped, reordered or changed by one byte gives another hash.
 */
export function checkpointDigest(baseSha: string, files: readonly Pick<CheckpointFile, 'path' | 'status' | 'sha256' | 'executable'>[]): string {
  const rows = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.status, f.sha256, f.executable]);
  return sha256Hex(JSON.stringify({ schema: 1, baseSha, files: rows }));
}

/** Why a checkpoint cannot be resumed. Each one offers a restart from the persisted input instead; none is ever a silent drop. */
export const CHECKPOINT_REFUSALS = [
  'no_checkpoint', 'empty_checkpoint', 'base_mismatch', 'too_many_files', 'file_too_large', 'checkpoint_too_large', 'path_invalid', 'path_outside_allowed_paths',
  'secret_file_included', 'secret_content_included', 'file_hash_mismatch', 'patch_hash_mismatch', 'required_file_excluded', 'not_a_regular_file', 'restricted_work',
  'checkpoint_tampered', 'checkpoint_apply_failed', 'duplicate_path', 'invalid_checkpoint',
  // A fenced handover that can no longer run where it was sent, or a successor that was lost.
  'no_cloud_runner', 'cloud_not_allowed', 'budget_insufficient', 'placement_blocked', 'successor_lost', 'successor_failed',
  'diff_mismatch',
] as const;
export type CheckpointRefusal = (typeof CHECKPOINT_REFUSALS)[number];

/**
 * Where a handover stands. `stopping`: the owner asked, the prior attempt was told to stop and checkpoint. `awaiting_review`: the prior attempt ended (its lease is revoked and the
 * next fence reserved) and its checked checkpoint waits for the owner's review. `fenced`: released (or a restart chosen); a runner at the target location may now claim.
 * `starting`: a successor holds the lease and is setting up. `running`: its worker started. `restart_offered`: a safe resume is not possible, and a restart from the persisted input
 * waits for the owner. `declined`: the owner kept the task where policy places it. `closed`: superseded, cancelled, or the successor ended.
 */
export const HANDOVER_STATES = ['stopping', 'awaiting_review', 'fenced', 'starting', 'running', 'restart_offered', 'declined', 'closed'] as const;
export type HandoverState = (typeof HANDOVER_STATES)[number];
/** States that hold the task: a claim honours the handover while one of these stands, and only one per task may stand at a time. */
export const OPEN_HANDOVER_STATES: readonly HandoverState[] = ['stopping', 'awaiting_review', 'fenced', 'starting', 'running', 'restart_offered'];

/** How many times a lost successor (lease expiry or a failed setup) is offered again to the target location before the owner is asked instead. */
export const SUCCESSOR_RETRY_LIMIT = 2;

/** `resume`: from the base SHA with the checkpoint applied. `restart`: from the persisted input only (the base SHA and the task), the prior attempt's work not carried. */
export type HandoverMode = 'resume' | 'restart';

/** What the cancel request carries for a handover stop. The attempt ends interrupted, spending no repair, and the task waits for the successor. */
export const HANDOVER_STOP_PREFIX = 'handover:';
export const isHandoverReason = (reason: string | null | undefined): boolean => typeof reason === 'string' && reason.startsWith(HANDOVER_STOP_PREFIX);

/** Why a task cannot continue in cloud. Shown as written; each is a fact about policy, data, budget or capacity, never a guess. */
export const HANDOVER_INELIGIBLE = [
  'task_not_running', 'attempt_not_local', 'restricted_work', 'cloud_not_allowed', 'no_cloud_destination', 'budget_insufficient', 'no_cloud_runner', 'handover_open',
  'cancel_pending', 'trial_run', 'policy_denied',
] as const;
export type HandoverIneligible = (typeof HANDOVER_INELIGIBLE)[number];

/** Owner-facing words for each state. "Cloud runner" is an enrolled runner whose location is cloud. */
export const HANDOVER_STATE_LABEL: Readonly<Record<HandoverState, string>> = {
  stopping: 'Stopping local attempt',
  awaiting_review: 'Checkpoint ready for review',
  fenced: 'Fenced',
  starting: 'Cloud attempt starting',
  running: 'Running',
  restart_offered: 'Restart offered',
  declined: 'Kept where it is',
  closed: 'Closed',
};

export const HANDOVER_REASON_TEXT: Readonly<Record<string, string>> = {
  task_not_running: 'The task has no running attempt to continue.',
  attempt_not_local: 'The running attempt is not on a local runner.',
  restricted_work: 'Restricted or secret work stays on this device. It cannot continue in cloud.',
  cloud_not_allowed: 'This run\'s placement does not allow cloud execution.',
  no_cloud_destination: 'No cloud execution destination is configured for this run.',
  budget_insufficient: 'The run\'s remaining budget cannot reserve the cloud attempt\'s cost.',
  no_cloud_runner: 'No enrolled cloud runner that can run this task\'s model has checked in recently.',
  handover_open: 'A handover for this task is already in progress.',
  cancel_pending: 'A cancel or stop is already open for this task.',
  trial_run: 'Benchmark trial runs are not moved between locations.',
  policy_denied: 'Policy denies a cloud start for this task.',
  no_checkpoint: 'The local attempt ended without sending a checkpoint.',
  empty_checkpoint: 'The local attempt had no changes to carry.',
  base_mismatch: 'The checkpoint was not made against the approved base commit.',
  too_many_files: `The checkpoint has more than ${CHECKPOINT_LIMITS.maxFiles} files.`,
  file_too_large: `A file in the checkpoint is larger than ${CHECKPOINT_LIMITS.maxFileBytes / 1024} KiB.`,
  checkpoint_too_large: `The checkpoint is larger than ${CHECKPOINT_LIMITS.maxTotalBytes / (1024 * 1024)} MiB.`,
  path_invalid: 'The checkpoint names a path that is not a plain repository path.',
  path_outside_allowed_paths: 'The checkpoint carries a file outside the task\'s allowed paths.',
  secret_file_included: 'The checkpoint carried a secret-bearing file. It was refused, not stored.',
  secret_content_included: 'The checkpoint carried secret-shaped content. It was refused, not stored.',
  file_hash_mismatch: 'A file in the checkpoint does not match its hash.',
  patch_hash_mismatch: 'The checkpoint does not match its patch hash.',
  required_file_excluded: 'A file the task changed inside its allowed paths had to be excluded (secret-bearing), so the work cannot be carried whole.',
  not_a_regular_file: 'The checkpoint carries a link or special file.',
  checkpoint_tampered: 'The stored checkpoint no longer matches its recorded hashes. Nothing was started from it.',
  checkpoint_apply_failed: 'The cloud runner could not apply the checkpoint to the base commit.',
  duplicate_path: 'The checkpoint names the same path twice.',
  invalid_checkpoint: 'The checkpoint could not be read.',
  diff_mismatch: 'A file\'s review diff does not produce the file it was sent with.',
  placement_blocked: 'The cloud placement now refuses this task for good.',
  successor_lost: 'The cloud attempt was lost after its worker started, and its copy of the checkpoint was already dropped.',
  successor_failed: `The cloud attempt could not start ${SUCCESSOR_RETRY_LIMIT + 1} times.`,
};

/** Why a handover was closed or its checkpoint content dropped. Codes only. */
export const HANDOVER_CLOSE_TEXT: Readonly<Record<string, string>> = {
  replanned: 'The plan moved the task to a new revision.',
  run_cancelled: 'The run was cancelled.',
  task_cancelled: 'The task was cancelled.',
  stale_revision: 'The task is on another revision now.',
  declined: 'The owner kept the task where policy places it.',
  restart_chosen: 'The owner chose a restart from the persisted input.',
  successor_running: 'The cloud attempt has its own copy now.',
  successor_completed: 'The cloud attempt completed.',
  successor_failed: 'The cloud attempt failed.',
  successor_ended: 'The cloud attempt ended.',
};
