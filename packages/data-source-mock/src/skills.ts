import {
  packDigest, PILOT_ROLE_PATHS, resolveSkills, scanPack, sha256Hex, SKILL_LIBRARY, skillStates, SkillVersionSchema, WORKER_TOOLS,
  type KnownVersion, type PackEntry, type SkillBinding, type SkillExecutionRecord, type SkillScanReport, type SkillVersion, type StackDocument,
} from '@selarikru/domain';
import { DataSourceException, type AttemptSkillsView, type ProjectViewSnapshot, type SkillActionView, type SkillCatalogEntryView, type SkillsView } from '@selarikru/view-protocol';

/**
 * The skill library on demo data. The catalog is the real first-party library; an intake stages a fixture pack written for the demo (it reads no directory: a browser has
 * none), scanned by the same `scanPack` the server runs. Review, binding and revocation follow the server's rules, and an attempt's packs come from `resolveSkills` over
 * the demo stack and the attempt's role. Like the server, an attempt keeps the packs it was first given; an attempt that received none is resolved again on the next read,
 * which stands in for the next claim. Nothing here touches a network or a repository.
 */

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'SKILL.md': '---\nname: team-review-notes\ndescription: How this team writes review notes and names tests. Demo fixture.\nversion: 0.3.0\nlicense: MIT\nallowed-tools: Read\n---\n# Team review notes\n\nName tests after the behaviour they check. Keep review notes short: what changed, why, and what was checked.\n\nThe long form of this guide lives at https://example.com/team-guide.\n',
  'references/naming.md': '# Naming\n\nUse plain names for files and tests.\n',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 Demo team\n',
};
const BLOCKED_FILES: Readonly<Record<string, string>> = {
  'SKILL.md': '---\nname: quick-setup\ndescription: Sets things up for you. Demo fixture.\n---\nRun ./install.sh before anything else.\n',
  'install.sh': '#!/bin/sh\necho "this would run on the host"\n',
};

const refuse = (message: string): DataSourceException => new DataSourceException({ code: 'unavailable', message, retryable: false });
const entriesOf = (files: Readonly<Record<string, string>>): PackEntry[] => Object.entries(files).map(([path, text]) => ({ path, kind: 'file', bytes: new TextEncoder().encode(text).length, executable: path.endsWith('.sh'), text }));

interface Staged { readonly version: SkillVersion; readonly scan: SkillScanReport; readonly blocked: boolean; reviewed: { by: string; at: string } | null }
interface Binding { desired: SkillBinding | null; revision: number; updatedAt: string }
interface State {
  readonly staged: Map<string, Staged>;
  readonly bindings: Map<string, Binding>;
  readonly revoked: Map<string, { by: string; at: string; reason: string }>;
  readonly records: Map<string, SkillExecutionRecord>;
}

function stagedOf(files: Readonly<Record<string, string>>, path: string, at: string): Staged {
  const entries = entriesOf(files);
  const scan = scanPack(entries);
  const list = Object.entries(files).filter(([p]) => !p.endsWith('.sh')).map(([p, text]) => ({ path: p, sha256: sha256Hex(text), bytes: new TextEncoder().encode(text).length }));
  const digest = packDigest(list);
  const name = files === FIXTURE_FILES ? 'team-review-notes' : 'quick-setup';
  const version = files === FIXTURE_FILES ? '0.3.0' : '0.0.0';
  const v: SkillVersion = SkillVersionSchema.parse({
    versionId: `tp-${name}@${version}+${digest.slice(0, 12)}`, skillId: `tp-${name}`, name, version, description: files === FIXTURE_FILES ? 'How this team writes review notes and names tests. Demo fixture.' : 'Sets things up for you. Demo fixture.',
    origin: 'third_party', scope: 'project', license: { spdx: files === FIXTURE_FILES ? 'MIT' : null, file: files === FIXTURE_FILES ? 'LICENSE' : null },
    source: { kind: 'local_directory', path, importedAt: at, importedBy: 'demo owner' }, digest, files: list,
    triggers: { entries: [], roles: [], paths: [], actions: [] }, labels: { frameworks: [], roles: [], focus: [] }, tools: ['Read'], harnesses: ['claude-code'], classification: 'internal',
  });
  return { version: v, scan, blocked: scan.blocked, reviewed: null };
}

export interface DemoSkills {
  get(projectId: string): Promise<SkillsView>;
  act(projectId: string, action: SkillActionView): Promise<SkillsView>;
  attempt(projectId: string, attemptId: string): Promise<AttemptSkillsView>;
  /** The reviewed bound packs and the stack entries their triggers name, for the stack's Skills axis. */
  forStack(projectId: string): { name: string; version: string; entries: string[] }[];
}

export function createDemoSkills(deps: { nowIso: (projectId: string) => string; snapshotOf: (projectId: string) => ProjectViewSnapshot; stackOf: (projectId: string) => StackDocument }): DemoSkills {
  const states = new Map<string, State>();
  const stateOf = (projectId: string): State => {
    let s = states.get(projectId);
    if (!s) { s = { staged: new Map(), bindings: new Map(), revoked: new Map(), records: new Map() }; states.set(projectId, s); }
    return s;
  };
  const known = (s: State): Map<string, KnownVersion> => {
    const out = new Map<string, KnownVersion>();
    for (const v of SKILL_LIBRARY) out.set(v.versionId, { version: v, reviewed: true, blocked: false, revoked: s.revoked.has(v.versionId) });
    for (const x of s.staged.values()) out.set(x.version.versionId, { version: x.version, reviewed: x.reviewed !== null && !x.blocked, blocked: x.blocked, revoked: s.revoked.has(x.version.versionId) });
    return out;
  };
  const bindings = (s: State) => [...s.bindings.entries()].flatMap(([skillId, b]) => (b.desired ? [{ skillId, binding: b.desired }] : []));

  const view = (projectId: string): SkillsView => {
    const s = stateOf(projectId);
    const latest = new Map<string, SkillExecutionRecord>();
    for (const r of s.records.values()) latest.set(r.taskId, r);
    const entry = (v: SkillVersion, extra: { reviewed: boolean; blocked: boolean; review: SkillCatalogEntryView['review']; scan: SkillScanReport | null }): SkillCatalogEntryView => {
      const enabledFor = [...latest.values()].filter((r) => r.delivered.some((d) => d.versionId === v.versionId)).map((r) => ({ taskId: r.taskId, attemptId: r.attemptId }));
      return {
        versionId: v.versionId, skillId: v.skillId, name: v.name, version: v.version, description: v.description, origin: v.origin, scope: v.scope, digest: v.digest, files: v.files,
        license: v.license, source: v.source, triggers: v.triggers, tools: v.tools, classification: v.classification,
        states: skillStates({ version: v, reviewed: extra.reviewed, blocked: extra.blocked, revoked: s.revoked.has(v.versionId), evaluations: [], projectId, enabledFor: enabledFor.map((e) => e.taskId) }),
        review: extra.review, revocation: s.revoked.get(v.versionId) ?? null, scan: extra.scan, enabledFor, evaluations: [],
      };
    };
    const roles = [...new Set(Object.values(deps.snapshotOf(projectId).tasks).map((t) => t.role).filter((r): r is string => typeof r === 'string'))].sort();
    return {
      projectId,
      catalog: [
        ...SKILL_LIBRARY.map((v) => entry(v, { reviewed: true, blocked: false, review: { by: 'platform', at: null }, scan: null })),
        ...[...s.staged.values()].map((x) => entry(x.version, { reviewed: x.reviewed !== null, blocked: x.blocked, review: x.reviewed, scan: x.scan })),
      ],
      bindings: [...s.bindings.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([skillId, b]) => ({ skillId, desired: b.desired, effective: b.desired, desiredRevision: b.revision, effectiveRevision: b.revision, state: 'applied' as const, updatedBy: 'demo owner', updatedAt: b.updatedAt })),
      roles,
    };
  };

  return {
    async get(projectId) { return view(projectId); },
    async act(projectId, a) {
      const s = stateOf(projectId);
      const at = deps.nowIso(projectId);
      const k = known(s);
      switch (a.kind) {
        case 'intake': {
          if (!a.path.startsWith('/')) throw refuse('The intake path must be an absolute local directory.');
          const staged = stagedOf(/unsafe|setup/i.test(a.path) ? BLOCKED_FILES : FIXTURE_FILES, a.path, at);
          if (!s.staged.has(staged.version.versionId)) s.staged.set(staged.version.versionId, staged);
          break;
        }
        case 'review': {
          const x = s.staged.get(a.versionId);
          if (!x) throw refuse(SKILL_LIBRARY.some((v) => v.versionId === a.versionId) ? 'A first-party pack is published reviewed.' : 'No such staged pack version.');
          if (x.blocked) throw refuse('The static scan blocked this version, so it cannot be reviewed.');
          if (x.reviewed) throw refuse('This version is already reviewed.');
          if (s.revoked.has(a.versionId)) throw refuse('This version is revoked.');
          if (x.scan.findings.some((f) => f.severity === 'review') && !a.acknowledgeFindings) throw refuse('Acknowledge the scan findings to mark this version reviewed.');
          x.reviewed = { by: 'demo owner', at };
          break;
        }
        case 'revoke': {
          if (!k.has(a.versionId)) throw refuse('No such pack version.');
          if (s.revoked.has(a.versionId)) throw refuse('This version is already revoked.');
          s.revoked.set(a.versionId, { by: 'demo owner', at, reason: a.reason });
          break;
        }
        case 'bind': {
          const b = s.bindings.get(a.skillId);
          if ((b?.revision ?? 0) !== a.expectedRevision) throw refuse('This binding changed since it was read. Reload and try again.');
          if (a.binding) {
            const v = k.get(a.binding.versionId);
            if (!v || v.version.skillId !== a.skillId) throw refuse('No such pack version for this skill.');
            if (v.revoked) throw refuse('A revoked version cannot be bound.');
            if (!v.reviewed || v.blocked) throw refuse('Only a reviewed version can be bound.');
          }
          s.bindings.set(a.skillId, { desired: a.binding, revision: (b?.revision ?? 0) + 1, updatedAt: at });
          break;
        }
      }
      return view(projectId);
    },
    async attempt(projectId, attemptId) {
      const s = stateOf(projectId);
      const kept = s.records.get(attemptId);
      const revokedOf = (r: SkillExecutionRecord) => r.delivered.map((d) => d.versionId).filter((v) => s.revoked.has(v)).sort();
      if (kept) return { attemptId, record: kept, revoked: revokedOf(kept) };
      const snap = deps.snapshotOf(projectId);
      const attempt = snap.attempts[attemptId];
      const task = attempt ? snap.tasks[attempt.taskId] : undefined;
      if (!attempt || !task) return { attemptId, record: null, revoked: [] };
      const role = task.role ?? '';
      const paths = (PILOT_ROLE_PATHS as Readonly<Record<string, readonly string[]>>)[role] ?? [];
      const r = resolveSkills({ task: { role, allowedPaths: paths, acceptanceCheckIds: [] }, stack: deps.stackOf(projectId), bindings: bindings(s), versions: known(s), destination: 'local', tools: WORKER_TOOLS, harness: 'claude-code' });
      const record: SkillExecutionRecord = { attemptId, taskId: task.taskId, revision: task.revision, destination: 'local', harness: 'claude-code', delivered: r.delivered, omitted: r.omitted, context: r.context, recordedAt: deps.nowIso(projectId) };
      if (record.delivered.length > 0) s.records.set(attemptId, record);
      return { attemptId, record, revoked: [] };
    },
    forStack(projectId) {
      const s = stateOf(projectId);
      const k = known(s);
      return bindings(s).flatMap(({ binding }) => { const v = k.get(binding.versionId); return v && v.reviewed && !v.revoked && !v.blocked ? [{ name: v.version.name, version: v.version.version, entries: [...v.version.triggers.entries] }] : []; })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
  };
}
