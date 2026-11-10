import {
  briefSeed, briefState, buildProductTrace, latestProductRecords, milestoneSummaries, OutcomePlanContentSchema, OutcomeReviewContentSchema, PRODUCT_NOTICE, ProblemBriefContentSchema, productLabel,
  ProductRecordSchema, ReleaseNoteContentSchema, type ProductRecord, type TraceInput,
} from '@selarikru/domain';
import { DataSourceException, type ProductAction, type ProductView, type ProjectViewSnapshot } from '@selarikru/view-protocol';

/**
 * Product-learning records on demo data. The trace, release and outcome states and milestone summaries come from the same domain code the server runs, over the demo
 * snapshot's evidence and pull requests. Writes follow the server's rules: a save against the revision last read, a plan only about requirements the project has, a release
 * note only for a run a person merged, a review only of a plan and release that exist, and a review never touches a task. Nothing here touches a network.
 */

const OWNER = 'demo owner';
const refuse = (message: string): DataSourceException => new DataSourceException({ code: 'unavailable', message, retryable: false });

export interface DemoProduct {
  get(projectId: string): Promise<ProductView>;
  act(projectId: string, action: ProductAction): Promise<ProductView>;
}

export function createDemoProduct(snapshotOf: (projectId: string) => ProjectViewSnapshot, nowIso: (projectId: string) => string): DemoProduct {
  const stores = new Map<string, ProductRecord[]>();
  const recordsOf = (projectId: string): ProductRecord[] => {
    let s = stores.get(projectId);
    if (!s) { s = []; stores.set(projectId, s); }
    return s;
  };

  function inputsOf(projectId: string): TraceInput {
    const snap = snapshotOf(projectId);
    const runs = Object.values(snap.runs).sort((a, b) => (a.runId < b.runId ? -1 : 1));
    const criteria = runs.flatMap((r) => r.evidence?.criteria ?? []);
    const requirements = new Map<string, string | null>();
    for (const c of criteria) requirements.set(c.criterionId, c.description ?? requirements.get(c.criterionId) ?? null);
    return {
      requirements: [...requirements.entries()].map(([id, text]) => ({ id, text })),
      tasks: Object.values(snap.tasks).map((t) => ({ taskId: t.taskId, runId: t.runId, title: t.title, status: t.status, requirementIds: criteria.filter((c) => c.taskIds.includes(t.taskId)).map((c) => c.criterionId) })),
      runs: runs.map((r) => {
        const pr = snap.changeRequests.find((c) => c.runId === r.runId);
        const cand = r.evidence?.candidate ?? null;
        return {
          runId: r.runId, candidate: cand ? { sha: cand.sha, live: cand.live, recordId: cand.recordId, recordValid: cand.recordValid } : null,
          criteria: (r.evidence?.criteria ?? []).map((c) => ({ criterionId: c.criterionId, state: c.state, verified: c.verified, candidateSha: c.candidateSha })),
          pullRequest: pr ? { prNumber: pr.prNumber, url: pr.url, status: pr.status, mergeCommitSha: pr.mergeCommitSha } : null,
        };
      }),
      records: recordsOf(projectId),
    };
  }

  function view(projectId: string): ProductView {
    const records = recordsOf(projectId);
    const input = inputsOf(projectId);
    const brief = briefState(records);
    const latest = latestProductRecords(records);
    const releases = latest.filter((r) => r.kind === 'release_note');
    const snap = snapshotOf(projectId);
    return {
      projectId, observedAt: nowIso(projectId), notice: PRODUCT_NOTICE,
      brief: {
        confirmed: brief.confirmed, latest: brief.latest, revision: brief.latest?.revision ?? 0,
        seed: brief.latest?.content ?? briefSeed({ owner: OWNER, goals: { idea: 'A feedback board for a small team (demo)', audience: 'Team leads who triage feedback (demo)', firstOutcome: 'See the newest feedback first (demo)' }, assumptions: ['Leads read the list every day (demo)'], nonGoals: [], briefSource: null }),
      },
      plans: latest.filter((r) => r.kind === 'outcome_plan'), releases, reviews: latest.filter((r) => r.kind === 'outcome_review'),
      followUps: latest.flatMap((r) => (r.kind === 'outcome_review' && r.content.followUp ? [{ reviewRecordId: r.recordId, title: r.content.followUp.title, requirementIds: r.content.followUp.requirementIds, reason: r.content.followUp.reason, decision: r.content.decision, state: 'proposed' as const }] : [])),
      requirements: input.requirements.map((r) => ({ id: r.id, text: r.text })),
      mergedRuns: snap.changeRequests.filter((c) => c.status === 'merged' && c.mergeCommitSha !== null).map((c) => ({ runId: c.runId, prNumber: c.prNumber, mergeCommitSha: c.mergeCommitSha!, released: releases.some((r) => r.kind === 'release_note' && r.content.runId === c.runId) })),
      trace: buildProductTrace(input), milestones: milestoneSummaries(input),
    };
  }

  let counter = 0;
  function append(projectId: string, r: Omit<ProductRecord, 'revision' | 'seq' | 'recordedAt' | 'classification' | 'proposedBy'> & { expectedRevision: number }): void {
    const records = recordsOf(projectId);
    const current = Math.max(0, ...records.filter((x) => x.recordId === r.recordId).map((x) => x.revision));
    if (current !== r.expectedRevision) throw refuse('This record has changed; reload and retry. Nothing was saved.');
    const { expectedRevision: _e, ...rest } = r;
    records.push(ProductRecordSchema.parse({ ...rest, revision: current + 1, seq: records.length + 1, recordedAt: nowIso(projectId), classification: productLabel('internal'), proposedBy: { kind: 'human', id: OWNER } }));
  }

  return {
    async get(projectId) {
      return view(projectId);
    },
    async act(projectId, action) {
      const input = inputsOf(projectId);
      switch (action.kind) {
        case 'save_brief': {
          const content = ProblemBriefContentSchema.parse(action.content);
          append(projectId, { recordId: 'brief', kind: 'problem_brief', status: action.confirm ? 'confirmed' : 'proposed', confirmedBy: action.confirm ? OWNER : null, content, expectedRevision: action.expectedRevision });
          break;
        }
        case 'save_plan': {
          const content = OutcomePlanContentSchema.parse(action.content);
          const known = new Set(input.requirements.map((r) => r.id));
          const unknown = content.requirementIds.filter((id) => !known.has(id));
          if (unknown.length > 0) throw refuse(`This project has no accepted requirement ${unknown.join(', ')}. Nothing was saved.`);
          append(projectId, { recordId: action.recordId ?? `plan:demo-${(counter += 1)}`, kind: 'outcome_plan', status: 'recorded', confirmedBy: null, content, expectedRevision: action.recordId === null ? 0 : action.expectedRevision });
          break;
        }
        case 'add_release': {
          const content = ReleaseNoteContentSchema.parse(action.content);
          const run = input.runs.find((r) => r.runId === content.runId);
          if (run?.pullRequest?.status !== 'merged' || run.pullRequest.mergeCommitSha === null) throw refuse('A release note needs a merged run, and a person merges on GitHub. Nothing was saved.');
          append(projectId, { recordId: `release:demo-${(counter += 1)}`, kind: 'release_note', status: 'recorded', confirmedBy: null, content, expectedRevision: 0 });
          break;
        }
        case 'add_review': {
          const content = OutcomeReviewContentSchema.parse(action.content);
          const latest = latestProductRecords(recordsOf(projectId));
          if (!latest.some((r) => r.recordId === content.planRecordId && r.kind === 'outcome_plan')) throw refuse('No such outcome plan. Nothing was saved.');
          if (!latest.some((r) => r.recordId === content.releaseRecordId && r.kind === 'release_note')) throw refuse('No such release note. Nothing was saved.');
          append(projectId, { recordId: `review:demo-${(counter += 1)}`, kind: 'outcome_review', status: 'recorded', confirmedBy: null, content, expectedRevision: 0 });
          break;
        }
      }
      return view(projectId);
    },
  };
}
