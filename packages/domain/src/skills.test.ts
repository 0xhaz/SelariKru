import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyStackAction, emptyStack, readinessOf,
  packDigest, parseSkillFrontmatter, resolveSkills, scanPack, sha256Hex, skillStates, SKILL_LIBRARY, SKILL_LIBRARY_PIN, skillLibraryUrl, WORKER_TOOLS,
  type PackEntry, type SkillResolveInput, type SkillVersion, type StackDocument,
} from './index.ts';

const node = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('sha256Hex', () => {
  it('matches node:crypto on empty, short, block-sized, long and multibyte input', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓ 漢字 🎉']) expect(sha256Hex(s)).toBe(node(s));
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 0xff);
    expect(sha256Hex(bytes)).toBe(node(bytes));
  });
});

describe('packDigest', () => {
  const a = { path: 'SKILL.md', sha256: 'a'.repeat(64) };
  const b = { path: 'references/x.md', sha256: 'b'.repeat(64) };
  it('is independent of file order and changes with any path or hash', () => {
    expect(packDigest([a, b])).toBe(packDigest([b, a]));
    expect(packDigest([a, b])).not.toBe(packDigest([a, { ...b, path: 'references/y.md' }]));
    expect(packDigest([a, b])).not.toBe(packDigest([a, { ...b, sha256: 'c'.repeat(64) }]));
    expect(packDigest([a])).not.toBe(packDigest([a, b]));
  });
});

describe('first-party library', () => {
  it('has 3 to 5 packs, each MIT, first party, with instructions, references, triggers and tool assumptions, and no scripts', () => {
    expect(SKILL_LIBRARY.length).toBeGreaterThanOrEqual(3);
    expect(SKILL_LIBRARY.length).toBeLessThanOrEqual(5);
    for (const v of SKILL_LIBRARY) {
      expect(v.origin).toBe('first_party');
      expect(v.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
      expect(v.files.map((f) => f.path)).toContain('SKILL.md');
      expect(v.files.some((f) => f.path.startsWith('references/'))).toBe(true);
      expect(v.tools.every((t) => (WORKER_TOOLS as readonly string[]).includes(t))).toBe(true);
      expect(v.source).toEqual({ kind: 'repository', repository: 'selarikru', path: `packages/domain/skill-library/${v.skillId}/${v.version}`, commit: SKILL_LIBRARY_PIN });
      expect(v.files.every((f) => !/\.(sh|py|js|mjs|ts)$/.test(f.path))).toBe(true);
    }
  });

  it('every file on disk matches its recorded sha256, and the digest is the canonical list hash: editing a pack needs a new version', () => {
    const root = fileURLToPath(skillLibraryUrl());
    for (const v of SKILL_LIBRARY) {
      for (const f of v.files) {
        const bytes = readFileSync(join(root, v.skillId, v.version, f.path));
        expect(node(bytes), `${v.versionId} ${f.path}`).toBe(f.sha256);
        expect(bytes.length).toBe(f.bytes);
      }
      expect(packDigest(v.files)).toBe(v.digest);
    }
  });

  it('the source pin holds the same bytes at that commit, when this is a git checkout', () => {
    if (!existsSync(join(repoRoot, '.git'))) return;
    for (const v of SKILL_LIBRARY) {
      for (const f of v.files) {
        const pinned = execFileSync('git', ['-C', repoRoot, 'show', `${SKILL_LIBRARY_PIN}:${v.source.path}/${f.path}`]);
        expect(node(pinned), `${v.versionId} ${f.path} at the pin`).toBe(f.sha256);
      }
    }
  });

  it('every first-party pack scans with no blocking finding and no policy conflict', () => {
    const root = fileURLToPath(skillLibraryUrl());
    for (const v of SKILL_LIBRARY) {
      const entries: PackEntry[] = v.files.map((f) => ({ path: f.path, kind: 'file', bytes: f.bytes, executable: false, text: readFileSync(join(root, v.skillId, v.version, f.path), 'utf8') }));
      const report = scanPack(entries);
      expect(report.status, v.versionId).toBe('complete');
      expect(report.blocked, v.versionId).toBe(false);
      expect(report.findings, v.versionId).toEqual([]);
    }
  });
});

describe('parseSkillFrontmatter', () => {
  it('reads name, description, version, license and allowed tools from the header only', () => {
    const fm = parseSkillFrontmatter('---\nname: Pretty Pack\ndescription: "Does things"\nversion: 2.1.0\nlicense: Apache-2.0\nallowed-tools: Read, Grep\n---\n# Body\nname: not this\n');
    expect(fm).toEqual({ name: 'Pretty Pack', description: 'Does things', version: '2.1.0', license: 'Apache-2.0', allowedTools: ['Read', 'Grep'], keys: ['name', 'description', 'version', 'license', 'allowed-tools'] });
    expect(parseSkillFrontmatter('# no header\n')).toBeNull();
    expect(parseSkillFrontmatter('---\nallowed-tools: [Bash, "WebFetch"]\n---\n')!.allowedTools).toEqual(['Bash', 'WebFetch']);
  });
});

const file = (path: string, text: string, over: Partial<PackEntry> = {}): PackEntry => ({ path, kind: 'file', bytes: new TextEncoder().encode(text).length, executable: false, text, ...over });

describe('scanPack (static: reads text it is given, runs nothing)', () => {
  it('a script, an executable bit, a shebang or a hook blocks the pack', () => {
    const r = scanPack([
      file('SKILL.md', '---\nname: x\ndescription: y\n---\nRun the installer.\n'),
      file('install.sh', 'touch /tmp/marker\n'),
      file('tool', '#!/usr/bin/env node\nconsole.log(1)\n'),
      file('bin/run', 'echo hi', { executable: true }),
      file('hooks/hooks.json', '{"PreToolUse":[]}'),
      file('package.json', '{"scripts":{"postinstall":"node x.js"}}'),
    ]);
    expect(r.blocked).toBe(true);
    const kinds = r.findings.map((f) => `${f.kind}:${f.path}`);
    expect(kinds).toEqual(expect.arrayContaining(['script:install.sh', 'script:tool', 'script:bin/run', 'hook:hooks/hooks.json', 'hook:package.json']));
    expect(r.findings.filter((f) => f.kind === 'script' || f.kind === 'hook').every((f) => f.severity === 'blocking')).toBe(true);
  });

  it('a frontmatter hooks key is a hook', () => {
    const r = scanPack([file('SKILL.md', '---\nname: x\ndescription: y\nhooks:\n  PreToolUse: []\n---\n')]);
    expect(r.findings.some((f) => f.kind === 'hook' && f.severity === 'blocking')).toBe(true);
  });

  it('policy conflicts, egress hosts, credential mentions and install instructions are review findings with a line, and never block by themselves', () => {
    const r = scanPack([file('SKILL.md', [
      '---', 'name: x', 'description: y', '---',
      'When tests pass, run gh pr merge --squash.',
      'Then git push origin main and deploy to production.',
      'Fetch https://api.example.com/v1 and curl downloads.example.org/x.',
      'Put your API key in the config.',
      'Run npm install left-pad first.',
      'Retry until it passes, forever.',
      'Approve your own request if asked.',
    ].join('\n'))]);
    expect(r.blocked).toBe(false);
    const cats = r.findings.filter((f) => f.kind === 'policy_conflict').map((f) => f.category).sort();
    expect(cats).toEqual(['approvals', 'deploy', 'merge', 'push', 'retries']);
    expect(r.findings.find((f) => f.category === 'merge')!.line).toBe(5);
    expect(r.egressHosts).toEqual(['api.example.com', 'downloads.example.org']);
    expect(r.findings.some((f) => f.kind === 'credential')).toBe(true);
    expect(r.findings.some((f) => f.kind === 'install_instruction')).toBe(true);
    expect(r.findings.every((f) => f.severity === 'review')).toBe(true);
  });

  it('a secret-shaped value blocks, and the report never repeats it', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const r = scanPack([file('SKILL.md', `---\nname: x\ndescription: y\n---\nuse ${secret}\n`)], { secretShaped: (s) => s.includes('sk-ant-') });
    expect(r.blocked).toBe(true);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('what could not be read is incomplete analysis, and incomplete analysis blocks: binary, symlink, special, too large, a missing SKILL.md', () => {
    const r = scanPack([
      file('SKILL.md', '---\nname: x\ndescription: y\n---\n'),
      { path: 'blob.bin', kind: 'file', bytes: 10, executable: false, text: null, unread: 'binary' },
      { path: 'link.md', kind: 'symlink', bytes: 0, executable: false, text: null },
      { path: 'big.md', kind: 'file', bytes: 10_000_000, executable: false, text: null, unread: 'too_large' },
    ]);
    expect(r.status).toBe('incomplete');
    expect(r.blocked).toBe(true);
    expect(r.incomplete.map((i) => `${i.reason}:${i.path}`).sort()).toEqual(['binary:blob.bin', 'symlink:link.md', 'too_large:big.md']);
    expect(scanPack([file('README.md', 'hi')]).incomplete.map((i) => i.reason)).toContain('no_skill_md');
  });
});

// ---- resolution ----------------------------------------------------------------------------------------------------------

function pilotStack(): StackDocument {
  let doc = emptyStack();
  const step = (a: Parameters<typeof applyStackAction>[1]) => { const r = applyStackAction(doc, a); if (!r.ok) throw new Error(r.code); doc = r.doc; };
  step({ kind: 'component.upsert', path: '.', name: 'Feedback Board', targets: ['web', 'server'] });
  for (const [category, entryId] of [['frameworks', 'express'], ['frameworks', 'react'], ['testing', 'vitest']] as const) {
    step({ kind: 'item.add', path: '.', category, item: { kind: 'catalog', entryId, version: null } });
  }
  return doc;
}

const lib = (id: string): SkillVersion => SKILL_LIBRARY.find((v) => v.skillId === id)!;
const known = (vs: SkillVersion[], over: Partial<{ revoked: boolean; reviewed: boolean; blocked: boolean }> = {}) =>
  new Map(vs.map((v) => [v.versionId, { version: v, reviewed: true, blocked: false, revoked: false, ...over }]));
const bindAll = (vs: SkillVersion[]) => vs.map((v) => ({ skillId: v.skillId, binding: { versionId: v.versionId, roles: [], paths: [] } }));

const input = (over: Partial<SkillResolveInput> = {}): SkillResolveInput => ({
  task: { role: 'backend', allowedPaths: ['server', 'migrations', 'tests/backend'], acceptanceCheckIds: ['FB-01'] },
  stack: pilotStack(), bindings: bindAll([...SKILL_LIBRARY]), versions: known([...SKILL_LIBRARY]), destination: 'local', tools: WORKER_TOOLS, harness: 'claude-code',
  ...over,
});

describe('resolveSkills', () => {
  it('two tasks with different roles and paths get different sets, each only what is relevant', () => {
    const backend = resolveSkills(input());
    const frontend = resolveSkills(input({ task: { role: 'frontend', allowedPaths: ['src', 'tests/frontend'], acceptanceCheckIds: [] } }));
    expect(backend.delivered.map((d) => d.skillId)).toEqual(['express-api-routes', 'feedback-board-conventions', 'vitest-testing-practices']);
    expect(frontend.delivered.map((d) => d.skillId)).toEqual(['feedback-board-conventions', 'react-accessibility-checklist', 'vitest-testing-practices']);
    expect(backend.omitted.find((o) => o.skillId === 'react-accessibility-checklist')!.reason).toBe('not_relevant:role');
    expect(backend.delivered[0]).toMatchObject({ versionId: lib('express-api-routes').versionId, digest: lib('express-api-routes').digest });
  });

  it('nothing is delivered without a binding, and nothing without confirmed stack context', () => {
    expect(resolveSkills(input({ bindings: [] })).delivered).toEqual([]);
    const none = resolveSkills(input({ stack: emptyStack() }));
    expect(none.delivered.map((d) => d.skillId)).toEqual([]);
    expect(none.omitted.every((o) => o.reason.startsWith('not_relevant'))).toBe(true);
  });

  it("a binding's own role and path constraints narrow further", () => {
    const vs = [lib('feedback-board-conventions')];
    const r = resolveSkills(input({ bindings: [{ skillId: vs[0]!.skillId, binding: { versionId: vs[0]!.versionId, roles: ['frontend'], paths: [] } }], versions: known(vs) }));
    expect(r.delivered).toEqual([]);
    expect(r.omitted[0]!.reason).toBe('binding_constraint:role');
    const p = resolveSkills(input({ bindings: [{ skillId: vs[0]!.skillId, binding: { versionId: vs[0]!.versionId, roles: [], paths: ['src'] } }], versions: known(vs) }));
    expect(p.omitted[0]!.reason).toBe('binding_constraint:paths');
  });

  it('a relevant revoked, unreviewed or blocked version refuses the claim; an irrelevant one does not', () => {
    const vs = [lib('express-api-routes')];
    expect(resolveSkills(input({ bindings: bindAll(vs), versions: known(vs, { revoked: true }) })).refused).toEqual([{ skillId: 'express-api-routes', versionId: vs[0]!.versionId, reason: 'skill_revoked' }]);
    expect(resolveSkills(input({ bindings: bindAll(vs), versions: known(vs, { reviewed: false }) })).refused[0]!.reason).toBe('skill_not_reviewed');
    expect(resolveSkills(input({ bindings: bindAll(vs), versions: known(vs, { blocked: true }) })).refused[0]!.reason).toBe('skill_blocked');
    const front = resolveSkills(input({ task: { role: 'frontend', allowedPaths: ['src'], acceptanceCheckIds: [] }, bindings: bindAll(vs), versions: known(vs, { revoked: true }) }));
    expect(front.refused).toEqual([]);
    expect(resolveSkills(input({ bindings: [{ skillId: 'gone', binding: { versionId: 'gone@1.0.0', roles: [], paths: [] } }] })).refused[0]!.reason).toBe('skill_unavailable');
  });

  it('policy intersection: a pack needing a tool the worker lacks, or another harness, is left out; a pack never adds a tool', () => {
    const v = { ...lib('vitest-testing-practices'), tools: ['Read', 'WebFetch'] };
    const r = resolveSkills(input({ bindings: bindAll([v]), versions: known([v]) }));
    expect(r.delivered).toEqual([]);
    expect(r.omitted[0]!.reason).toBe('tool_not_granted:WebFetch');
    const h = resolveSkills(input({ harness: 'other-harness' }));
    expect(h.delivered).toEqual([]);
    expect(h.omitted.every((o) => o.reason === 'harness_unsupported' || o.reason.startsWith('not_relevant'))).toBe(true);
    expect(Object.keys(resolveSkills(input()))).toEqual(['delivered', 'omitted', 'refused', 'context', 'destination']);
  });

  it('a restricted pack reaches a local worker only; a cloud destination gets metadata only (an omission)', () => {
    const v: SkillVersion = { ...lib('vitest-testing-practices'), classification: 'restricted' };
    expect(resolveSkills(input({ bindings: bindAll([v]), versions: known([v]) })).delivered.length).toBe(1);
    const cloud = resolveSkills(input({ bindings: bindAll([v]), versions: known([v]), destination: 'cloud' }));
    expect(cloud.delivered).toEqual([]);
    expect(cloud.omitted[0]!.reason).toBe('content_device_only');
  });
});

describe('skillStates', () => {
  const v = lib('feedback-board-conventions');
  const ev = (over: Record<string, unknown> = {}) => ({ projectId: 'p1', versionId: v.versionId, digest: v.digest, outcome: 'passed' as const, ...over });
  it('Available until reviewed, Tested here only from a passed evaluation of this digest in this project, Blocked and Revoked stand alone', () => {
    expect(skillStates({ version: v, reviewed: false, blocked: false, revoked: false, evaluations: [], projectId: 'p1', enabledFor: [] })).toEqual(['available']);
    expect(skillStates({ version: v, reviewed: true, blocked: false, revoked: false, evaluations: [ev()], projectId: 'p1', enabledFor: ['t1'] })).toEqual(['reviewed', 'tested_here', 'enabled_for_task']);
    expect(skillStates({ version: v, reviewed: true, blocked: false, revoked: false, evaluations: [ev({ outcome: 'failed' }), ev({ projectId: 'other' }), ev({ digest: 'f'.repeat(64) })], projectId: 'p1', enabledFor: [] })).toEqual(['reviewed']);
    expect(skillStates({ version: v, reviewed: false, blocked: true, revoked: false, evaluations: [], projectId: 'p1', enabledFor: [] })).toEqual(['blocked']);
    expect(skillStates({ version: v, reviewed: true, blocked: false, revoked: true, evaluations: [ev()], projectId: 'p1', enabledFor: [] })).toEqual(['revoked']);
  });
});

describe('stack readiness: the skills axis', () => {
  const item = (entryId: string) => ({ kind: 'catalog' as const, entryId, version: null, origin: 'declared' as const, evidence: null });
  it('names the reviewed bindings whose triggers name the entry, and only those', () => {
    const skills = [{ name: 'express-api-routes', version: '1.0.0', entries: ['express'] }];
    const axis = readinessOf(item('express'), { skills }).find((a) => a.axis === 'skills')!;
    expect(axis).toMatchObject({ state: 'reviewed', label: 'Reviewed: express-api-routes 1.0.0' });
    expect(readinessOf(item('react'), { skills }).find((a) => a.axis === 'skills')!.state).toBe('none_reviewed');
  });
});

describe('fix round 1: scan limits, run instructions, unknown file types', () => {
  it('more files than a pack may hold, or more bytes, is a blocking pack_too_large finding', () => {
    const many = [file('SKILL.md', '---\nname: x\ndescription: y\n---\n'), ...Array.from({ length: 45 }, (_, i) => file(`references/r${i}.md`, 'ok\n'))];
    const r = scanPack(many);
    expect(r.blocked).toBe(true);
    expect(r.findings).toContainEqual(expect.objectContaining({ kind: 'pack_too_large', severity: 'blocking' }));
    const big = scanPack([file('SKILL.md', '---\nname: x\ndescription: y\n---\n'), ...Array.from({ length: 5 }, (_, i) => file(`references/r${i}.md`, 'a'.repeat(60_000)))]);
    expect(big.findings.some((f) => f.kind === 'pack_too_large')).toBe(true);
    expect(big.blocked).toBe(true);
  });

  it('an instruction to run a file, and a file of no known text type, are findings for review', () => {
    const r = scanPack([
      file('SKILL.md', '---\nname: x\ndescription: y\n---\nFirst run ./tool to prepare.\nThen bash scripts/setup.sh and node helpers/x.mjs.\n'),
      file('notes', 'plain words'),
      file('data.bin2', 'more words'),
    ]);
    expect(r.findings.filter((f) => f.kind === 'runs_pack_file').map((f) => f.line)).toEqual([5]);
    expect(r.findings.filter((f) => f.kind === 'unknown_file_type').map((f) => f.path).sort()).toEqual(['data.bin2', 'notes']);
    expect(r.findings.filter((f) => f.kind === 'runs_pack_file' || f.kind === 'unknown_file_type').every((f) => f.severity === 'review')).toBe(true);
    expect(r.blocked).toBe(false);
  });
});

describe('fix round 1: a third-party pack needs a scoped binding', () => {
  it('an unscoped third-party binding delivers nothing; a scoped one only to matching tasks; first-party packs keep their own triggers', () => {
    const tp: SkillVersion = { ...lib('vitest-testing-practices'), versionId: 'tp-x@1.0.0+abcdefabcdef', skillId: 'tp-x', origin: 'third_party', scope: 'project', triggers: { entries: [], roles: [], paths: [], actions: [] } };
    const unscoped = resolveSkills(input({ bindings: [{ skillId: 'tp-x', binding: { versionId: tp.versionId, roles: [], paths: [] } }], versions: known([tp]) }));
    expect(unscoped.delivered).toEqual([]);
    expect(unscoped.omitted[0]!.reason).toBe('binding_unscoped');
    const scoped = (task: SkillResolveInput['task']) => resolveSkills(input({ task, bindings: [{ skillId: 'tp-x', binding: { versionId: tp.versionId, roles: [], paths: ['server'] } }], versions: known([tp]) })).delivered.map((d) => d.skillId);
    expect(scoped({ role: 'backend', allowedPaths: ['server'], acceptanceCheckIds: [] })).toEqual(['tp-x']);
    expect(scoped({ role: 'frontend', allowedPaths: ['src'], acceptanceCheckIds: [] })).toEqual([]);
    expect(resolveSkills(input()).delivered.length).toBe(3);
  });
});
