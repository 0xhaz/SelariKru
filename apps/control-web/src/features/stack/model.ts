import {
  NO_NATIVE, READINESS_AXIS_LABELS, readinessOf, searchStack, sectionOf, STACK_CATEGORIES, stackCategory, stackEntry, stackItemKey, STACK_TARGET_LABELS, targetGates,
  type NativeCapabilities, type StackCategoryId, type StackComponent, type StackFilter, type StackItem, type StackSection, type StackTarget, type TargetGate,
} from '@selarikru/domain';
import type { StackView } from '@selarikru/view-protocol';

/** Presentation of the stack settings. Every readiness axis is shown on its own; nothing here collapses them into one badge or invents a tested state. */

export interface AxisRow {
  readonly name: string;
  readonly label: string;
  readonly detail: string;
}

export interface ItemRow {
  readonly key: string;
  readonly label: string;
  readonly version: string | null;
  readonly origin: string;
  readonly custom: boolean;
  /** One line that keeps the distinctions, such as `Selected · not connected · not tested`. */
  readonly summary: string;
  readonly axes: readonly AxisRow[];
  /** The verification gate of each target this entry builds for. */
  readonly gates: readonly TargetGate[];
  /** For a service: the separate, scoped disconnect action. Disabled until a connector exists. */
  readonly disconnect: { readonly enabled: false; readonly explanation: string } | null;
}

export interface CategoryRow {
  readonly id: StackCategoryId;
  readonly label: string;
  readonly state: 'not_decided' | 'none' | 'selected';
  readonly stateLabel: string;
  readonly explanation: string;
  readonly items: readonly ItemRow[];
}

const DISCONNECT = 'No connector exists for this entry yet, so there is nothing to disconnect. Removing the selection only changes your stack record: it deletes no provider data and revokes no credential.';

export function itemRow(item: StackItem, native: NativeCapabilities = NO_NATIVE, targets: readonly StackTarget[] = []): ItemRow {
  const readiness = readinessOf(item, { targets });
  const axes = readiness.map((a) => ({ name: READINESS_AXIS_LABELS[a.axis], label: a.label, detail: a.explanation }));
  if (item.kind === 'custom') {
    return { key: stackItemKey(item), label: item.label, version: null, origin: item.canonicalSource ? `Custom · source ${item.canonicalSource}` : 'Custom', custom: true, summary: 'Custom · not reviewed', axes, gates: [], disconnect: null };
  }
  const e = stackEntry(item.entryId);
  const service = e !== undefined && sectionOf(e) === 'services';
  const testedAxis = readiness.find((a) => a.axis === 'tested')!;
  const tested = testedAxis.state === 'tested';
  const native2 = (e?.targets ?? []).filter((t): t is StackTarget => t === 'ios' || t === 'android');
  return {
    key: stackItemKey(item), label: e?.label ?? item.entryId, version: item.version, custom: false,
    origin: item.origin === 'detected' && item.evidence ? `Detected in ${item.evidence.path}` : 'Declared',
    summary: ['Selected', ...(service ? ['not connected'] : []), tested ? `run by the pilot suite on ${testedAxis.label.replace(/^.*\((.*)\)$/, '$1')}` : 'not tested'].join(' · '),
    axes,
    gates: native2.length > 0 ? targetGates((e?.targets ?? []) as StackTarget[], { webChecks: 'not_run', native }) : [],
    disconnect: service ? { enabled: false, explanation: DISCONNECT } : null,
  };
}

const STATE_EXPLANATION = {
  not_decided: 'Not decided yet. Workers are told nothing about this category.',
  none: 'None: this component uses nothing here. It does not turn off any platform verification or security policy.',
  selected: 'Recorded as your stack. Selecting does not authenticate, install, request or change the repository.',
} as const;

export function categoryRows(component: StackComponent, section: StackSection, native: NativeCapabilities = NO_NATIVE): CategoryRow[] {
  return STACK_CATEGORIES.filter((c) => c.section === section).map((c) => {
    const s = component.categories[c.id];
    const items = s.state === 'selected' ? s.items.map((i) => itemRow(i, native, component.targets)) : [];
    return {
      id: c.id, label: c.label, state: s.state, items, explanation: STATE_EXPLANATION[s.state],
      stateLabel: s.state === 'none' ? 'None · not used' : s.state === 'not_decided' ? 'Not decided' : `Selected (${items.length})`,
    };
  });
}

export interface ComponentRow {
  readonly path: string;
  readonly name: string;
  readonly targets: string;
  readonly decided: number;
  readonly undecided: number;
  /** Native gates that are incomplete for this component's targets. */
  readonly gates: readonly TargetGate[];
  /** The package/build tools and runtimes recorded, or how those categories stand. */
  readonly toolchain: string;
  /** Set when the component is labelled restricted or secret. */
  readonly restricted: boolean;
}

const stateText = (c: StackComponent, id: StackCategoryId): string => {
  const s = c.categories[id];
  if (s.state === 'none') return 'none';
  if (s.state === 'not_decided') return 'not decided';
  return s.items.map((i) => (i.kind === 'custom' ? i.label : `${stackEntry(i.entryId)?.label ?? i.entryId}${i.version ? ` ${i.version}` : ''}`)).join(', ');
};

export function componentRows(view: StackView): ComponentRow[] {
  return view.document.components.map((c) => {
    const states = Object.values(c.categories);
    return {
      path: c.path, name: c.name, targets: c.targets.map((t) => STACK_TARGET_LABELS[t]).join(', ') || 'None declared',
      decided: states.filter((s) => s.state !== 'not_decided').length, undecided: states.filter((s) => s.state === 'not_decided').length,
      gates: targetGates(c.targets, { webChecks: 'not_run', native: view.native }).filter((g) => g.state === 'incomplete' || g.state === 'not_assessed'),
      restricted: c.classification === 'restricted' || c.classification === 'secret',
      toolchain: `Package and build tools: ${stateText(c, 'package_build')} · Runtime: ${stateText(c, 'runtimes')}`,
    };
  });
}

export interface SearchOption {
  readonly entryId: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly category: StackCategoryId;
  readonly categoryLabel: string;
  readonly filter: StackFilter;
  readonly selected: boolean;
}
export interface SearchGroup {
  readonly group: string;
  readonly options: readonly SearchOption[];
}

/** Grouped catalog results for one section, each option placed in the first category of that section it is listed under, and marked when the component already has it. */
export function searchOptions(query: string, section: StackSection, filter: StackFilter | null, component: StackComponent | null): SearchGroup[] {
  return searchStack(query, { section, filter, limit: 40 }).map((g) => ({
    group: g.group,
    options: g.entries.map((e) => {
      const category = e.categories.find((c) => stackCategory(c).section === section)!;
      const s = component?.categories[category];
      return {
        entryId: e.id, label: e.label, aliases: e.aliases, category, categoryLabel: stackCategory(category).label, filter: e.filter,
        selected: s?.state === 'selected' && s.items.some((i) => i.kind === 'catalog' && i.entryId === e.id),
      };
    }),
  }));
}

const SKIP: Readonly<Record<string, string>> = { symlink: 'a symlink, not followed', too_large: 'too large to read', unreadable: 'could not be parsed', unsafe_path: 'an unsafe path', limit: 'over the file limit' };

export function detectionRows(view: StackView) {
  const d = view.document.detection;
  if (!d) return { commit: null, detectedAt: null, runner: null, items: [], commands: [], skipped: [] };
  return {
    commit: d.commit.slice(0, 12), detectedAt: d.detectedAt, runner: d.runnerId,
    items: d.items.map((i) => ({
      detectionId: i.detectionId, componentPath: i.componentPath, label: stackEntry(i.entryId)?.label ?? i.entryId, version: i.version,
      evidence: `${i.evidence.path} · ${i.evidence.detail}`, state: i.state, stateLabel: i.state === 'proposed' ? 'Proposed' : i.state === 'confirmed' ? 'Confirmed' : 'Dismissed', canSettle: i.state === 'proposed',
      category: stackEntry(i.entryId) ? stackCategory(stackEntry(i.entryId)!.categories[0]!).label : '',
    })),
    commands: d.commands.map((c) => ({ ...c, status: 'Proposed · needs review · not in effect' })),
    skipped: d.skipped.map((s) => `${s.path}: ${SKIP[s.reason] ?? s.reason}`),
  };
}
