import { describe, expect, it } from 'vitest';
import { applyStackAction, emptyStack, type StackAction, type StackDocument } from '@selarikru/domain';
import type { StackView } from '@selarikru/view-protocol';
import { categoryRows, componentRows, detectionRows, searchOptions } from './model.ts';

const view = (document: StackDocument): StackView => ({ projectId: 'p', revision: 3, detectionRevision: 0, unreadable: false, catalogVersion: 'v', document, updatedBy: null, updatedAt: null, native: { ios: false, android: false } });
function doc(...actions: StackAction[]): StackDocument {
  let d = emptyStack();
  for (const a of actions) {
    const r = applyStackAction(d, a);
    if (!r.ok) throw new Error(r.code);
    d = r.doc;
  }
  return d;
}
const web: StackAction = { kind: 'component.upsert', path: 'apps/web', name: 'Web', targets: ['web'] };
const mobile: StackAction = { kind: 'component.upsert', path: 'apps/mobile', name: 'Mobile', targets: ['ios', 'android'] };

describe('stack settings model', () => {
  it('None and Not decided read differently, and a selection lists its entries', () => {
    const d = doc(web, { kind: 'category.set', path: 'apps/web', category: 'payments', state: 'none' }, { kind: 'item.add', path: 'apps/web', category: 'auth', item: { kind: 'catalog', entryId: 'clerk' } });
    const rows = categoryRows(d.components[0]!, 'services');
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by('payments')).toMatchObject({ state: 'none', stateLabel: 'None · not used' });
    expect(by('analytics')).toMatchObject({ state: 'not_decided', stateLabel: 'Not decided' });
    expect(by('auth')).toMatchObject({ state: 'selected', stateLabel: 'Selected (1)', items: [expect.objectContaining({ label: 'Clerk', key: 'clerk' })] });
    expect(by('payments').explanation).toMatch(/does not turn off/i);
    expect(categoryRows(d.components[0]!, 'frameworks').map((r) => r.id)).toEqual(['frameworks', 'languages', 'runtimes']);
  });

  it('a service shows its own axes, No reviewed skills, and a disabled disconnect that explains why', () => {
    const d = doc(web, { kind: 'item.add', path: 'apps/web', category: 'payments', item: { kind: 'catalog', entryId: 'stripe' } });
    const stripe = categoryRows(d.components[0]!, 'services').find((r) => r.id === 'payments')!.items[0]!;
    expect(stripe.axes.map((a) => [a.name, a.label])).toEqual([
      ['Profile knowledge', 'Not linked'], ['Skills', 'No reviewed skills'], ['Connector', 'No connector'], ['Authentication', 'Not connected'], ['Tested execution', 'Not tested'],
    ]);
    expect(stripe.disconnect).toMatchObject({ enabled: false });
    expect(stripe.disconnect!.explanation).toMatch(/no connector/i);
    expect(stripe.disconnect!.explanation).toMatch(/deletes no provider data/i);
    expect(stripe.summary).toBe('Selected · not connected · not tested');
  });

  it('a custom entry is unknown on every axis, and a mobile entry shows its native gates as incomplete', () => {
    const d = doc(mobile, { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: 'expo' } }, { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'custom', label: 'Old Cordova app', canonicalSource: null } });
    const [expo, custom] = categoryRows(d.components[0]!, 'frameworks')[0]!.items;
    expect(custom!.axes.every((a) => a.label === 'Unknown · not reviewed')).toBe(true);
    expect(custom!.summary).toBe('Custom · not reviewed');
    expect(expo!.gates.map((g) => [g.target, g.label])).toEqual([['web', 'Web checks not linked'], ['ios', 'iOS runner required'], ['android', 'Android build not assessed']]);
    const comp = componentRows(view(d))[0]!;
    expect(comp.gates.map((g) => g.label)).toEqual(['iOS runner required', 'Android build not assessed']);
    expect(comp.toolchain).toBe('Package and build tools: not decided · Runtime: not decided');
    expect(comp.restricted).toBe(false);
    expect(componentRows(view(doc({ kind: 'component.upsert', path: 'svc', name: 'S', targets: [], classification: 'restricted' })))[0]!.restricted).toBe(true);
  });

  it('a pilot-tested entry cites the suite only at the pinned version on a matching target; otherwise it says what the pilot ran', () => {
    const d = doc(
      web,
      { kind: 'item.add', path: 'apps/web', category: 'testing', item: { kind: 'catalog', entryId: 'vitest', version: '5.1.0' } },
      { kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'fastify' } },
      { kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'react', version: '16.0.0' } },
      mobile,
      { kind: 'item.add', path: 'apps/mobile', category: 'frameworks', item: { kind: 'catalog', entryId: 'react', version: '19.3.1' } },
    );
    const webC = d.components.find((c) => c.path === 'apps/web')!;
    const vitest = categoryRows(webC, 'services').find((r) => r.id === 'testing')!.items[0]!;
    expect(vitest.axes.at(-1)).toMatchObject({ label: 'Run by the pilot suite (web)', detail: expect.stringContaining('feedback-board 0.1') });
    expect(vitest.summary).toBe('Selected · not connected · run by the pilot suite on web');
    const [fastify, react16] = categoryRows(webC, 'frameworks')[0]!.items;
    expect(fastify!.axes.at(-1)!.label).toBe('Not tested');
    expect(react16!.axes.at(-1)).toMatchObject({ label: 'Not tested', detail: expect.stringMatching(/pilot ran 19\.3\.1 on web/) });
    expect(react16!.summary).toBe('Selected · not tested');
    const reactIos = categoryRows(d.components.find((c) => c.path === 'apps/mobile')!, 'frameworks')[0]!.items[0]!;
    expect(reactIos.axes.at(-1)!.label).toBe('Not tested');
  });

  it('grouped search marks what the component already has, within the section and filter', () => {
    const d = doc(web, { kind: 'item.add', path: 'apps/web', category: 'frameworks', item: { kind: 'catalog', entryId: 'nextjs' } });
    const groups = searchOptions('next', 'frameworks', null, d.components[0]!);
    expect(groups[0]).toMatchObject({ group: 'Web application frameworks', options: [expect.objectContaining({ entryId: 'nextjs', selected: true, category: 'frameworks' })] });
    expect(searchOptions('stripe', 'frameworks', null, d.components[0]!)).toEqual([]);
    const mobileOnly = searchOptions('', 'frameworks', 'mobile', d.components[0]!);
    expect(mobileOnly.every((g) => g.options.every((o) => o.filter === 'mobile'))).toBe(true);
    expect(searchOptions('python', 'frameworks', null, d.components[0]!)[0]!.options[0]).toMatchObject({ category: 'languages' });
  });

  it('detections read as proposals with their evidence, and commands are never in effect', () => {
    const d: StackDocument = {
      ...doc(web),
      detection: {
        commit: 'c'.repeat(40), detectedAt: '2026-11-10T08:00:00.000Z', runnerId: 'r1',
        items: [
          { detectionId: 'det:apps/web:nextjs', componentPath: 'apps/web', entryId: 'nextjs', version: '15.1.0', evidence: { path: 'apps/web/package.json', detail: 'dependencies.next 15.1.0' }, state: 'proposed' },
          { detectionId: 'det:.:pnpm', componentPath: '.', entryId: 'pnpm', version: null, evidence: { path: 'pnpm-lock.yaml', detail: 'lockfile' }, state: 'dismissed' },
        ],
        commands: [{ componentPath: 'apps/web', kind: 'build', script: 'build', command: 'pnpm run build', body: 'next build', evidencePath: 'apps/web/package.json' }],
        skipped: [{ path: 'apps/x/package.json', reason: 'symlink' }],
      },
    };
    const rows = detectionRows(view(d));
    expect(rows.items[0]).toMatchObject({ label: 'Next.js', version: '15.1.0', evidence: 'apps/web/package.json · dependencies.next 15.1.0', stateLabel: 'Proposed', canSettle: true, componentPath: 'apps/web' });
    expect(rows.items[1]).toMatchObject({ stateLabel: 'Dismissed', canSettle: false });
    expect(rows.commands[0]).toMatchObject({ command: 'pnpm run build', status: 'Proposed · needs review · not in effect' });
    expect(rows.skipped[0]).toBe('apps/x/package.json: a symlink, not followed');
    expect(rows.commit).toBe('cccccccccccc');
  });
});
