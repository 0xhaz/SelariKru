import { z } from 'zod';
import { Sha256 } from './common.ts';
import { sha256Hex } from './sha256.ts';
import { stackInScope, type StackDocument } from './stack.ts';

export { sha256Hex } from './sha256.ts';

/**
 * The skill library (docs/architecture.md, owned skill library; docs/skill-candidates.md §5 and §7). A knowledge pack is reference text for a worker: instructions and
 * references, never authority. Each released version is immutable and named by a digest over its exact files. A project pins one version per skill in a binding; at claim the
 * resolver picks, from the bound, reviewed and unrevoked versions, only those whose triggers match the task's confirmed stack context, role, paths and actions, and only
 * within what policy already grants. A pack never adds a tool, a path, a grant or an approval. Platform policy text wins over any pack in the worker's instructions.
 */

export const SkillIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'expected a lowercase pack id');
export const SkillVersionTextSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,40}$/, 'expected a version');
export const SkillVersionIdSchema = z.string().min(3).max(140).regex(/^[a-z0-9][a-z0-9-]{0,62}@[0-9A-Za-z][0-9A-Za-z.+-]{0,70}$/, 'expected <pack>@<version>');
/** A file inside a pack: relative, no segment starting with a dot, at most four levels deep. Hidden directories (hooks, settings) are never part of a deliverable pack. */
export const SkillPathSchema = z.string().max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,3}$/, 'expected a relative pack path');
const Label = z.enum(['public', 'internal', 'restricted', 'secret']);
const Short = (n: number) => z.string().max(n);

/** What the worker may assume about its tools. The same list the runner launches with; a pack that needs another tool is left out, never granted it. */
export const WORKER_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
export const SKILL_HARNESSES = ['claude-code'] as const;
/** The harness a recorded model provider runs. Only Claude Code exists in this build. */
export const harnessForProvider = (provider: string): string => (provider === 'anthropic' ? 'claude-code' : provider);
export const SKILL_ACTIONS = ['implement', 'test'] as const;
export type SkillAction = (typeof SKILL_ACTIONS)[number];

export const SKILL_LIMITS = {
  /** Per pack. */
  maxFiles: 40,
  maxFileBytes: 64 * 1024,
  maxPackBytes: 256 * 1024,
  /** Per attempt: injecting every pack into every attempt wastes context and invites conflicts (skill-candidates.md §6). */
  maxPacksPerAttempt: 4,
  /** What an intake reads at most, delivered or not. */
  maxIntakeEntries: 200,
  maxIntakeDepth: 6,
} as const;

/** Where a pack goes in the attempt workspace: the project skills directory Claude Code reads. Read-only there, and outside every task's allowed paths. */
export const SKILL_WORKSPACE_ROOT = '.claude/skills';
export const skillDirOf = (skillId: string): string => `${SKILL_WORKSPACE_ROOT}/${skillId}`;
/** Where a worker writes a proposed pack change. Kept as a separate attempt artifact on the runner; never applied to the pack, never part of the change set. */
export const SKILL_NOTES_RELATIVE_PATH = '.selarikru/skill-notes.md';

export const SkillFileSchema = z.strictObject({ path: SkillPathSchema, sha256: Sha256, bytes: z.number().int().min(0).max(SKILL_LIMITS.maxFileBytes) });
export type SkillFile = z.infer<typeof SkillFileSchema>;

/** Each list empty means "any". All four must hold for a task. */
export const SkillTriggersSchema = z.strictObject({
  /** Stack catalog entry ids; any one confirmed in a component the task's paths reach. */
  entries: z.array(z.string().min(1).max(64)).max(20),
  roles: z.array(z.string().min(1).max(64)).max(10),
  /** Path prefixes; any one overlapping the task's allowed paths. */
  paths: z.array(z.string().min(1).max(120)).max(20),
  actions: z.array(z.enum(SKILL_ACTIONS)).max(SKILL_ACTIONS.length),
});
export type SkillTriggers = z.infer<typeof SkillTriggersSchema>;

export const SkillSourceSchema = z.discriminatedUnion('kind', [
  /** A first-party pack: this repository's path at a pinned commit. */
  z.strictObject({ kind: z.literal('repository'), repository: z.literal('selarikru'), path: Short(200), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  /** A third-party pack staged from a local directory the owner named. Nothing was fetched. */
  z.strictObject({ kind: z.literal('local_directory'), path: Short(1024), importedAt: z.iso.datetime(), importedBy: Short(200) }),
]);

export const SkillVersionSchema = z.strictObject({
  versionId: SkillVersionIdSchema,
  skillId: SkillIdSchema,
  name: Short(80).min(1),
  version: SkillVersionTextSchema,
  description: Short(400),
  origin: z.enum(['first_party', 'third_party']),
  /** Platform library, or private to one project (architecture.md, visibility scopes). */
  scope: z.enum(['platform', 'project']),
  license: z.strictObject({ spdx: Short(80).nullable(), file: SkillPathSchema.nullable() }),
  source: SkillSourceSchema,
  /** sha256 over the canonical file list (`packDigest`). */
  digest: Sha256,
  files: z.array(SkillFileSchema).min(1).max(SKILL_LIMITS.maxFiles),
  triggers: SkillTriggersSchema,
  /** Descriptive only: what the pack is about. Triggers decide delivery; policy decides permissions. */
  labels: z.strictObject({
    frameworks: z.array(z.strictObject({ entryId: z.string().min(1).max(64), version: Short(40).nullable() })).max(20),
    roles: z.array(Short(64)).max(10),
    focus: z.array(Short(64)).max(10),
  }),
  /** Tools the pack assumes the worker has. Checked against what policy grants; never added to it. */
  tools: z.array(Short(64)).max(20),
  harnesses: z.array(Short(64)).min(1).max(5),
  /** Where its content may go: restricted or secret content stays on a local worker. Metadata may go anywhere. */
  classification: Label,
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

/** The canonical list a digest is taken over: one `path` and `sha256` per line, sorted by path, after a version header. */
export function packDigest(files: readonly { readonly path: string; readonly sha256: string }[]): string {
  const lines = [...files].map((f) => `${f.path}\t${f.sha256}\n`).sort();
  return sha256Hex(`selarikru-pack-v1\n${lines.join('')}`);
}

// ---- the first-party library -------------------------------------------------------------------------------------------------------------

/** The commit that holds the exact bytes of every first-party pack below. A new version of a pack lives in a new directory, pinned at a later commit. */
export const SKILL_LIBRARY_PIN = '973851f9e59e79d503945c14787de99f5453f2bc';
/** The directory the first-party pack files live in. A function, so a browser bundle never resolves it. */
export const skillLibraryUrl = (): URL => new URL('../skill-library/', import.meta.url);

const MIT_LICENSE: SkillFile = { path: 'LICENSE', sha256: '9b811d3410d022c15cb7a0683b859c654bf9dd2842fb317ab4e353ba1043461d', bytes: 1079 };
const firstParty = (v: Omit<SkillVersion, 'versionId' | 'origin' | 'scope' | 'license' | 'source' | 'harnesses' | 'classification'> & { files: SkillFile[] }): SkillVersion => ({
  ...v,
  versionId: `${v.skillId}@${v.version}`,
  origin: 'first_party',
  scope: 'platform',
  license: { spdx: 'MIT', file: 'LICENSE' },
  source: { kind: 'repository', repository: 'selarikru', path: `packages/domain/skill-library/${v.skillId}/${v.version}`, commit: SKILL_LIBRARY_PIN },
  harnesses: ['claude-code'],
  classification: 'public',
});

export const SKILL_LIBRARY: readonly SkillVersion[] = [
  firstParty({
    skillId: 'express-api-routes', name: 'Express routes and tests', version: '1.0.0',
    description: 'Express 5 JSON routes backed by better-sqlite3: validation, error bodies, parameterised SQL, and route tests over a real port with Vitest.',
    digest: '7b8246ac599b229f20a2cd782475e250f23030f7d7d156f726919ddb5dc0b8ab',
    files: [
      MIT_LICENSE,
      { path: 'SKILL.md', sha256: '63e25010b9dd5943631a5192f4bf48d3d7a6655882d07aaff29305af9f057db5', bytes: 2329 },
      { path: 'references/testing.md', sha256: 'a7c4e27fe8ca4fca56e2757b86ecd9f8eabba798e6f8c5457f92bf40d1928c0a', bytes: 1652 },
      { path: 'references/validation.md', sha256: 'ec39e9e788d953a81cab459ea3215675a0772753a0f6a83d14c06e55bc2444fb', bytes: 2009 },
    ],
    triggers: { entries: ['express'], roles: ['backend', 'api', 'fullstack'], paths: [], actions: [] },
    labels: { frameworks: [{ entryId: 'express', version: '5.x' }, { entryId: 'sqlite', version: null }, { entryId: 'vitest', version: null }], roles: ['backend'], focus: ['api', 'persistence', 'testing'] },
    tools: ['Read', 'Edit', 'Bash'],
  }),
  firstParty({
    skillId: 'feedback-board-conventions', name: 'Feedback Board conventions', version: '1.0.0',
    description: 'How the Feedback Board starter is laid out, what its contract fixes, and the checks to run before finishing.',
    digest: 'cd3ac3b99e2cd673fe0aad6f93616c44d01d0b590e7ca2b035bf2ed47898d4c9',
    files: [
      MIT_LICENSE,
      { path: 'SKILL.md', sha256: '9fdd6d244388e8be6ba43496564445b2055bf838905364ad553889493d6551f7', bytes: 2148 },
      { path: 'references/checks.md', sha256: 'ff7faa0293736d6b2d7fc0bde8455e3db83f288c53158774d814042694745bcd', bytes: 841 },
      { path: 'references/layout.md', sha256: '8cb4c07043f665f1582da2ba1060fd31834767ffa038a2063c9cbd8e9f19e65b', bytes: 1607 },
    ],
    triggers: { entries: ['express', 'react'], roles: [], paths: [], actions: [] },
    labels: { frameworks: [{ entryId: 'express', version: '5.3.0' }, { entryId: 'react', version: '19.3.1' }, { entryId: 'vite', version: '8.3.6' }, { entryId: 'vitest', version: '5.1.0' }], roles: ['backend', 'frontend'], focus: ['conventions'] },
    tools: ['Read', 'Bash'],
  }),
  firstParty({
    skillId: 'react-accessibility-checklist', name: 'React accessibility checklist', version: '1.0.0',
    description: 'Accessible names, state, keyboard order and safe text for React forms and lists, and testing that logic without a browser.',
    digest: '755f8e3e1a44b5db6afa8c1a888e25523f1431f412112a6b16959ce27892124b',
    files: [
      MIT_LICENSE,
      { path: 'SKILL.md', sha256: '19dc57d7a19ba28f0390d0294b42bc3d3ace554c8b6685824fa53e7f94d1058e', bytes: 2235 },
      { path: 'references/testing.md', sha256: 'a8eb4848ee13fdb36ef9a3318a1d134326d19fa24b81a1f874578a159c6396a3', bytes: 1044 },
    ],
    triggers: { entries: ['react'], roles: ['frontend', 'ui', 'fullstack'], paths: [], actions: [] },
    labels: { frameworks: [{ entryId: 'react', version: '19.x' }], roles: ['frontend'], focus: ['accessibility', 'ui'] },
    tools: ['Read', 'Edit'],
  }),
  firstParty({
    skillId: 'vitest-testing-practices', name: 'Vitest testing practices', version: '1.0.0',
    description: 'Deterministic Vitest tests that check behaviour: boundaries, controlled time, isolated state, no fixed waits.',
    digest: '97457f692e72a7013936cd45aa89c4f72aa30abf0bc2302dee9b45ac7b0fe276',
    files: [
      MIT_LICENSE,
      { path: 'SKILL.md', sha256: '5cf626214de1171583957b32235c436c01e73ac4b486a7ff4a7b22d4eff00791', bytes: 1658 },
      { path: 'references/patterns.md', sha256: '89894c085425cd4b7e07fd2ab300cecbe211d1dfd8e3b5910399b511f1c8ff80', bytes: 1125 },
    ],
    triggers: { entries: ['vitest'], roles: [], paths: [], actions: ['test'] },
    labels: { frameworks: [{ entryId: 'vitest', version: '5.x' }], roles: [], focus: ['testing'] },
    tools: ['Read', 'Bash'],
  }),
];

export const libraryVersion = (versionId: string): SkillVersion | undefined => SKILL_LIBRARY.find((v) => v.versionId === versionId);

// ---- metadata parsing ---------------------------------------------------------------------------------------------------------------------

export interface SkillFrontmatter {
  readonly name: string | null;
  readonly description: string | null;
  readonly version: string | null;
  readonly license: string | null;
  readonly allowedTools: readonly string[];
  /** Every top-level key the header declares, in order. */
  readonly keys: readonly string[];
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const listOf = (s: string): string[] => {
  const t = s.trim();
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner.split(',').map(unquote).filter((x) => x !== '');
};

/** The YAML header of a SKILL.md, read as plain `key: value` lines. Nothing in it is evaluated. Null when the file does not start with a header. */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const keys: string[] = [];
  let current: string | null = null;
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      current = top[1]!;
      if (!keys.includes(current)) keys.push(current);
      values.set(current, top[2]!);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && current !== null) lists.set(current, [...(lists.get(current) ?? []), unquote(item[1]!)]);
  }
  const value = (k: string): string | null => { const v = values.get(k); return v === undefined || v.trim() === '' ? null : unquote(v).slice(0, 400); };
  const tools = values.get('allowed-tools');
  return {
    name: value('name'), description: value('description'), version: value('version'), license: value('license'),
    allowedTools: (tools !== undefined && tools.trim() !== '' ? listOf(tools) : lists.get('allowed-tools') ?? []).slice(0, 20),
    keys,
  };
}

// ---- static scan -------------------------------------------------------------------------------------------------------------------------

/** One entry an intake listed. `text` is the file as UTF-8 when it was read; it is data to scan, never something to run. */
export interface PackEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'special';
  readonly bytes: number;
  readonly executable: boolean;
  readonly text: string | null;
  /** Why the text was not read. */
  readonly unread?: 'too_large' | 'binary' | 'unreadable' | 'depth' | 'limit' | 'unsafe_path';
}

export const SKILL_FINDING_KINDS = ['script', 'hook', 'egress', 'credential', 'policy_conflict', 'install_instruction'] as const;
export const SKILL_POLICY_CATEGORIES = ['merge', 'push', 'deploy', 'secrets', 'approvals', 'retries', 'data_export', 'browsing'] as const;
export type SkillPolicyCategory = (typeof SKILL_POLICY_CATEGORIES)[number];

export const SkillScanFindingSchema = z.strictObject({
  kind: z.enum(SKILL_FINDING_KINDS),
  /** `blocking`: the pack is Blocked. `review`: an owner sees it before marking the version Reviewed. */
  severity: z.enum(['blocking', 'review']),
  path: Short(200),
  line: z.number().int().min(1).nullable(),
  category: z.enum(SKILL_POLICY_CATEGORIES).nullable(),
  detail: Short(240),
});
export type SkillScanFinding = z.infer<typeof SkillScanFindingSchema>;

export const SKILL_INCOMPLETE_REASONS = ['too_large', 'binary', 'unreadable', 'depth', 'limit', 'unsafe_path', 'symlink', 'special', 'no_skill_md', 'no_frontmatter'] as const;
export const SkillScanReportSchema = z.strictObject({
  analyzer: z.literal('selarikru-static-scan'),
  analyzerVersion: z.literal('1'),
  /** `incomplete`: something could not be analysed. Missing analysis is never a pass, so the pack is Blocked. */
  status: z.enum(['complete', 'incomplete']),
  blocked: z.boolean(),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  findings: z.array(SkillScanFindingSchema).max(500),
  egressHosts: z.array(Short(253)).max(50),
  incomplete: z.array(z.strictObject({ path: Short(200), reason: z.enum(SKILL_INCOMPLETE_REASONS) })).max(200),
});
export type SkillScanReport = z.infer<typeof SkillScanReportSchema>;

const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|ksh|py|pyc|rb|pl|php|lua|js|mjs|cjs|jsx|ts|mts|cts|tsx|ps1|psm1|bat|cmd|com|exe|bin|so|dylib|dll|jar|wasm|applescript|scpt)$/i;
const POLICY: readonly [SkillPolicyCategory, RegExp, string][] = [
  ['merge', /\bgh\s+pr\s+merge\b|\bgit\s+merge\b|\bauto-?merge\b|\bmerge\s+(?:the\s+|your\s+|this\s+)?(?:pull\s+request|pr|branch|change)s?\b/i, 'Talks about merging. Agents never merge; a person merges on GitHub.'],
  ['push', /\bgit\s+push\b|\bpush\s+(?:it\s+)?(?:to\s+)?(?:main|master|origin|the\s+(?:remote|branch))\b|--force-with-lease|\bforce[- ]push\b/i, 'Talks about pushing. Workers do not push; the control plane publishes reviewed changes.'],
  ['deploy', /\bdeploy(?:s|ed|ing|ment)?\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bvercel\s+--prod\b/i, 'Talks about deployment. Production and deployment are denied, with no approval bypass.'],
  ['secrets', /\b(?:print|echo|cat|export|upload|send|log|share|commit|paste)\b[^\n]{0,40}\b(?:secrets?|tokens?|passwords?|credentials?|api[ _-]?keys?)\b|\bcat\s+\S*\.env\b/i, 'Asks to read, print or move credentials. Secrets never enter prompts, logs or events.'],
  ['approvals', /\bapprove\s+(?:your|its|their|the\s+agent'?s?)\s+own\b|\bauto-?approve\b|\bskip\s+(?:the\s+)?(?:approvals?|reviews?)\b|--dangerously-skip-permissions\b|\bbypass\s*permissions\b|\bbypassPermissions\b/i, 'Asks to skip or self-grant approvals. Only a person grants an approval.'],
  ['retries', /\b(?:retry|retries|keep\s+(?:trying|retrying)|loop)\b[^\n]{0,40}\b(?:forever|indefinitely|infinitely|until\s+(?:it\s+)?(?:passes|succeeds|works))\b|\bwhile\s+true\b|\bwhile\s*\(\s*true\s*\)/i, 'Asks for unbounded retries. Repairs are bounded by policy.'],
  ['data_export', /\b(?:upload|exfiltrate|send|post|copy)\b[^\n]{0,40}\b(?:database|repository|codebase|user\s+data|customer\s+data)\b[^\n]{0,30}\b(?:to|external)\b/i, 'Asks to move project data elsewhere. Data destinations are set by policy.'],
  ['browsing', /\bWebFetch\b|\bWebSearch\b|\bbrowse\s+the\s+web\b|\bsearch\s+the\s+web\b/i, 'Asks for web access. Workers have no web tools unless policy grants them.'],
];
const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b|\bnpx\s+\S|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bcurl\b[^\n|]*\|\s*(?:ba|z)?sh\b/i;
const CREDENTIAL = /\b(?:api[ _-]?keys?|access[ _-]?tokens?|auth[ _-]?tokens?|secret[ _-]?keys?|passwords?|credentials?|private[ _-]?keys?|bearer\s+tokens?)\b|(?:^|[\s/`'"])\.env\b/i;
const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[:/?#\s'")\]`]|$)/gi;
const FETCH_HOST = /\b(?:curl|wget)\s+(?:-{1,2}\S+\s+)*(?!https?:)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi;

const reportPath = (p: string): string => p.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\uFEFF]/g, '?').slice(0, 200) || '?';

export interface ScanOptions {
  /** True when a line holds a value shaped like a credential. The finding names the line, never the value. */
  readonly secretShaped?: (line: string) => boolean;
}

/**
 * Scans a pack's listed entries without executing anything: it reads the text it is given and nothing else. Scripts, hooks and secret-shaped values block the pack;
 * egress hosts, credential mentions, install instructions and text that conflicts with platform policy are findings for the reviewer. Whatever could not be read makes
 * the analysis incomplete, and incomplete analysis blocks.
 */
export function scanPack(entries: readonly PackEntry[], opts: ScanOptions = {}): SkillScanReport {
  const findings: SkillScanFinding[] = [];
  const incomplete: { path: string; reason: (typeof SKILL_INCOMPLETE_REASONS)[number] }[] = [];
  const hosts = new Set<string>();
  const add = (f: Omit<SkillScanFinding, 'path'> & { path: string }) => { if (findings.length < 500) findings.push({ ...f, path: reportPath(f.path) }); };
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.kind === 'directory') {
      const segs = e.path.split('/');
      if (segs.some((s) => s === 'hooks' || s === '.husky' || s === '.githooks')) add({ kind: 'hook', severity: 'blocking', path: e.path, line: null, category: null, detail: 'A hooks directory. Hooks run commands, and packs run nothing.' });
      continue;
    }
    if (e.kind === 'symlink' || e.kind === 'special') { incomplete.push({ path: reportPath(e.path), reason: e.kind }); continue; }
    files += 1;
    bytes += e.bytes;
    const base = e.path.split('/').at(-1) ?? e.path;
    const segs = e.path.split('/');
    if (e.unread !== undefined) incomplete.push({ path: reportPath(e.path), reason: e.unread });
    if (SCRIPT_EXT.test(base) || e.executable || e.text?.startsWith('#!') === true) {
      add({ kind: 'script', severity: 'blocking', path: e.path, line: null, category: null, detail: 'Executable content. Packs in this library carry instructions and references only.' });
    }
    const hook = base === 'hooks.json' || base === '.mcp.json' || segs.slice(0, -1).some((s) => s === 'hooks' || s === '.husky' || s === '.githooks')
      || ((base === 'settings.json' || base === 'settings.local.json') && /"hooks"\s*:/.test(e.text ?? ''))
      || (base === 'package.json' && packageRunsScripts(e.text));
    if (hook) add({ kind: 'hook', severity: 'blocking', path: e.path, line: null, category: null, detail: base === '.mcp.json' ? 'Declares MCP servers, which start processes.' : 'Declares a hook or an install script, which would run commands.' });
    if (e.text === null) continue;
    if (e.path === 'SKILL.md' && parseSkillFrontmatter(e.text)?.keys.includes('hooks') === true) add({ kind: 'hook', severity: 'blocking', path: e.path, line: null, category: null, detail: 'The header declares hooks, which would run commands.' });
    const seen = new Set<string>();
    const lines = e.text.split(/\r?\n/).slice(0, 5000);
    lines.forEach((line, i) => {
      const at = i + 1;
      const once = (key: string, f: () => void) => { if (!seen.has(key)) { seen.add(key); f(); } };
      if (opts.secretShaped?.(line) === true) once(`secret:${at}`, () => add({ kind: 'credential', severity: 'blocking', path: e.path, line: at, category: null, detail: 'Holds a value shaped like a credential. It is not repeated here.' }));
      for (const [category, re, detail] of POLICY) if (re.test(line)) once(`policy:${category}`, () => add({ kind: 'policy_conflict', severity: 'review', path: e.path, line: at, category, detail }));
      if (INSTALL.test(line)) once('install', () => add({ kind: 'install_instruction', severity: 'review', path: e.path, line: at, category: null, detail: 'Gives an install instruction. Nothing in a pack is ever run; installs follow the repository lockfile.' }));
      if (CREDENTIAL.test(line)) once('credential', () => add({ kind: 'credential', severity: 'review', path: e.path, line: at, category: null, detail: 'Mentions credentials. A pack carries none and grants access to none.' }));
      for (const re of [URL_HOST, FETCH_HOST]) {
        for (const m of line.matchAll(re)) {
          const host = m[1]!.toLowerCase().replace(/\.+$/, '');
          if (hosts.size < 50 && !hosts.has(host)) {
            hosts.add(host);
            add({ kind: 'egress', severity: 'review', path: e.path, line: at, category: null, detail: `Mentions ${host.slice(0, 120)}. A pack grants no network access.` });
          }
        }
      }
    });
  }
  const skill = entries.find((e) => e.path === 'SKILL.md' && e.kind === 'file');
  if (!skill) incomplete.push({ path: 'SKILL.md', reason: 'no_skill_md' });
  else if (skill.text !== null && parseSkillFrontmatter(skill.text) === null) incomplete.push({ path: 'SKILL.md', reason: 'no_frontmatter' });
  const status = incomplete.length > 0 ? 'incomplete' : 'complete';
  return {
    analyzer: 'selarikru-static-scan', analyzerVersion: '1', status, blocked: status === 'incomplete' || findings.some((f) => f.severity === 'blocking'),
    files, bytes, findings, egressHosts: [...hosts].sort(), incomplete: incomplete.slice(0, 200),
  };
}

function packageRunsScripts(text: string | null): boolean {
  if (text === null) return true;
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return typeof scripts === 'object' && scripts !== null && Object.keys(scripts).length > 0;
  } catch {
    return /"scripts"\s*:/.test(text);
  }
}

// ---- states ----------------------------------------------------------------------------------------------------------------------------

export const SKILL_STATES = ['available', 'reviewed', 'tested_here', 'enabled_for_task', 'blocked', 'revoked'] as const;
export type SkillStateId = (typeof SKILL_STATES)[number];
export const SKILL_STATE_LABELS: Readonly<Record<SkillStateId, string>> = {
  available: 'Available', reviewed: 'Reviewed', tested_here: 'Tested here', enabled_for_task: 'Enabled for this task', blocked: 'Blocked', revoked: 'Revoked',
};

export const SkillEvaluationSchema = z.strictObject({
  evaluationId: z.string().min(1).max(100),
  projectId: z.string().min(1).max(200),
  versionId: SkillVersionIdSchema,
  digest: Sha256,
  harness: z.strictObject({ id: Short(64), version: Short(40).nullable() }),
  runtime: Short(80),
  /** The fixture and conditions it ran under, such as "baseline vs one pack, Feedback Board backend task". */
  conditions: Short(400),
  outcome: z.enum(['passed', 'failed', 'error']),
  results: z.strictObject({ cases: z.number().int().min(0), passed: z.number().int().min(0) }),
  cost: z.strictObject({ usd: z.number().min(0).nullable(), basis: z.enum(['observed', 'estimated', 'unavailable']) }),
  latencySeconds: z.number().min(0).nullable(),
  recordedAt: z.iso.datetime(),
  recordedBy: Short(200),
});
export type SkillEvaluation = z.infer<typeof SkillEvaluationSchema>;

export interface SkillStateInput {
  readonly version: SkillVersion;
  readonly reviewed: boolean;
  readonly blocked: boolean;
  readonly revoked: boolean;
  readonly evaluations: readonly Pick<SkillEvaluation, 'projectId' | 'versionId' | 'digest' | 'outcome'>[];
  readonly projectId: string;
  /** Tasks whose current attempt received this version. */
  readonly enabledFor: readonly string[];
}

/**
 * The states that hold for one version in one project, as separate facts. Revoked and Blocked stand alone: nothing else about such a version is usable. Tested here comes only from
 * a recorded evaluation in this project that passed for these exact bytes; a missing or failed evaluation is not a pass, and a source claim is never one.
 */
export function skillStates(s: SkillStateInput): SkillStateId[] {
  if (s.revoked) return ['revoked'];
  if (s.blocked) return ['blocked'];
  const out: SkillStateId[] = [s.reviewed ? 'reviewed' : 'available'];
  if (s.evaluations.some((e) => e.projectId === s.projectId && e.versionId === s.version.versionId && e.digest === s.version.digest && e.outcome === 'passed')) out.push('tested_here');
  if (s.enabledFor.length > 0) out.push('enabled_for_task');
  return out;
}

// ---- bindings and resolution ---------------------------------------------------------------------------------------------------------------

/** A project's pin of one version of one skill, with the roles and paths it may serve. Empty lists: no further constraint than the pack's own triggers. */
export const SkillBindingSchema = z.strictObject({
  versionId: SkillVersionIdSchema,
  roles: z.array(z.string().min(1).max(64)).max(10),
  paths: z.array(z.string().min(1).max(120)).max(20),
});
export type SkillBinding = z.infer<typeof SkillBindingSchema>;

export const ResolvedSkillSchema = z.strictObject({
  skillId: SkillIdSchema,
  versionId: SkillVersionIdSchema,
  name: Short(80),
  version: SkillVersionTextSchema,
  digest: Sha256,
  origin: z.enum(['first_party', 'third_party']),
  scope: z.enum(['platform', 'project']),
  classification: Label,
  /** Where the runner mounts it, read-only. */
  dir: Short(120),
});
export type ResolvedSkill = z.infer<typeof ResolvedSkillSchema>;
export const SkillOmissionSchema = z.strictObject({ skillId: Short(64), versionId: Short(140), reason: Short(120) });

/** What an attempt received, recorded in the claim's transaction: each delivered version and its digest, and why every other bound pack was left out. Metadata only. */
export const SkillExecutionRecordSchema = z.strictObject({
  attemptId: z.string().min(1),
  taskId: z.string().min(1),
  revision: z.number().int().min(1),
  destination: z.enum(['local', 'cloud']),
  harness: Short(64),
  delivered: z.array(ResolvedSkillSchema).max(SKILL_LIMITS.maxPacksPerAttempt),
  omitted: z.array(SkillOmissionSchema).max(200),
  context: z.strictObject({ entries: z.array(Short(64)).max(200), actions: z.array(z.enum(SKILL_ACTIONS)) }),
  recordedAt: z.iso.datetime(),
});
export type SkillExecutionRecord = z.infer<typeof SkillExecutionRecordSchema>;

export interface KnownVersion {
  readonly version: SkillVersion;
  readonly reviewed: boolean;
  readonly blocked: boolean;
  readonly revoked: boolean;
}

export interface SkillResolveInput {
  readonly task: { readonly role: string; readonly allowedPaths: readonly string[]; readonly acceptanceCheckIds: readonly string[] };
  /** The project's confirmed stack. Detections the owner has not confirmed are not context. */
  readonly stack: StackDocument | null;
  readonly bindings: readonly { readonly skillId: string; readonly binding: SkillBinding }[];
  readonly versions: ReadonlyMap<string, KnownVersion>;
  readonly destination: 'local' | 'cloud';
  /** What policy grants the worker. A pack is checked against it and never adds to it. */
  readonly tools: readonly string[];
  readonly harness: string;
}

export interface SkillResolution {
  readonly delivered: ResolvedSkill[];
  readonly omitted: { skillId: string; versionId: string; reason: string }[];
  /** A relevant binding whose version cannot start new work. The claim is refused, visibly, rather than run without it. */
  readonly refused: { skillId: string; versionId: string; reason: 'skill_revoked' | 'skill_not_reviewed' | 'skill_blocked' | 'skill_unavailable' }[];
  readonly context: { entries: string[]; actions: SkillAction[] };
}

const overlaps = (prefixes: readonly string[], paths: readonly string[]): boolean =>
  prefixes.some((raw) => {
    const p = raw.replace(/\/+$/, '');
    return paths.some((a0) => { const a = a0.replace(/\/+$/, ''); return p === '' || p === '.' || a === p || a.startsWith(`${p}/`) || p.startsWith(`${a}/`); });
  });

/** What a task needs done: it changes code when it has paths, and it is test work when it carries checks or test paths. */
export function taskActions(task: SkillResolveInput['task']): SkillAction[] {
  const out: SkillAction[] = [];
  if (task.allowedPaths.length > 0) out.push('implement');
  if (task.acceptanceCheckIds.length > 0 || task.allowedPaths.some((p) => /(?:^|\/)(?:tests?|__tests__|specs?|e2e)(?:\/|$)/.test(p))) out.push('test');
  return out;
}

/** The catalog entries confirmed in every component the task's paths reach (the repository root reaches every task). */
export function taskStackEntries(stack: StackDocument | null, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of stack?.components ?? []) {
    if (!stackInScope(c.path, paths)) continue;
    for (const s of Object.values(c.categories)) if (s.state === 'selected') for (const i of s.items) if (i.kind === 'catalog') out.add(i.entryId);
  }
  return [...out].sort();
}

/**
 * Confirmed context, then required actions, then bound versions whose triggers match, then the policy intersection. Only `delivered` goes to the worker. Nothing here returns
 * a tool, path, grant or approval: a pack's text, whatever it says, has no field to say it in.
 */
export function resolveSkills(input: SkillResolveInput): SkillResolution {
  const entries = taskStackEntries(input.stack, input.task.allowedPaths);
  const actions = taskActions(input.task);
  const delivered: ResolvedSkill[] = [];
  const omitted: SkillResolution['omitted'] = [];
  const refused: SkillResolution['refused'] = [];
  for (const { skillId, binding } of [...input.bindings].sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0))) {
    const skip = (reason: string) => omitted.push({ skillId, versionId: binding.versionId, reason });
    if (binding.roles.length > 0 && !binding.roles.includes(input.task.role)) { skip('binding_constraint:role'); continue; }
    if (binding.paths.length > 0 && !overlaps(binding.paths, input.task.allowedPaths)) { skip('binding_constraint:paths'); continue; }
    const known = input.versions.get(binding.versionId);
    if (!known || known.version.skillId !== skillId) { refused.push({ skillId, versionId: binding.versionId, reason: 'skill_unavailable' }); continue; }
    const v = known.version;
    const t = v.triggers;
    if (t.entries.length > 0 && !t.entries.some((e) => entries.includes(e))) { skip('not_relevant:stack'); continue; }
    if (t.roles.length > 0 && !t.roles.includes(input.task.role)) { skip('not_relevant:role'); continue; }
    if (t.paths.length > 0 && !overlaps(t.paths, input.task.allowedPaths)) { skip('not_relevant:paths'); continue; }
    if (t.actions.length > 0 && !t.actions.some((a) => actions.includes(a))) { skip('not_relevant:action'); continue; }
    if (known.revoked) { refused.push({ skillId, versionId: v.versionId, reason: 'skill_revoked' }); continue; }
    if (known.blocked) { refused.push({ skillId, versionId: v.versionId, reason: 'skill_blocked' }); continue; }
    if (!known.reviewed) { refused.push({ skillId, versionId: v.versionId, reason: 'skill_not_reviewed' }); continue; }
    if (!v.harnesses.includes(input.harness)) { skip('harness_unsupported'); continue; }
    const missing = v.tools.find((tool) => !input.tools.includes(tool));
    if (missing !== undefined) { skip(`tool_not_granted:${missing}`); continue; }
    if (input.destination === 'cloud' && (v.classification === 'restricted' || v.classification === 'secret')) { skip('content_device_only'); continue; }
    if (delivered.length >= SKILL_LIMITS.maxPacksPerAttempt) { skip('limit'); continue; }
    delivered.push({ skillId, versionId: v.versionId, name: v.name, version: v.version, digest: v.digest, origin: v.origin, scope: v.scope, classification: v.classification, dir: skillDirOf(skillId) });
  }
  return { delivered, omitted, refused, context: { entries, actions } };
}

// ---- delivery ----------------------------------------------------------------------------------------------------------------------------

/** One pack as the runner receives it with a lease: the recorded identity and digest, and the content to check against them before anything starts. */
export const DeliveredSkillPackSchema = z.strictObject({
  skillId: SkillIdSchema,
  versionId: SkillVersionIdSchema,
  name: Short(80),
  version: SkillVersionTextSchema,
  digest: Sha256,
  dir: Short(120),
  files: z.array(z.strictObject({ path: SkillPathSchema, content: z.string().max(SKILL_LIMITS.maxFileBytes) })).min(1).max(SKILL_LIMITS.maxFiles),
});
export type DeliveredSkillPack = z.infer<typeof DeliveredSkillPackSchema>;
export const DeliveredSkillsSchema = z.strictObject({ packs: z.array(DeliveredSkillPackSchema).max(SKILL_LIMITS.maxPacksPerAttempt) });
export type DeliveredSkills = z.infer<typeof DeliveredSkillsSchema>;

/** The digest of what arrived, from the bytes themselves. It must equal the recorded digest, or nothing starts. */
export const deliveredDigest = (pack: Pick<DeliveredSkillPack, 'files'>): string => packDigest(pack.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })));
export const verifyDeliveredPack = (pack: DeliveredSkillPack): boolean => pack.dir === skillDirOf(pack.skillId) && new Set(pack.files.map((f) => f.path)).size === pack.files.length && deliveredDigest(pack) === pack.digest;
