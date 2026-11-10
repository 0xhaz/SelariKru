import { describe, expect, it } from 'vitest';
import { deriveOrder, freezeOrder, ManifestError, manifestSha256, NO_STARTS, orderSha256, parseManifest, recordStart, repairStart, type Manifest } from '../src/manifest.ts';
import { formatPreflight, preflight, type PreflightInput } from '../src/preflight.ts';
import { HASHES, fixtureManifestText, resolvedManifest, SECRET, started } from './fixtures.ts';
import { watchNetwork } from './network.ts';

const KEY_ENV = { ANTHROPIC_API_KEY: SECRET };

function input(manifest: Manifest, over: Partial<PreflightInput> = {}): PreflightInput {
  return { manifest, env: KEY_ENV, verifier: { recorded: HASHES, recomputed: HASHES }, starts: NO_STARTS, ...over };
}

describe('T8.1 manifest loader and preflight', () => {
  it('reading a manifest dispatches nothing', async () => {
    const net = watchNetwork();
    try {
      const { manifest, sha256 } = parseManifest(fixtureManifestText());
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      const report = preflight(input(manifest));
      formatPreflight(report);
      // The result is a checklist, not a run: there is nothing in it that started anything.
      expect(Object.keys(report).sort()).toEqual(['checks', 'liveDispatch', 'modes']);
    } finally {
      net.restore();
    }
    expect(net.calls()).toEqual([]);
  });

  it('refuses a manifest that is not the protocol shape, naming the field', () => {
    const raw = JSON.parse(fixtureManifestText()) as Record<string, unknown>;
    expect(() => parseManifest(JSON.stringify({ ...raw, bonus: true }))).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify({ ...raw, repository: { ...(raw.repository as object), starterSha: 'ABC123' } }))).toThrow(/repository\.starterSha/);
    expect(() => parseManifest('{ not json')).toThrow(ManifestError);
  });

  it('any unresolved required field blocks live dispatch', () => {
    // The tracked fixture is a template: nothing in it is resolved, so neither track may dispatch.
    const fixture = preflight(input(parseManifest(fixtureManifestText()).manifest, { env: {} }));
    expect(fixture.liveDispatch.workers.allowed).toBe(false);
    expect(fixture.liveDispatch.assistant.allowed).toBe(false);
    expect(fixture.liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['unresolved: cohortId', 'unresolved: repository.starterSha', 'unresolved: environment.codingModel', 'unresolved: workers.repairPolicy']));
    expect(fixture.liveDispatch.assistant.blockers).toEqual(expect.arrayContaining(['unresolved: assistant.sdkVersion', 'unresolved: assistant.origin']));

    // Resolved, both tracks may dispatch.
    const ready = preflight(input(resolvedManifest()));
    expect(ready.liveDispatch.workers).toEqual({ allowed: true, blockers: [] });
    expect(ready.liveDispatch.assistant).toEqual({ allowed: true, blockers: [] });

    // Each required field, on its own, blocks the track it belongs to with its name.
    const cases: [string, 'workers' | 'assistant', (m: Manifest) => void][] = [
      ['repository.starterSha', 'workers', (m) => { m.repository.starterSha = null; }],
      ['repository.verifierSha', 'workers', (m) => { m.repository.verifierSha = null; }],
      ['environment.harness', 'workers', (m) => { m.environment.harness = null; }],
      ['environment.accountTier', 'workers', (m) => { m.environment.accountTier = null; }],
      ['environment.cloudBackend', 'workers', (m) => { m.environment.cloudBackend = null; }],
      ['environment.cpuRamLimitsVerified', 'workers', (m) => { m.environment.cpuRamLimitsVerified = false; }],
      ['workers.repairPolicy', 'workers', (m) => { m.workers.repairPolicy = null; }],
      ['assistant.cloudModel', 'assistant', (m) => { m.assistant.cloudModel = null; }],
      ['assistant.appCheckReadiness', 'assistant', (m) => { m.assistant.appCheckReadiness = 'unverified'; }],
    ];
    for (const [field, track, unset] of cases) {
      const r = preflight(input(resolvedManifest(unset)));
      expect(r.liveDispatch[track].allowed, field).toBe(false);
      expect(r.liveDispatch[track].blockers, field).toContain(`unresolved: ${field}`);
    }
  });

  it('budget authority (D4) blocks until the proposal is authorized by a named payer', () => {
    const unauthorized = preflight(input(resolvedManifest((m) => { m.proposedVariableBudgetUsd.status = 'proposal_not_authorized'; })));
    expect(unauthorized.liveDispatch.workers.blockers).toContain('budget_not_authorized');
    expect(unauthorized.liveDispatch.assistant.blockers).toContain('budget_not_authorized');
    const noPayer = preflight(input(resolvedManifest((m) => { m.proposedVariableBudgetUsd.payer = null; })));
    expect(noPayer.liveDispatch.workers.blockers).toContain('unresolved: proposedVariableBudgetUsd.payer');
    expect(noPayer.checks.find((c) => c.id === 'budget_authority')?.status).toBe('block');
    // Authorized with no time of authorization is not authorized.
    const undated = preflight(input(resolvedManifest((m) => { m.proposedVariableBudgetUsd.authorizedAtUtc = null; })));
    expect(undated.liveDispatch.workers.allowed).toBe(false);
    expect(undated.liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['budget_not_authorized', 'unresolved: proposedVariableBudgetUsd.authorizedAtUtc']));
    expect(undated.liveDispatch.assistant.blockers).toContain('budget_not_authorized');
  });

  it('checks the API key (D6) by presence only and never prints it', () => {
    const present = preflight(input(resolvedManifest()));
    const text = formatPreflight(present);
    expect(present.checks.find((c) => c.id === 'api_key')?.status).toBe('pass');
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(present)).not.toContain(SECRET);
    expect(text).toContain('ANTHROPIC_API_KEY');
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const absent = preflight(input(resolvedManifest(), { env }));
      expect(absent.liveDispatch.workers.blockers).toContain('api_key_missing: ANTHROPIC_API_KEY');
    }
  });

  it('refuses a live cohort when the verifier or lockfile, recomputed from their files, differ from the frozen values', () => {
    // What the files hash to now decides, not what HASHES.json says.
    const moved = preflight(input(resolvedManifest(), { verifier: { recorded: HASHES, recomputed: { ...HASHES, verifierSha256: '7'.repeat(64) } } }));
    expect(moved.liveDispatch.workers.blockers).toContain('verifier_not_frozen');
    expect(moved.liveDispatch.assistant.blockers).toContain('verifier_not_frozen');
    const lock = preflight(input(resolvedManifest(), { verifier: { recorded: HASHES, recomputed: { ...HASHES, lockfileSha256: '8'.repeat(64) } } }));
    expect(lock.liveDispatch.workers.blockers).toContain('lockfile_not_frozen');
    const unknown = preflight(input(resolvedManifest(), { verifier: { recorded: HASHES, recomputed: null } }));
    expect(unknown.liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['verifier_not_frozen', 'lockfile_not_frozen']));
    expect(unknown.checks.find((c) => c.id === 'lockfile_frozen')?.status).toBe('block');
    // HASHES.json agreeing with the manifest is not enough when the files have moved; and a stale HASHES.json blocks on its own.
    const trusted = preflight(input(resolvedManifest(), { verifier: { recorded: HASHES, recomputed: { verifierSha256: '5'.repeat(64), lockfileSha256: '6'.repeat(64) } } }));
    expect(trusted.liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['verifier_not_frozen', 'lockfile_not_frozen', 'verifier_hashes_stale']));
    const stale = preflight(input(resolvedManifest(), { verifier: { recorded: { ...HASHES, verifierSha256: '7'.repeat(64) }, recomputed: HASHES } }));
    expect(stale.liveDispatch.workers.blockers).toEqual(['verifier_hashes_stale']);
    expect(preflight(input(resolvedManifest(), { verifier: { recorded: null, recomputed: HASHES } })).liveDispatch.workers.blockers).toEqual(['verifier_hashes_stale']);
  });

  it('the verifier host must be frozen before workers dispatch', () => {
    const r = preflight(input(resolvedManifest((m) => { m.environment.verifierHostFrozen = false; })));
    expect(r.liveDispatch.workers.blockers).toContain('unresolved: environment.verifierHostFrozen');
    expect(r.liveDispatch.workers.blockers).toContain('verifier_host_not_frozen');
    expect(r.liveDispatch.assistant.blockers).not.toContain('verifier_host_not_frozen');
    expect(r.checks.find((c) => c.id === 'verifier_host')?.status).toBe('block');
  });

  it('seed and order frozen before start', () => {
    // No seed: blocked.
    const unseeded = parseManifest(fixtureManifestText()).manifest;
    expect(preflight(input(unseeded)).liveDispatch.workers.blockers).toContain('seed_and_order_not_frozen');

    // Freezing records the seed, the derived order, its hash and when; the same seed always gives the same order.
    const m = resolvedManifest();
    expect(m.randomization.seed).toBe('seed-7f1e');
    expect(m.randomization.order).toEqual(deriveOrder(m, 'seed-7f1e'));
    expect(m.randomization.orderSha256).toBe(orderSha256(m.randomization.order));
    expect(m.randomization.frozenAtUtc).toBe('2026-11-15T10:00:00.000Z');
    expect(deriveOrder(m, 'seed-other')).not.toEqual(m.randomization.order);
    // Every planned trial is in the order: 5 blocks x 3 modes, 2 warm-ups per route and 10 x 3 per route.
    expect(m.randomization.order.filter((e) => e.startsWith('workers/'))).toHaveLength(15);
    expect(m.randomization.order.filter((e) => e.startsWith('assistant/warmup/'))).toHaveLength(4);
    expect(m.randomization.order.filter((e) => e.startsWith('assistant/') && !e.includes('/warmup/'))).toHaveLength(60);

    // A hand-edited order is not the frozen one.
    const edited = structuredClone(m);
    edited.randomization.order = [...edited.randomization.order].reverse();
    expect(preflight(input(edited)).liveDispatch.workers.blockers).toContain('seed_and_order_not_frozen');

    // Start can only be recorded on a frozen manifest, and stamps the manifest as well as returning the start file.
    expect(() => recordStart(unseeded, 'workers', '2026-11-16T09:00:00.000Z')).toThrow(/frozen/);
    const { start, manifest: stamped } = recordStart(m, 'workers', '2026-11-16T09:00:00.000Z');
    expect(start).toMatchObject({ track: 'workers', seed: 'seed-7f1e', orderSha256: m.randomization.orderSha256, manifestSha256: manifestSha256(m), startedAtUtc: '2026-11-16T09:00:00.000Z' });
    expect(stamped.starts.workers).toEqual({ startedAtUtc: '2026-11-16T09:00:00.000Z', manifestSha256: manifestSha256(m) });
    // Stamping does not change the hash the start refers to.
    expect(manifestSha256(stamped)).toBe(manifestSha256(m));
    expect(() => recordStart(stamped, 'workers', '2026-11-16T10:00:00.000Z')).toThrow(/already started/);

    // After start, re-freezing is refused, by the file or by the manifest's own stamp alone.
    expect(() => freezeOrder(m, 'seed-other', '2026-11-16T10:00:00.000Z', { ...NO_STARTS, workers: start })).toThrow(/after start/);
    expect(() => freezeOrder(stamped, 'seed-other', '2026-11-16T10:00:00.000Z')).toThrow(/after start/);
    const starts = { ...NO_STARTS, workers: start };
    expect(preflight(input(stamped, { starts })).liveDispatch.workers.allowed).toBe(true);
    // A manifest re-frozen behind the stamp's back is blocked.
    const reseeded = freezeOrder(m, 'seed-other', '2026-11-16T10:00:00.000Z');
    const r = preflight(input({ ...reseeded, starts: stamped.starts }, { starts }));
    expect(r.liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['seed_or_order_changed_after_start', 'manifest_changed_after_start']));
  });

  it('blocks a manifest changed in any way after start, and a start whose stamp and file disagree', () => {
    const { manifest, starts } = started();
    expect(preflight(input(manifest, { starts })).liveDispatch.workers).toEqual({ allowed: true, blockers: [] });
    const changed = structuredClone(manifest);
    changed.environment.codingModel = 'some-other-model';
    changed.proposedVariableBudgetUsd.total = 600;
    changed.proposedVariableBudgetUsd.codingPlanningVerificationModelsAndTools = 590;
    const r = preflight(input(changed, { starts }));
    expect(r.liveDispatch.workers.blockers).toContain('manifest_changed_after_start');
    expect(r.liveDispatch.assistant.blockers).toContain('manifest_changed_after_start');
    // The stamp alone is enough to catch a change, with no file present.
    expect(preflight(input(changed, { starts: NO_STARTS })).liveDispatch.workers.blockers).toEqual(expect.arrayContaining(['manifest_changed_after_start', 'start_record_mismatch']));
    // A file with no stamp, or a stamp and a file that disagree, is a mismatch.
    const unstamped = { ...manifest, starts: { workers: null, assistant: null } };
    expect(preflight(input(unstamped, { starts })).liveDispatch.workers.blockers).toContain('start_record_mismatch');
    const other = { ...starts, workers: { ...starts.workers!, startedAtUtc: '2026-11-17T00:00:00.000Z' } };
    expect(preflight(input(manifest, { starts: other })).liveDispatch.workers.blockers).toContain('start_record_mismatch');
    expect(preflight(input(manifest, { starts: other })).liveDispatch.assistant.allowed).toBe(true);
  });

  it('repair reconciles a stamp with no file, or a file with no stamp, for the same cohort only', () => {
    const { manifest, starts } = started();
    const w = starts.workers!;
    // Stamp present, file lost: the file is rebuilt from the stamp and the manifest.
    const fromStamp = repairStart(manifest, 'workers', null);
    expect(fromStamp.start).toEqual(w);
    expect(fromStamp.manifest).toEqual(manifest);
    // File present, stamp lost: the stamp is restored from the file.
    const unstamped = { ...manifest, starts: { ...manifest.starts, workers: null } };
    const fromFile = repairStart(unstamped, 'workers', w);
    expect(fromFile.manifest.starts.workers).toEqual({ startedAtUtc: w.startedAtUtc, manifestSha256: w.manifestSha256 });
    expect(preflight(input(fromFile.manifest, { starts })).liveDispatch.workers.allowed).toBe(true);
    // A file from another cohort, one that disagrees with the stamp, nothing to repair, or nothing started: refused.
    expect(() => repairStart(unstamped, 'workers', { ...w, cohortId: 'another-cohort' })).toThrow(/another cohort/);
    // A file with the same cohortId but from a different manifest is refused up front, before any stamp is written.
    expect(() => repairStart(unstamped, 'workers', { ...w, manifestSha256: 'a'.repeat(64) })).toThrow(/different manifest/);
    const edited = structuredClone(unstamped);
    edited.environment.codingModel = 'other';
    expect(() => repairStart(edited, 'workers', w)).toThrow(/different manifest/);
    expect(() => repairStart(manifest, 'workers', { ...w, startedAtUtc: '2026-11-17T00:00:00.000Z' })).toThrow(/disagree/);
    expect(() => repairStart(manifest, 'workers', w)).toThrow(/nothing to repair/);
    expect(() => repairStart(unstamped, 'workers', null)).toThrow(/has not started/);
    // Repair copies what is there; it never re-hashes, so a manifest changed after start stays blocked.
    const changed = structuredClone(manifest);
    changed.environment.codingModel = 'other';
    const repaired = repairStart(changed, 'workers', null);
    expect(preflight(input(repaired.manifest, { starts: { ...starts, workers: repaired.start } })).liveDispatch.workers.blockers).toContain('manifest_changed_after_start');
  });

  it('unsupported modes remain visible', () => {
    // The tracked fixture: C1 and H2 wait for the coupon. They stay listed, as Not measured with the reason.
    const fixture = preflight(input(parseManifest(fixtureManifestText()).manifest));
    expect(fixture.modes.map((m) => m.id)).toEqual(['L1', 'C1', 'H2', 'L2', 'C2', 'ONLY_ON_DEVICE', 'ONLY_IN_CLOUD']);
    const c1 = fixture.modes.find((m) => m.id === 'C1')!;
    expect(c1).toMatchObject({ supported: false, status: 'Not measured', required: true });
    expect(c1.reason).toMatch(/coupon/);
    expect(fixture.modes.find((m) => m.id === 'L2')).toMatchObject({ supported: false, status: 'Not measured', required: false });
    expect(fixture.checks.find((c) => c.id === 'modes')?.status).toBe('warn');
    expect(formatPreflight(fixture)).toMatch(/C1.*Not measured/);
    expect(formatPreflight(fixture)).toMatch(/H2.*Not measured/);

    // An unsupported required mode does not hide or block the rest: L1 alone may dispatch.
    const l1Only = preflight(input(resolvedManifest((m) => { m.workers.requiredModes = m.workers.requiredModes.map((r) => (r.id === 'L1' ? r : { ...r, availability: 'unsupported', unavailableReason: 'coupon' })); })));
    expect(l1Only.liveDispatch.workers.allowed).toBe(true);
    expect(l1Only.modes.filter((m) => m.status === 'Not measured').map((m) => m.id)).toEqual(['C1', 'H2', 'L2', 'C2']);
    // No supported worker mode at all blocks the track.
    const none = preflight(input(resolvedManifest((m) => { m.workers.requiredModes = m.workers.requiredModes.map((r) => ({ ...r, availability: 'unsupported', unavailableReason: 'coupon' })); })));
    expect(none.liveDispatch.workers.blockers).toContain('no_supported_mode');
  });
});
