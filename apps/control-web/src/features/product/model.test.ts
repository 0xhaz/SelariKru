import { describe, expect, it } from 'vitest';
import { OutcomePlanContentSchema, UNKNOWN_MEASURE } from '@selarikru/domain';
import { lines, measureFrom, measureLabel, planFrom, traceTable, type PlanForm } from './model.ts';

const FORM: PlanForm = {
  requirementIds: ['FB-03'], milestone: '', metric: 'Minutes to first triage', baselineValue: '', baselineUnit: '', baselineProvenance: 'unavailable', targetValue: '', targetUnit: '',
  targetProvenance: 'unavailable', learningQuestion: 'Do leads triage sooner?', windowDays: '', dataSource: '', cohort: '', guardrails: '', reviewOwner: 'me', reviewDate: '',
  decisionOptions: ['iterate', 'retain', 'disable', 'investigate'], reportLabel: '', reportUrl: '', confidence: 'unknown',
};

describe('the outcome plan form', () => {
  it('an empty baseline is unknown, never 0, and empty optional fields are unknown', () => {
    const plan = planFrom(FORM);
    expect(plan.baseline).toEqual(UNKNOWN_MEASURE);
    expect(plan.windowDays).toBeNull();
    expect(plan.cohort).toBeNull();
    expect(plan.milestone).toBeNull();
    expect(OutcomePlanContentSchema.safeParse(plan).success).toBe(true);
    // A blank value with a provenance chosen is still unknown: provenance never makes a number up.
    expect(measureFrom(' ', 'min', 'observed')).toEqual({ value: null, unit: 'min', provenance: 'unavailable', basis: null });
    expect(measureFrom('0', null, 'observed')).toEqual({ value: 0, unit: null, provenance: 'observed', basis: null });
    expect(measureFrom('abc', null, 'estimated').provenance).toBe('unavailable');
    expect(measureLabel(plan.baseline)).toBe('Unknown');
    expect(planFrom({ ...FORM, reportLabel: 'Prototype notes', reportUrl: 'https://example.com/p' }).reportLinks).toEqual([{ kind: 'prototype_report', label: 'Prototype notes', url: 'https://example.com/p' }]);
    expect(lines(' a \n\n b ')).toEqual(['a', 'b']);
  });
});

describe('the trace table', () => {
  it('names every link with its state in words, missing links included', () => {
    const rows = traceTable([{ requirementId: 'FB-03', text: 'List newest first', runIds: [], release: { state: 'not_released', label: 'Not released' }, outcome: { state: 'no_outcome_plan', label: 'No outcome plan', decision: null },
      links: [{ kind: 'problem_brief', state: 'missing', label: 'No problem brief yet', ref: null }, { kind: 'verification', state: 'present', label: 'Passed', ref: 'rec_1' }] }]);
    expect(rows[0]!.links.map((l) => [l.name, l.state, l.tone])).toEqual([['Problem brief', 'Missing', 'warning'], ['Verification record', 'Present', 'success']]);
  });
});

describe('fix round 1: a number with no provenance', () => {
  it('asks for observed or estimated instead of dropping the number', async () => {
    const { measureProblem } = await import('./model.ts');
    expect(measureProblem('12', 'unavailable')).toBe('You typed a number. Choose observed or estimated for it, or clear it to record unknown.');
    expect(measureProblem('', 'unavailable')).toBeNull();
    expect(measureProblem('12', 'observed')).toBeNull();
    expect(measureProblem('twelve', 'estimated')).toBe('Enter a number, or clear it to record unknown.');
    expect(planFrom({ ...FORM, baselineValue: '12' }).baseline.provenance).toBe('unavailable');
  });
});
