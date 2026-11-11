import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import { pmHistory } from '@selarikru/inference-firebase-web';
import { snapshotOf, task } from '../overview/testing.ts';
import { rememberedTurns } from './memory.ts';

const CANARY = 'CANARY-H12-I4-remembered';
const route = (lock: unknown = null) => ({ effective: 'PREFER_IN_CLOUD', source: 'run', runDefault: 'PREFER_IN_CLOUD', override: null, overrideRevision: 0, lock, suggestion: null, lastObserved: null }) as never;
const cp = (taskId: string): AiCheckpoint => ({
  checkpointId: `ckp_mem_${taskId}_0001`, projectId: 'p', taskId, taskRevision: 1, runId: 'run', planRevision: 1, stepKind: 'pmAnswer', stage: 'pm_turn', callOverride: null, routeMode: 'PREFER_IN_CLOUD',
  continuation: 'cloud_capable', labels: ['internal'], locked: false, inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null },
  partial: { issues: [], texts: [{ who: 'owner', text: `${CANARY} ${taskId}`, classification: 'internal' }, { who: 'pm', text: 'reply', classification: 'internal' }] },
  stopReason: null, status: 'done', routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
});

describe('the PM\'s memory (H12 fix round 1, I4)', () => {
  it('a remembered turn is labelled by its task\'s lock now: a task locked since never puts it in a cloud-capable prompt', () => {
    const snap = snapshotOf({ tasks: [task('open', { route: route() }), task('locked', { route: route({ label: 'restricted', reason: 'r' }) }), task('unknown')] });
    const turns = rememberedTurns({ a: cp('open'), b: cp('locked'), c: cp('unknown') }, snap, '2026-11-12T00:00:00.000Z');
    expect(turns.filter((t) => t.text.includes('open')).map((t) => t.classification)).toEqual(['internal']);
    expect(turns.filter((t) => t.text.includes('locked') || t.text.includes('unknown')).every((t) => t.classification === 'restricted')).toBe(true);
    const cloud = pmHistory(turns, true).lines.join('\n');
    expect(cloud).toContain(`${CANARY} open`);
    expect(cloud).not.toContain(`${CANARY} locked`);
    expect(cloud).not.toContain(`${CANARY} unknown`);
  });
});
