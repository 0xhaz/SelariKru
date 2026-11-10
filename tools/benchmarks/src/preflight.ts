import { isFrozen, type Manifest, type StartRecord } from './manifest.ts';

/**
 * Preflight: a checklist over a manifest and a few files, deciding whether each track may dispatch live. It reads
 * what it is given and nothing else: no run starts, no model is called, nothing is spent and no connection opens.
 * The API key is checked by presence only; its value never enters the result.
 */

export type Track = 'workers' | 'assistant';
export type CheckStatus = 'pass' | 'warn' | 'block';

export interface Check {
  readonly id: 'required_fields' | 'budget_authority' | 'api_key' | 'verifier_host' | 'lockfile_frozen' | 'seed_and_order' | 'modes';
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly tracks: readonly Track[];
}

export interface Decision {
  readonly allowed: boolean;
  /** Named reasons. Empty exactly when `allowed`. */
  readonly blockers: readonly string[];
}

export interface ModeLine {
  readonly id: string;
  readonly track: Track;
  readonly required: boolean;
  readonly supported: boolean;
  /** An unsupported mode is listed as Not measured with its reason, never hidden. */
  readonly status: 'Planned' | 'Not measured';
  readonly reason: string | null;
}

export interface PreflightReport {
  readonly liveDispatch: Readonly<Record<Track, Decision>>;
  readonly checks: readonly Check[];
  readonly modes: readonly ModeLine[];
}

export interface PreflightInput {
  readonly manifest: Manifest;
  /** Only presence of `manifest.credentials.apiKeyEnv` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** From services/verifier/suites/feedback-board/HASHES.json, or null when it could not be read. */
  readonly verifierHashes: { readonly verifierSha256: string; readonly lockfileSha256: string } | null;
  /** sha-256 of the current pnpm-lock.yaml, or null when it could not be read. */
  readonly lockfileSha256Now: string | null;
  /** The start record, once a cohort has started. */
  readonly start: StartRecord | null;
}

type Field = readonly [path: string, resolved: (m: Manifest) => boolean];
const set = (v: unknown): boolean => v !== null && v !== undefined;

const COMMON: readonly Field[] = [
  ['cohortId', (m) => set(m.cohortId)],
  ['repository.url', (m) => set(m.repository.url)],
  ['repository.starterSha', (m) => set(m.repository.starterSha)],
  ['repository.lockfileSha256', (m) => set(m.repository.lockfileSha256)],
  ['repository.verifierSha256', (m) => set(m.repository.verifierSha256)],
  ['proposedVariableBudgetUsd.payer', (m) => set(m.proposedVariableBudgetUsd.payer)],
  ['proposedVariableBudgetUsd.authorizedBy', (m) => set(m.proposedVariableBudgetUsd.authorizedBy)],
];

const cloudModeSupported = (m: Manifest): boolean => m.workers.requiredModes.some((r) => r.availability === 'supported' && r.cloudCodingSlots > 0);

const WORKERS: readonly Field[] = [
  ['repository.contractSha256', (m) => set(m.repository.contractSha256)],
  ['repository.verifierSha', (m) => set(m.repository.verifierSha)],
  ...(['harness', 'harnessVersion', 'codingModel', 'inferenceProvider', 'modelSettings', 'accountTier', 'priceReference', 'localHost', 'verificationEnvironment'] as const).map((k): Field => [`environment.${k}`, (m) => set(m.environment[k])]),
  // Cloud execution identity is required only once a cloud mode is planned to run.
  ['environment.cloudBackend', (m) => !cloudModeSupported(m) || set(m.environment.cloudBackend)],
  ['environment.imageDigest', (m) => !cloudModeSupported(m) || set(m.environment.imageDigest)],
  ['environment.cpuRamLimitsVerified', (m) => m.environment.cpuRamLimitsVerified],
  ['environment.verifierHostFrozen', (m) => m.environment.verifierHostFrozen],
  ['workers.repairPolicy', (m) => set(m.workers.repairPolicy)],
];

const ASSISTANT: readonly Field[] = [
  ...(['sdkVersion', 'browserVersion', 'origin', 'cloudModel', 'deviceModel'] as const).map((k): Field => [`assistant.${k}`, (m) => set(m.assistant[k])]),
  ['assistant.appCheckReadiness', (m) => m.assistant.appCheckReadiness === 'verified'],
];

const unresolved = (m: Manifest, fields: readonly Field[]): string[] => fields.filter(([, ok]) => !ok(m)).map(([path]) => path);

export function preflight(input: PreflightInput): PreflightReport {
  const { manifest: m } = input;
  const blockers: Record<Track, string[]> = { workers: [], assistant: [] };
  const checks: Check[] = [];
  const add = (check: Check, reasons: readonly string[]): void => {
    checks.push(check);
    if (check.status === 'block') for (const t of check.tracks) blockers[t].push(...reasons);
  };

  // Required fields, per track.
  const common = unresolved(m, COMMON);
  const perTrack: Record<Track, string[]> = { workers: [...common, ...unresolved(m, WORKERS)], assistant: [...common, ...unresolved(m, ASSISTANT)] };
  for (const t of ['workers', 'assistant'] as const) blockers[t].push(...perTrack[t].map((p) => `unresolved: ${p}`));
  const anyUnresolved = perTrack.workers.length + perTrack.assistant.length > 0;
  checks.push({ id: 'required_fields', label: 'Required fields resolved', status: anyUnresolved ? 'block' : 'pass', tracks: ['workers', 'assistant'], detail: anyUnresolved ? `Workers: ${perTrack.workers.length} unresolved. Assistant: ${perTrack.assistant.length} unresolved.` : 'Every required field is resolved.' });

  // D4: spend authority.
  const budget = m.proposedVariableBudgetUsd;
  const authorized = budget.status === 'authorized' && budget.payer !== null && budget.authorizedBy !== null;
  add({ id: 'budget_authority', label: 'Budget authority (D4)', status: authorized ? 'pass' : 'block', tracks: ['workers', 'assistant'], detail: authorized ? `$${budget.total} variable cap authorized; payer recorded.` : `The $${budget.total} variable cap is ${budget.status === 'authorized' ? 'marked authorized without a named payer and approver' : 'a proposal, not authorized'}.` }, budget.status === 'authorized' ? [] : ['budget_not_authorized']);

  // D6: one API key, checked by presence only. Only the variable's name is ever written out.
  const keyName = m.credentials.apiKeyEnv;
  const present = (input.env[keyName] ?? '').trim() !== '';
  add({ id: 'api_key', label: 'API key present (D6)', status: present ? 'pass' : 'block', tracks: ['workers'], detail: present ? `${keyName} is set. Checked by presence only; not printed.` : `${keyName} is not set.` }, [`api_key_missing: ${keyName}`]);

  // The verifier host: one trusted environment, frozen for the whole cohort.
  const hostFrozen = m.environment.verificationEnvironment !== null && m.environment.verifierHostFrozen;
  add({ id: 'verifier_host', label: 'Verifier host frozen', status: hostFrozen ? 'pass' : 'block', tracks: ['workers'], detail: hostFrozen ? 'The verification environment is recorded and frozen.' : 'The verification environment is not recorded and frozen.' }, []);

  // The lockfile and verifier: what the manifest froze must still be what HASHES.json and pnpm-lock.yaml say.
  const h = input.verifierHashes;
  const verifierOk = h !== null && m.repository.verifierSha256 !== null && m.repository.verifierSha256 === h.verifierSha256;
  const lockOk = h !== null && m.repository.lockfileSha256 !== null && m.repository.lockfileSha256 === h.lockfileSha256 && input.lockfileSha256Now === h.lockfileSha256;
  const lockReasons = [...(verifierOk ? [] : ['verifier_not_frozen']), ...(lockOk ? [] : ['lockfile_not_frozen'])];
  add({
    id: 'lockfile_frozen', label: 'Lockfile and verifier frozen', status: lockReasons.length === 0 ? 'pass' : 'block', tracks: ['workers', 'assistant'],
    detail: h === null ? 'HASHES.json could not be read.' : lockReasons.length === 0 ? 'verifierSha256 and the lockfile match the frozen values.'
      : [verifierOk ? null : 'verifierSha256 differs from the frozen value', lockOk ? null : input.lockfileSha256Now !== h.lockfileSha256 ? 'pnpm-lock.yaml differs from HASHES.json (run the verifier hashes script)' : 'the lockfile differs from the frozen value'].filter(Boolean).join('; ') + '.',
  }, lockReasons);

  // Seed and order: recorded and frozen before start, and unchanged since.
  const frozen = isFrozen(m);
  const start = input.start;
  const moved = start !== null && (start.seed !== m.randomization.seed || start.orderSha256 !== m.randomization.orderSha256);
  const seedReasons = [...(frozen ? [] : ['seed_and_order_not_frozen']), ...(moved ? ['seed_or_order_changed_after_start'] : [])];
  add({ id: 'seed_and_order', label: 'Seed and order frozen', status: seedReasons.length === 0 ? 'pass' : 'block', tracks: ['workers', 'assistant'], detail: moved ? `The seed or order changed after start (${start!.startedAtUtc}).` : frozen ? `Seed and ${m.randomization.order.length} trials frozen at ${m.randomization.frozenAtUtc}.` : 'The seed and order are not recorded, or the order is not the one the seed derives.' }, seedReasons);

  // Modes: every planned mode is listed. An unsupported one is Not measured, with its reason.
  const modes: ModeLine[] = [
    ...m.workers.requiredModes.map((r): ModeLine => ({ id: r.id, track: 'workers', required: true, supported: r.availability === 'supported', status: r.availability === 'supported' ? 'Planned' : 'Not measured', reason: r.unavailableReason })),
    ...m.workers.optionalModes.map((id): ModeLine => ({ id, track: 'workers', required: false, supported: false, status: 'Not measured', reason: 'Optional; not planned in this cohort.' })),
    ...m.assistant.requestedModes.map((id): ModeLine => ({ id, track: 'assistant', required: true, supported: true, status: 'Planned', reason: null })),
  ];
  const requiredWorkers = modes.filter((x) => x.track === 'workers' && x.required);
  const supported = requiredWorkers.filter((x) => x.supported);
  const unsupported = requiredWorkers.filter((x) => !x.supported).map((x) => x.id);
  add({ id: 'modes', label: 'Modes supported', status: supported.length === 0 ? 'block' : unsupported.length > 0 ? 'warn' : 'pass', tracks: ['workers'], detail: supported.length === 0 ? 'No required worker mode is supported.' : unsupported.length > 0 ? `${unsupported.join(', ')} not supported yet; shown as Not measured.` : 'Every required mode is supported.' }, ['no_supported_mode']);

  const decide = (t: Track): Decision => ({ allowed: blockers[t].length === 0, blockers: [...new Set(blockers[t])] });
  return { liveDispatch: { workers: decide('workers'), assistant: decide('assistant') }, checks, modes };
}

const MARK: Readonly<Record<CheckStatus, string>> = { pass: 'PASS ', warn: 'WARN ', block: 'BLOCK' };

export function formatPreflight(report: PreflightReport): string {
  const lines = ['Benchmark preflight (reads files only; dispatches nothing)', ''];
  for (const c of report.checks) lines.push(`${MARK[c.status]}  ${c.label}: ${c.detail}`);
  lines.push('', 'Modes:');
  for (const mode of report.modes) lines.push(`  ${mode.id} (${mode.track}${mode.required ? '' : ', optional'}): ${mode.status}${mode.reason ? ` - ${mode.reason}` : ''}`);
  lines.push('');
  for (const t of ['assistant', 'workers'] as const) {
    const d = report.liveDispatch[t];
    lines.push(`Live dispatch, ${t}: ${d.allowed ? 'allowed' : 'blocked'}`);
    for (const b of d.blockers) lines.push(`  - ${b}`);
  }
  return lines.join('\n');
}
