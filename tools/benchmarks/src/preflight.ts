import type { CliLoginStatus } from './cli-login.ts';
import { isFrozen, startIssues, TRACKS, type Manifest, type StartRecords, type Track } from './manifest.ts';

/**
 * Preflight: a checklist over a manifest and a few files, deciding whether each track may dispatch live. It reads
 * what it is given and nothing else: no run starts, no model is called, nothing is spent and no connection opens.
 * The API key is checked by presence only; its value never enters the result.
 */

export type { Track };
export type CheckStatus = 'pass' | 'warn' | 'block';

export type CheckId = 'required_fields' | 'budget_authority' | 'api_key' | 'cli_login' | 'verifier_host' | 'lockfile_frozen' | 'seed_and_order' | 'unchanged_since_start' | 'modes';

export interface Check {
  readonly id: CheckId;
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

export interface VerifierHashPair {
  readonly verifierSha256: string;
  readonly lockfileSha256: string;
}

export interface PreflightInput {
  readonly manifest: Manifest;
  /** Only presence of `manifest.credentials.apiKeyEnv` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly verifier: {
    /** As recorded in services/verifier/suites/feedback-board/HASHES.json; null when it could not be read. */
    readonly recorded: VerifierHashPair | null;
    /** Recomputed from the verifier's files and pnpm-lock.yaml with the verifier's own hashing; null when that failed. */
    readonly recomputed: VerifierHashPair | null;
  };
  /** The cohort-start files present, per track. */
  readonly starts: StartRecords;
  /** D6, `cli_login` mode: what the read-only `claude auth status` probe answered. Absent: not checked, which blocks. */
  readonly cliLogin?: CliLoginStatus;
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
  ['proposedVariableBudgetUsd.authorizedAtUtc', (m) => set(m.proposedVariableBudgetUsd.authorizedAtUtc)],
];

const cloudModeSupported = (m: Manifest): boolean =>
  m.workers.requiredModes.some((r) => r.availability === 'supported' && r.cloudCodingSlots > 0);

const ENVIRONMENT_FIELDS = ['harness', 'harnessVersion', 'codingModel', 'inferenceProvider', 'modelSettings', 'accountTier', 'priceReference', 'localHost', 'verificationEnvironment'] as const;

const WORKERS: readonly Field[] = [
  ['repository.contractSha256', (m) => set(m.repository.contractSha256)],
  ['repository.verifierSha', (m) => set(m.repository.verifierSha)],
  ...ENVIRONMENT_FIELDS.map((k): Field => [`environment.${k}`, (m) => set(m.environment[k])]),
  // Cloud execution identity is required only once a cloud mode is planned to run.
  ['environment.cloudBackend', (m) => !cloudModeSupported(m) || set(m.environment.cloudBackend)],
  ['environment.imageDigest', (m) => !cloudModeSupported(m) || set(m.environment.imageDigest)],
  ['environment.cpuRamLimitsVerified', (m) => m.environment.cpuRamLimitsVerified],
  ['environment.verifierHostFrozen', (m) => m.environment.verifierHostFrozen],
  ['workers.repairPolicy', (m) => set(m.workers.repairPolicy)],
];

const ASSISTANT_FIELDS = ['sdkVersion', 'browserVersion', 'origin', 'cloudModel', 'deviceModel'] as const;

const ASSISTANT: readonly Field[] = [
  ...ASSISTANT_FIELDS.map((k): Field => [`assistant.${k}`, (m) => set(m.assistant[k])]),
  ['assistant.appCheckReadiness', (m) => m.assistant.appCheckReadiness === 'verified'],
];

const unresolved = (m: Manifest, fields: readonly Field[]): string[] => fields.filter(([, ok]) => !ok(m)).map(([path]) => path);

class Checklist {
  readonly checks: Check[] = [];
  readonly blockers: Record<Track, string[]> = { workers: [], assistant: [] };

  add(check: Check, reasons: readonly string[]): void {
    this.checks.push(check);
    if (check.status === 'block') for (const t of check.tracks) this.blockers[t].push(...reasons);
  }

  decide(t: Track): Decision {
    return { allowed: this.blockers[t].length === 0, blockers: [...new Set(this.blockers[t])] };
  }
}

function requiredFields(list: Checklist, m: Manifest): void {
  const common = unresolved(m, COMMON);
  const perTrack: Record<Track, string[]> = { workers: [...common, ...unresolved(m, WORKERS)], assistant: [...common, ...unresolved(m, ASSISTANT)] };
  for (const t of TRACKS) list.blockers[t].push(...perTrack[t].map((p) => `unresolved: ${p}`));
  const any = perTrack.workers.length + perTrack.assistant.length > 0;
  list.checks.push({
    id: 'required_fields', label: 'Required fields resolved', status: any ? 'block' : 'pass', tracks: ['workers', 'assistant'],
    detail: any ? `Workers: ${perTrack.workers.length} unresolved. Assistant: ${perTrack.assistant.length} unresolved.` : 'Every required field is resolved.',
  });
}

/** D4: spend authority needs the proposal authorized, a named payer and approver, and when it was authorized. */
function budgetAuthority(list: Checklist, m: Manifest): void {
  const b = m.proposedVariableBudgetUsd;
  const authorized = b.status === 'authorized' && b.payer !== null && b.authorizedBy !== null && b.authorizedAtUtc !== null;
  const detail = authorized ? `$${b.total} variable cap authorized at ${b.authorizedAtUtc}; payer recorded.`
    : b.status === 'authorized' ? `The $${b.total} variable cap is marked authorized without a named payer, approver and time.`
      : `The $${b.total} variable cap is a proposal, not authorized.`;
  list.add({ id: 'budget_authority', label: 'Budget authority (D4)', status: authorized ? 'pass' : 'block', tracks: ['workers', 'assistant'], detail }, ['budget_not_authorized']);
}

/** D6: one API key, checked by presence only. Only the variable's name is ever written out. */
function apiKey(list: Checklist, m: Manifest, env: PreflightInput['env']): void {
  const name = m.credentials.apiKeyEnv;
  const present = (env[name] ?? '').trim() !== '';
  const detail = present ? `${name} is set. Checked by presence only; not printed.` : `${name} is not set.`;
  list.add({ id: 'api_key', label: 'API key present (D6)', status: present ? 'pass' : 'block', tracks: ['workers'], detail }, [`api_key_missing: ${name}`]);
}

/** D6, `cli_login` mode: the owner's Claude Code CLI login. Only whether it is present and logged in is ever known here. */
function cliLogin(list: Checklist, status: CliLoginStatus | undefined): void {
  const reason = status === undefined ? 'claude_cli_login_unchecked'
    : !status.present ? 'claude_cli_missing'
      : status.loggedIn === false ? 'claude_cli_not_logged_in'
        : status.loggedIn === null ? 'claude_cli_login_unknown'
          // The host login is not what the sandbox uses: sbx's global anthropic service secret is. Without it the worker has no credential.
          : status.sandboxSecret === undefined ? 'sbx_anthropic_secret_unchecked'
            : status.sandboxSecret === false ? 'sbx_anthropic_secret_missing'
              : status.sandboxSecret === null ? 'sbx_anthropic_secret_unknown' : null;
  const detail = reason === null ? 'The host claude CLI is present and logged in (this checks the host catalog only, not the sandbox), and `sbx secret ls --json` lists the global anthropic service secret that carries a credential into each sandbox (its type is not verified). Checked read-only; no account details kept or printed.'
    : reason === 'sbx_anthropic_secret_missing' ? 'The host claude CLI is logged in, but `sbx secret ls --json` lists no global anthropic service secret, so a sandbox would have no credential.'
      : reason.startsWith('sbx_') ? 'The host claude CLI is logged in, but `sbx secret ls --json` could not be read or was not checked, so whether a sandbox gets a credential is unknown.'
    : reason === 'claude_cli_login_unchecked' ? 'The claude CLI login was not checked.'
      : reason === 'claude_cli_missing' ? 'The claude CLI was not found.'
        : reason === 'claude_cli_not_logged_in' ? 'The claude CLI is not logged in.' : 'The claude CLI login status could not be read.';
  list.add({ id: 'cli_login', label: 'Claude CLI logged in on the host, and sbx anthropic secret present (D6)', status: reason === null ? 'pass' : 'block', tracks: ['workers'], detail }, reason === null ? [] : [reason]);
}

function verifierHost(list: Checklist, m: Manifest): void {
  const frozen = m.environment.verificationEnvironment !== null && m.environment.verifierHostFrozen;
  const detail = frozen ? 'The verification environment is recorded and frozen.' : 'The verification environment is not recorded and frozen.';
  list.add({ id: 'verifier_host', label: 'Verifier host frozen', status: frozen ? 'pass' : 'block', tracks: ['workers'], detail }, ['verifier_host_not_frozen']);
}

/** The verifier and lockfile as their files hash now must be what the manifest froze, and HASHES.json must not be stale. */
function lockfileFrozen(list: Checklist, m: Manifest, v: PreflightInput['verifier']): void {
  const now = v.recomputed;
  const verifierOk = now !== null && m.repository.verifierSha256 !== null && m.repository.verifierSha256 === now.verifierSha256;
  const lockOk = now !== null && m.repository.lockfileSha256 !== null && m.repository.lockfileSha256 === now.lockfileSha256;
  const fresh = now !== null && v.recorded !== null && v.recorded.verifierSha256 === now.verifierSha256 && v.recorded.lockfileSha256 === now.lockfileSha256;
  const reasons = [
    ...(verifierOk ? [] : ['verifier_not_frozen']),
    ...(lockOk ? [] : ['lockfile_not_frozen']),
    ...(fresh || now === null ? [] : ['verifier_hashes_stale']),
  ];
  const notes = [
    now === null ? 'the verifier files could not be hashed' : null,
    now !== null && !verifierOk ? 'the recomputed verifierSha256 differs from the frozen value' : null,
    now !== null && !lockOk ? 'pnpm-lock.yaml differs from the frozen value' : null,
    now !== null && !fresh ? 'HASHES.json is stale or unreadable (run the verifier hashes script)' : null,
  ].filter((x): x is string => x !== null);
  const detail = reasons.length === 0 ? 'verifierSha256 and the lockfile, recomputed from their files, match the frozen values.' : `${notes.join('; ')}.`;
  list.add({ id: 'lockfile_frozen', label: 'Lockfile and verifier frozen', status: reasons.length === 0 ? 'pass' : 'block', tracks: ['workers', 'assistant'], detail }, reasons);
}

function seedAndOrder(list: Checklist, m: Manifest): void {
  const frozen = isFrozen(m);
  const detail = frozen ? `Seed and ${m.randomization.order.length} slots frozen at ${m.randomization.frozenAtUtc}.`
    : 'The seed and order are not recorded, or the order is not the one the seed derives.';
  list.add({ id: 'seed_and_order', label: 'Seed and order frozen', status: frozen ? 'pass' : 'block', tracks: ['workers', 'assistant'], detail }, ['seed_and_order_not_frozen']);
}

/** For each track that has started: the manifest, seed and order are still the ones it started under. */
function unchangedSinceStart(list: Checklist, m: Manifest, starts: StartRecords): void {
  for (const t of TRACKS) {
    if (m.starts[t] === null && starts[t] === null) continue;
    const issues = startIssues(m, t, starts[t]);
    const at = m.starts[t]?.startedAtUtc ?? starts[t]?.startedAtUtc;
    const detail = issues.length === 0 ? `Started ${at}; unchanged since.` : `Started ${at}: ${issues.join(', ')}.`;
    list.add({ id: 'unchanged_since_start', label: `Unchanged since ${t} start`, status: issues.length === 0 ? 'pass' : 'block', tracks: [t], detail }, issues);
  }
}

function modeLines(m: Manifest): ModeLine[] {
  return [
    ...m.workers.requiredModes.map((r): ModeLine => ({
      id: r.id, track: 'workers', required: true, supported: r.availability === 'supported',
      status: r.availability === 'supported' ? 'Planned' : 'Not measured', reason: r.unavailableReason,
    })),
    ...m.workers.optionalModes.map((id): ModeLine => ({
      id, track: 'workers', required: false, supported: false, status: 'Not measured', reason: 'Optional; not planned in this cohort.',
    })),
    ...m.assistant.requestedModes.map((id): ModeLine => ({ id, track: 'assistant', required: true, supported: true, status: 'Planned', reason: null })),
  ];
}

/** Every planned mode is listed. An unsupported one is Not measured with its reason; it blocks only when no worker mode is left. */
function modesSupported(list: Checklist, modes: readonly ModeLine[]): void {
  const required = modes.filter((x) => x.track === 'workers' && x.required);
  const supported = required.filter((x) => x.supported);
  const unsupported = required.filter((x) => !x.supported).map((x) => x.id);
  const status: CheckStatus = supported.length === 0 ? 'block' : unsupported.length > 0 ? 'warn' : 'pass';
  const detail = supported.length === 0 ? 'No required worker mode is supported.'
    : unsupported.length > 0 ? `${unsupported.join(', ')} not supported yet; shown as Not measured.` : 'Every required mode is supported.';
  list.add({ id: 'modes', label: 'Modes supported', status, tracks: ['workers'], detail }, ['no_supported_mode']);
}

export function preflight(input: PreflightInput): PreflightReport {
  const m = input.manifest;
  const list = new Checklist();
  requiredFields(list, m);
  budgetAuthority(list, m);
  if (m.credentials.mode === 'api_key') apiKey(list, m, input.env);
  else cliLogin(list, input.cliLogin);
  verifierHost(list, m);
  lockfileFrozen(list, m, input.verifier);
  seedAndOrder(list, m);
  unchangedSinceStart(list, m, input.starts);
  const modes = modeLines(m);
  modesSupported(list, modes);
  return { liveDispatch: { workers: list.decide('workers'), assistant: list.decide('assistant') }, checks: list.checks, modes };
}

/** M8: what the owner sets up before a live Track A cohort. */
const RUNBOOK: readonly string[] = [
  'Start a separate Chrome profile for CDP, never your everyday one: chrome --remote-debugging-port=9222 --user-data-dir=<a dedicated benchmark profile directory>.',
  'In that profile, sign in to the control web, open the bench page (built with VITE_BENCH_PAGE=1), and download the on-device model in that profile before the cohort.',
  'A VITE_BENCH_PAGE=1 build deployed to the origin is reachable by any signed-in user of that origin: deploy it only for the cohort, and redeploy the default build straight after.',
  'Then run: benchmark run-assistant --live --cdp http://127.0.0.1:9222 --bench-url <the bench page URL> --records <file>.',
];

const MARK: Readonly<Record<CheckStatus, string>> = { pass: 'PASS ', warn: 'WARN ', block: 'BLOCK' };

export function formatPreflight(report: PreflightReport): string {
  const lines = ['Benchmark preflight (reads files only; dispatches nothing)', ''];
  for (const c of report.checks) lines.push(`${MARK[c.status]}  ${c.label}: ${c.detail}`);
  lines.push('', 'Modes:');
  for (const mode of report.modes) {
    const kind = mode.required ? mode.track : `${mode.track}, optional`;
    lines.push(`  ${mode.id} (${kind}): ${mode.status}${mode.reason ? ` - ${mode.reason}` : ''}`);
  }
  lines.push('', 'T8.5 runbook (Track A, live):', ...RUNBOOK.map((l) => `  - ${l}`));
  lines.push('');
  for (const t of ['assistant', 'workers'] as const) {
    const d = report.liveDispatch[t];
    lines.push(`Live dispatch, ${t}: ${d.allowed ? 'allowed' : 'blocked'}`);
    for (const b of d.blockers) lines.push(`  - ${b}`);
  }
  return lines.join('\n');
}
