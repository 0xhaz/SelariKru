import type { VerificationRecord } from '@selarikru/domain';
import { redactSecrets } from '@selarikru/protocol';

export type Provenance = 'observed' | 'estimated' | 'unavailable';

/** One recorded usage value. `value: null` is unknown and is printed as unavailable, never as zero. A string is an exact decimal. */
export interface UsageLine {
  readonly label: string;
  readonly value: number | string | null;
  readonly unit: string;
  readonly provenance: Provenance;
}

export interface ReviewPackage {
  readonly runId: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly record: VerificationRecord;
  readonly limitations: readonly string[];
  readonly usage: readonly UsageLine[];
  /** Present after the owner accepted a budget stop: what the run does not deliver. */
  readonly notDelivered?: { readonly tasks: readonly { readonly taskId: string; readonly status: string; readonly budgetStopped: boolean }[]; readonly requirementIds: readonly string[]; readonly acceptanceCheckIds: readonly string[] };
}

const cell = (s: string): string => s.replace(/[\r\n|]+/g, ' ').trim();

/**
 * The PR body, built only from recorded data: the verification record's per-requirement results, the candidate SHA, limitations
 * (skipped, errored or flaky checks are always listed, plus any recorded limitation) and usage with its provenance label. The whole
 * text goes through `redactSecrets`.
 */
export function buildPrBody(p: ReviewPackage): string {
  const r = p.record;
  const lines: string[] = [];
  lines.push('This draft pull request was opened by SelariKru for human review. SelariKru does not merge: a person merges on GitHub.', '');
  lines.push('## Candidate', '', `- Run: \`${p.runId}\``, `- Candidate commit: \`${p.candidateSha}\``, `- Base commit: \`${p.baseSha}\``, `- Verification record: \`${r.recordId}\` (verifier \`${r.verifier.id}\`, host \`${r.host}\`)`, '');
  lines.push('## Requirements', '', '| Requirement | Result | Checks |', '| --- | --- | --- |');
  for (const c of r.results) {
    const passed = c.tests.filter((t) => t.status === 'passed').length;
    lines.push(`| ${cell(c.checkId)} | ${c.status} | ${passed} of ${c.tests.length} passed |`);
  }
  lines.push('');
  const limits: string[] = [];
  for (const c of r.results) if (c.status !== 'passed') limits.push(`${c.checkId} is ${c.status}; a ${c.status} check is not a pass.`);
  for (const id of r.flaky) limits.push(`${id} gave different results across verification runs (flaky).`);
  for (const l of p.limitations) limits.push(l);
  lines.push('## Limitations', '');
  if (limits.length === 0) lines.push('None recorded.');
  else for (const l of limits) lines.push(`- ${cell(l)}`);
  if (p.notDelivered) {
    const n = p.notDelivered;
    lines.push('', '## Not delivered', '', 'The run was stopped by its budget and the owner accepted this reduced scope. None of the following is verified, whatever the checks above report.', '');
    for (const t of n.tasks) lines.push(`- Task \`${cell(t.taskId)}\`: ${cell(t.status)}${t.budgetStopped ? ' (stopped by the budget)' : ''}`);
    lines.push(`- Requirements: ${n.requirementIds.map(cell).join(', ') || 'none recorded'}`, `- Acceptance checks: ${n.acceptanceCheckIds.map(cell).join(', ') || 'none recorded'}`);
  }
  lines.push('', '## Usage', '');
  if (p.usage.length === 0) lines.push('No usage recorded.');
  else for (const u of p.usage) lines.push(`- ${cell(u.label)}: ${u.value === null || u.provenance === 'unavailable' ? 'unavailable' : `${u.value} ${cell(u.unit)}`} (${u.provenance})`);
  lines.push('');
  return redactSecrets(lines.join('\n'));
}
