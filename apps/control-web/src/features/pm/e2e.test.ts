import { describe, expect, it } from 'vitest';
import { createMockDataSource, createSeededClock, fixtureTime } from '@selarikru/data-source-mock';
import type { AssistantSdk, ModelSpec } from '@selarikru/inference-firebase-web';
import { createAgents } from '../hybrid/agents.ts';

/**
 * Fix round 3 (N1), end to end on demo data: a model that copies every task title its prompt shows into its plan. On an unlocked device call about an internal task,
 * the plan the owner accepts carries no part of the locked sibling's title, because the prompt never showed it.
 */
function copyingSdk(prompts: string[]): AssistantSdk {
  return {
    async availability() { return 'available'; },
    async initializeDeviceModel(on) { on(1); },
    createModel(_spec: ModelSpec) {
      return {
        async generate(prompt: string) {
          prompts.push(prompt);
          const titles = [...prompt.matchAll(/^- [^\s:]+: (.+) \(role [a-z_]+, \w+\)$/gm)].map((m) => m[1]!);
          const ids = /Allowed criterion IDs: ([^.]+)\./.exec(prompt)?.[1]?.split(', ') ?? [];
          const tasks = titles.slice(0, 6).map((title, i) => ({ key: `T${i + 1}`, title: title.slice(0, 120), description: 'Copied from the prompt.', role: 'backend', requirementIds: ids.slice(0, 1), paths: ['src'], dependsOn: [] }));
          return { text: JSON.stringify({ tasks: tasks.length > 0 ? tasks : [{ key: 'T1', title: 'x', description: 'x', role: 'backend', requirementIds: ids.slice(0, 1), paths: ['src'], dependsOn: [] }] }), inferenceSource: 'on_device' as const };
        },
      };
    },
  };
}

describe('an accepted PM plan carries no restricted title (fix round 3, N1)', () => {
  it('on an unlocked device call about an internal task', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const projectId = 'demo-feature-delivery';
    const snap = await ds.getSnapshot(projectId);
    const locked = Object.values(snap.tasks).filter((t) => t.route?.lock);
    expect(locked.length).toBeGreaterThan(0);
    const prompts: string[] = [];
    const agents = createAgents({ projectId, source: ds, sdk: copyingSdk(prompts), simulated: true, execute: (c) => ds.execute(c), snapshot: () => snap })!;
    // The first internal task whose device call reads nothing restricted: that call is not locked, so its output may leave the device.
    let found: { subject: (typeof snap.tasks)[string]; out: Awaited<ReturnType<typeof agents.pm>> } | null = null;
    for (const subject of Object.values(snap.tasks).filter((t) => t.route && !t.route.lock)) {
      const out = await agents.pm({ kind: 'pmPlan', subjectTaskId: subject.taskId, question: 'Plan the rest.', questionClassification: 'internal', history: [], callOverride: 'ONLY_ON_DEVICE' });
      if (out.kind === 'result' && out.result.proposal.status === 'ok' && !out.result.locked) { found = { subject, out }; break; }
    }
    expect(found).not.toBeNull();
    const { subject, out } = found!;
    if (out.kind !== 'result') return;
    const plan = out.result.proposal.data as { tasks: { title: string }[] };
    const accepted = await ds.acceptPmPlan!(projectId, out.runId, { expectedPlanRevision: out.planRevision ?? 0, subjectTaskId: subject.taskId, routeRecordId: out.result.report!.requestId, plan: plan as never, idempotencyKey: 'k' });
    const after = await ds.getSnapshot(projectId);
    const acceptedTitles = accepted.taskIds.map((id) => after.tasks[id]?.title ?? '').join(' | ');
    for (const t of locked) {
      expect(prompts.join('\n')).not.toContain(t.title!);
      expect(acceptedTitles).not.toContain(t.title!);
    }
  });
});
