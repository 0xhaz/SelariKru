import type { Classification } from '@selarikru/policy';
import type { ProposalOperation } from '@selarikru/domain';
import briefs from './data/brief-fixtures.json';
import restrictedBrief from './data/restricted-brief.json';

/** Bundled synthetic briefs (copied from the demo fixtures; the app never imports from docs/). */
export interface BriefOption {
  readonly id: string;
  readonly label: string;
  /** Prompt text. Never rendered for restricted briefs. */
  readonly taskText: string;
  readonly allowedRequirementIds: readonly string[];
  readonly forbiddenMandatoryScope: readonly string[];
  readonly classification: Classification;
  readonly restricted: boolean;
}

/** Short, human labels. Prompt text is shown separately for permitted briefs. */
const TITLES: Record<string, string> = {
  'brief-01': 'Submit feedback',
  'brief-02': 'Status flow',
  'brief-03': 'Status filters and counts',
  'brief-04': 'Local persistence',
  'brief-05': 'Loading, empty and error states',
  'brief-06': 'Accessibility and safe rendering',
  'brief-07': 'API create, update and errors',
  'brief-08': 'Newest-first ordering',
  'brief-09': 'Input rejection',
  'brief-10': 'One-screen Feedback Board',
};

export const BRIEFS: readonly BriefOption[] = [
  ...briefs.fixtures.map((f): BriefOption => ({
    id: f.id,
    label: `${f.id} · ${TITLES[f.id] ?? 'Synthetic brief'}`,
    taskText: f.prompt,
    allowedRequirementIds: f.allowedRequirementIds,
    forbiddenMandatoryScope: f.forbiddenMandatoryScope,
    classification: 'internal',
    restricted: false,
  })),
  {
    id: restrictedBrief.id,
    label: 'Restricted brief (synthetic, contents withheld)',
    taskText: restrictedBrief.taskText,
    allowedRequirementIds: restrictedBrief.allowedRequirementIds,
    forbiddenMandatoryScope: restrictedBrief.forbiddenMandatoryScope,
    classification: 'restricted',
    restricted: true,
  },
];

export const briefById = (id: string): BriefOption => BRIEFS.find((b) => b.id === id) ?? BRIEFS[0]!;

export const OPERATIONS: readonly { id: ProposalOperation; label: string }[] = [
  { id: 'suggestCriteria', label: 'Suggest criteria' },
  { id: 'draftBrief', label: 'Draft brief' },
  { id: 'draftTaskPlan', label: 'Draft task plan' },
];
