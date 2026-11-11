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
  /** Requirement ids the run's tasks carry that no check in the record covered. Listed so a reviewer cannot read a passing table as covering them. */
  readonly untested?: readonly string[];
  /** Approvals a person granted for this run. Advisory: the sandbox does not enforce them, so the reviewer needs to see what was allowed. */
  readonly grants?: readonly { readonly operation: string; readonly taskId: string | null; readonly approver: string | null }[];
  /** Attempts of this run a person opened a shell in, in the order they happened. A verifier pass does not clear this. */
  readonly humanIntervention?: readonly { readonly attemptId: string; readonly taskId: string; readonly at: string }[];
  /** The knowledge packs each attempt of this run received, by version and digest, from the attempt's execution record. */
  readonly skills?: readonly { readonly attemptId: string; readonly taskId: string; readonly confirmed: boolean; readonly packs: readonly { readonly versionId: string; readonly digest: string }[] }[];
  /**
   * H11: who worked on each task, "<Name> · <Role>" from the workers' settings (owner-given names, shown as data), and for an assignment the Project Manager made,
   * the accepted plan revision it was made under.
   */
  readonly workers?: readonly { readonly taskId: string; readonly worker: string; readonly assignedUnderPlanRevision: number | null }[];
  /** The owner's description, sent with the open request (H5): a browser proposal the owner chose and edited. Untrusted text, redacted and capped before it gets here. */
  readonly description?: string | null;
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
  if (p.description) {
    lines.push('## Description', '', '_Written by the owner from a browser proposal. It is not a check result: the sections after it are what was recorded and verified._', '', p.description.trim(), '');
  }
  lines.push('## Candidate', '', `- Run: \`${p.runId}\``, `- Candidate commit: \`${p.candidateSha}\``, `- Base commit: \`${p.baseSha}\``, `- Verification record: \`${r.recordId}\` (verifier \`${r.verifier.id}\`, host \`${r.host}\`)`, '');
  lines.push('## Requirements', '', '| Requirement | Result | Checks |', '| --- | --- | --- |');
  for (const c of r.results) {
    const passed = c.tests.filter((t) => t.status === 'passed').length;
    lines.push(`| ${cell(c.checkId)} | ${c.status} | ${passed} of ${c.tests.length} passed |`);
  }
  lines.push('');
  const limits: string[] = [];
  for (const c of r.results) if (c.status !== 'passed') limits.push(`${c.checkId} is ${c.status}; a ${c.status} check is not a pass.`);
  for (const id of p.untested ?? []) limits.push(`${id} is untested: no check in this run covered it.`);
  for (const id of r.flaky) limits.push(`${id} gave different results across verification runs (flaky).`);
  for (const l of p.limitations) limits.push(l);
  lines.push('## Limitations', '');
  if (limits.length === 0) lines.push('None recorded.');
  else for (const l of limits) lines.push(`- ${cell(l)}`);
  if (p.grants && p.grants.length > 0) {
    lines.push('', '## Approvals granted', '', 'A person granted these during the run. They are advisory: the sandbox did not enforce them, so check the diff for what they allowed.', '');
    for (const g of p.grants) lines.push(`- \`${cell(g.operation)}\`${g.taskId !== null ? ` for task \`${cell(g.taskId)}\`` : ''}${g.approver !== null ? `, granted by ${cell(g.approver)}` : ''}`);
  }
  if (p.workers && p.workers.length > 0) {
    lines.push('', '## Who worked on it', '', 'Worker names are labels the owner gave; they describe, they do not vouch for anything. The checks above are the verifier\'s.', '');
    for (const w of p.workers) lines.push(`- Task \`${cell(w.taskId)}\`: ${cell(w.worker).replace(/[`*_[\]<>]/g, '')}${w.assignedUnderPlanRevision !== null ? `, assigned by the Project Manager under the accepted plan rev ${w.assignedUnderPlanRevision}` : ''}`);
  }
  if (p.humanIntervention && p.humanIntervention.length > 0) {
    lines.push('', '## Human intervention', '', 'A person opened a shell in these attempts\' sandboxes. The recorded model cannot vouch for what was run. Any change it made was still judged by the diff gate and the verifier.', '');
    for (const h of p.humanIntervention) lines.push(`- Attempt \`${cell(h.attemptId)}\` (task \`${cell(h.taskId)}\`) at ${cell(h.at)}`);
  }
  const withPacks = (p.skills ?? []).filter((s) => s.packs.length > 0);
  if (withPacks.length > 0) {
    lines.push('', '## Knowledge packs', '', 'Reviewed, pinned packs resolved for these attempts at claim. Only those the runner confirmed, after checking each digest, were delivered read-only. They are reference text: they granted no tool, path or approval, and the checks above are the verifier\'s, not a pack\'s.', '');
    for (const s of withPacks) lines.push(`- Attempt \`${cell(s.attemptId)}\` (task \`${cell(s.taskId)}\`), ${s.confirmed ? 'delivered and confirmed by the runner' : 'resolved at claim but delivery not confirmed by the runner'}: ${s.packs.map((k) => `\`${cell(k.versionId)}\` sha256 \`${cell(k.digest)}\``).join(', ')}`);
  }
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
