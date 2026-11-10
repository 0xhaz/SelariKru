import { SKILL_STATE_LABELS, type SkillStateId } from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';
import type { AttemptSkillsView, SkillBindingView, SkillCatalogEntryView, SkillsView } from '@selarikru/view-protocol';

/** Presentation of the skill library. Every state is its own chip with its own words; nothing is collapsed into one badge or read as tested without an evaluation. */

export const STATE_TONE: Readonly<Record<SkillStateId, Tone>> = {
  available: 'neutral', reviewed: 'success', tested_here: 'success', enabled_for_task: 'active', blocked: 'danger', revoked: 'danger',
};

export interface StateChip { readonly id: SkillStateId; readonly label: string; readonly tone: Tone }
export interface FindingRow { readonly key: string; readonly severity: 'Blocks' | 'For review'; readonly where: string; readonly detail: string }

export interface PackRow {
  readonly versionId: string;
  readonly skillId: string;
  readonly title: string;
  readonly description: string;
  readonly origin: string;
  readonly states: readonly StateChip[];
  readonly digest: string | null;
  readonly files: string;
  readonly source: string;
  readonly license: string;
  readonly tools: string;
  readonly triggers: string;
  readonly scan: string | null;
  readonly findings: readonly FindingRow[];
  /** Findings an owner must acknowledge before marking this version reviewed. */
  readonly reviewFindings: number;
  readonly binding: string;
  readonly bound: boolean;
  readonly enabledFor: string | null;
  readonly revocation: string | null;
  readonly canReview: boolean;
  readonly canBind: boolean;
  readonly canRevoke: boolean;
}

const list = (xs: readonly string[], none = 'any'): string => (xs.length === 0 ? none : xs.join(', '));
export const shortDigest = (d: string): string => `${d.slice(0, 12)}…`;

function sourceText(e: SkillCatalogEntryView): string {
  const s = e.source as { kind?: string; path?: string; commit?: string; importedAt?: string; importedBy?: string } | null;
  if (s?.kind === 'repository') return `This repository, ${s.path} at commit ${String(s.commit).slice(0, 12)}`;
  if (s?.kind === 'local_directory') return `Staged from the local directory ${s.path} by ${s.importedBy}. Nothing was fetched, installed or run.`;
  return 'Unknown';
}

function bindingText(b: SkillBindingView | undefined, versionId: string): { text: string; bound: boolean } {
  if (!b || b.desired === null) return { text: 'Not bound to this project', bound: false };
  if (b.desired.versionId !== versionId) return { text: `Another version is bound: ${b.desired.versionId}`, bound: false };
  const limits = [b.desired.roles.length > 0 ? `roles ${b.desired.roles.join(', ')}` : '', b.desired.paths.length > 0 ? `paths ${b.desired.paths.join(', ')}` : ''].filter(Boolean).join('; ');
  return { text: `Bound at revision ${b.desiredRevision}${limits ? `, only for ${limits}` : ', for every task its triggers match'} · ${b.state === 'applied' ? 'in force' : 'applying'}`, bound: true };
}

export function packRow(e: SkillCatalogEntryView, bindings: readonly SkillBindingView[]): PackRow {
  const b = bindingText(bindings.find((x) => x.skillId === e.skillId), e.versionId);
  const states = e.states.map((id) => ({ id, label: SKILL_STATE_LABELS[id], tone: STATE_TONE[id] }));
  const has = (id: SkillStateId) => e.states.includes(id);
  const scan = e.scan;
  return {
    versionId: e.versionId, skillId: e.skillId, title: `${e.name} ${e.version}`, description: e.description,
    origin: e.origin === 'first_party' ? 'First party · platform library · published reviewed' : 'Third party · private to this project',
    states, digest: e.digest, files: `${e.files.length} file${e.files.length === 1 ? '' : 's'}, ${e.files.reduce((n, f) => n + f.bytes, 0)} bytes`,
    source: sourceText(e), license: e.license?.spdx ? `${e.license.spdx}${e.license.file ? ` (${e.license.file})` : ''}` : 'Not declared',
    tools: list(e.tools, 'none'),
    triggers: e.triggers ? `stack ${list(e.triggers.entries)} · roles ${list(e.triggers.roles)} · paths ${list(e.triggers.paths)} · actions ${list(e.triggers.actions)}` : 'Unknown',
    scan: scan === null ? null : `Static scan ${scan.status === 'complete' ? 'complete' : 'incomplete: missing analysis is not a pass'} · ${scan.files} files · ${scan.findings.length} finding${scan.findings.length === 1 ? '' : 's'}${scan.egressHosts.length > 0 ? ` · mentions ${scan.egressHosts.join(', ')}` : ''}`,
    findings: [
      ...(scan?.findings ?? []).map((f, i) => ({ key: `f${i}`, severity: f.severity === 'blocking' ? 'Blocks' as const : 'For review' as const, where: `${f.path}${f.line !== null ? `:${f.line}` : ''}`, detail: f.detail })),
      ...(scan?.incomplete ?? []).map((x, i) => ({ key: `i${i}`, severity: 'Blocks' as const, where: x.path, detail: `Not analysed: ${x.reason.replace(/_/g, ' ')}.` })),
    ],
    reviewFindings: (scan?.findings ?? []).filter((f) => f.severity === 'review').length,
    binding: b.text, bound: b.bound,
    enabledFor: e.enabledFor.length > 0 ? e.enabledFor.map((x) => x.taskId).join(', ') : null,
    revocation: e.revocation ? `Revoked by ${e.revocation.by}: ${e.revocation.reason}. New work cannot start with it; an attempt already running keeps it.` : null,
    canReview: e.origin === 'third_party' && has('available'),
    canBind: (has('reviewed')) && !b.bound,
    canRevoke: !has('revoked') && !has('blocked'),
  };
}

export const packRows = (v: SkillsView): PackRow[] => v.catalog.map((e) => packRow(e, v.bindings));
export const bindingOf = (v: SkillsView, skillId: string): SkillBindingView | undefined => v.bindings.find((b) => b.skillId === skillId);

export interface AttemptPackRow { readonly versionId: string; readonly title: string; readonly digest: string; readonly dir: string; readonly revoked: boolean }

/** The drawer's list: what this attempt received at claim, with the digest it was checked against, and which have been revoked since. */
export function attemptPackRows(v: AttemptSkillsView | null): { readonly packs: readonly AttemptPackRow[]; readonly omitted: readonly { key: string; text: string }[] } | null {
  if (!v || !v.record) return null;
  const revoked = new Set(v.revoked);
  return {
    packs: v.record.delivered.map((d) => ({ versionId: d.versionId, title: `${d.name} ${d.version}`, digest: d.digest, dir: d.dir, revoked: revoked.has(d.versionId) })),
    omitted: v.record.omitted.map((o) => ({ key: `${o.skillId}:${o.reason}`, text: `${o.versionId}: ${o.reason.replace(/_/g, ' ').replace(':', ' · ')}` })),
  };
}
