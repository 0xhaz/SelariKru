import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt } from '@selarikru/view-protocol';
import { CommandNotSent } from '../../shell/projection-store.ts';
import { rejectionView } from '../decisions/copy.ts';
import { roleName } from './TeamSignals.tsx';
import type { AssignmentTarget, AssignmentsModel, ProviderChoice } from './assignments.ts';
import { assignmentStatus } from '../settings/model.ts';
import { StatusLine } from '../settings/SettingsPanel.tsx';

const selectClass = 'rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg';
const APPLIES = 'Applies to the next attempt. Work already running keeps its model.';
/** Why no assignment can be sent while the session is not live. */
export const ASSIGNMENTS_OFF = 'Assignments are off until the connection is live, so nothing is changed on stale state.';
const STALE_ASSIGNMENT = 'This assignment changed in the meantime. Nothing was saved; choose again.';

interface AssignProps {
  readonly model: AssignmentsModel;
  /** Non-null: no change can be sent now, and this says why. */
  readonly disabledReason: string | null;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
  /** Keeps control ids unique when the same assignment is also on the page behind, as a role's is under the drawer on the Team view. */
  readonly idScope?: string;
}

const text = (t: AssignmentTarget): string => (t.scope === 'role' ? roleName(t.label) : t.label);

const sameModel = (a: AssignmentTarget['current'], b: AssignmentTarget['current']): boolean => a !== null && b !== null && a.provider === b.provider && a.model === b.model;

/** What the dropdowns show: what applies now, so an untouched row has nothing to save. */
function choiceFor(providers: readonly ProviderChoice[], target: AssignmentTarget): { provider: string; model: string } {
  const applies = target.current ?? target.inherited;
  const provider = providers.find((p) => p.provider === applies?.provider) ?? providers[0]!;
  const model = provider.models.find((m) => m.modelId === applies?.model) ?? provider.models.find((m) => m.allowed) ?? provider.models[0]!;
  return { provider: provider.provider, model: model.modelId };
}

/** One assignment: provider, model, and a Save whose outcome is reported beside it. Only a person pressing Save sends anything. */
function AssignmentRow({ target, model, disabledReason, onExecute, onRefresh, onResync, idScope = '' }: AssignProps & { target: AssignmentTarget }) {
  const ids = useMemo(() => `${idScope}${target.scope}-${target.key}`.replace(/[^A-Za-z0-9_-]/g, '_'), [idScope, target.scope, target.key]);
  const [choice, setChoice] = useState(() => choiceFor(model.providers, target));
  // A save, a clear or a resync changes what applies: the dropdowns follow it rather than holding an old choice.
  const appliesKey = `${target.revision}|${target.current?.provider}/${target.current?.model}|${target.inherited?.provider}/${target.inherited?.model}`;
  useEffect(() => { setChoice(choiceFor(model.providers, target)); }, [appliesKey]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'refused'; text: string } | null>(null);
  // One key per intended change, kept across a network failure so a retry cannot apply it twice.
  const keys = useRef(new Map<string, string>());
  const provider = model.providers.find((p) => p.provider === choice.provider) ?? model.providers[0]!;
  const chosen = provider.models.find((m) => m.modelId === choice.model) ?? provider.models[0]!;
  const refusal = chosen.allowed ? null : chosen.refusal;
  const unchanged = sameModel(choice, target.current ?? target.inherited);
  const blocked = disabledReason ?? (refusal !== null ? 'Choose a model policy allows.' : null);
  const noun = text(target);
  // The panel header already says when a role's change applies; a task's override sits alone in the drawer, so it says so itself.
  const note = refusal ? `${refusal} Choose another model. Saving this is refused.` : disabledReason ?? (target.scope === 'task' ? APPLIES : null);

  async function send(selection: { provider: string; model: string } | null, intent: string): Promise<void> {
    const keyId = `${target.scope}:${target.key}:${intent}:${target.revision}`;
    const idempotencyKey = keys.current.get(keyId) ?? `assign-${crypto.randomUUID()}`;
    keys.current.set(keyId, idempotencyKey);
    setBusy(true);
    setFeedback(null);
    const command: AuthorizedViewCommand = { command: 'assignment.set', expectedRevision: target.revision, idempotencyKey, args: { projectId: model.projectId, scope: target.scope, key: target.key, selection } };
    let receipt: CommandReceipt;
    try {
      receipt = await onExecute(command);
    } catch (e) {
      setBusy(false);
      setFeedback({ kind: 'refused', text: e instanceof CommandNotSent ? 'Not sent: the connection dropped before this could go out, so nothing changed.' : 'The server could not be reached, so we cannot say whether this was saved. Trying again is safe.' });
      return;
    }
    setBusy(false);
    keys.current.delete(keyId);
    if (receipt.accepted) {
      setFeedback({ kind: 'ok', text: selection === null ? `${target.fallback} from the next attempt.` : `Saved for ${noun}. ${APPLIES}` });
      onRefresh();
      return;
    }
    const view = rejectionView(receipt.rejection);
    setFeedback({ kind: 'refused', text: receipt.rejection === 'stale_revision' ? STALE_ASSIGNMENT : view.text });
    onResync();
  }

  const onProvider = (next: string): void => {
    const p = model.providers.find((x) => x.provider === next)!;
    setChoice({ provider: next, model: (p.models.find((m) => m.allowed) ?? p.models[0]!).modelId });
    setFeedback(null);
  };

  return (
    <div data-testid="assignment-row" data-assignment-key={target.key}>
      <p className="font-medium text-fg wrap-anywhere">{noun}</p>
      <p className="mt-0.5 text-sm text-muted wrap-anywhere" data-testid="assignment-current">
        {target.current ? <>Assigned <span className="font-mono text-mono">{target.current.provider} / {target.current.model}</span></> : target.fallback}
      </p>
      {/* A saved assignment is in force only once the runners confirm it. A state the source did not report reads as unknown, never as applied. */}
      {target.state !== null ? <div className="mt-1"><StatusLine status={assignmentStatus(target.state === 'unknown' ? undefined : target.state, target.waitingOn)} testId="assignment-status" /></div> : null}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <label htmlFor={`${ids}-provider`} className="mb-1 block text-sm text-muted">Provider<span className="sr-only"> for {noun}</span></label>
          <select id={`${ids}-provider`} className={selectClass} value={choice.provider} disabled={busy} onChange={(e) => onProvider(e.target.value)}>
            {model.providers.map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${ids}-model`} className="mb-1 block text-sm text-muted">Model<span className="sr-only"> for {noun}</span></label>
          <select id={`${ids}-model`} className={`${selectClass} max-w-full`} value={choice.model} disabled={busy} onChange={(e) => { setChoice((c) => ({ ...c, model: e.target.value })); setFeedback(null); }}>
            {provider.models.map((m) => <option key={m.modelId} value={m.modelId}>{m.label}{m.allowed ? '' : ' (not allowed by policy)'}</option>)}
          </select>
        </div>
        <button type="button" className={buttonPrimary} disabled={blocked !== null || busy || unchanged} aria-describedby={note !== null ? `${ids}-note` : undefined} onClick={() => void send({ provider: choice.provider, model: choice.model }, `${choice.provider}/${choice.model}`)}>{busy ? 'Saving' : `Save for ${noun}`}</button>
        {target.current ? <button type="button" className={buttonQuiet} disabled={disabledReason !== null || busy} onClick={() => void send(null, 'clear')}>{target.scope === 'role' ? 'Use project default' : 'Use role assignment'}</button> : null}
      </div>
      {note !== null ? <p id={`${ids}-note`} className={refusal ? 'mt-2 rounded-chip border border-danger bg-danger-tint p-2 text-sm text-fg wrap-anywhere' : 'mt-1 text-sm text-muted wrap-anywhere'} data-testid={refusal ? 'assignment-refusal' : undefined}>{note}</p> : null}
      {feedback ? <p role={feedback.kind === 'ok' ? 'status' : 'alert'} data-testid="assignment-feedback" className={`mt-2 rounded-chip border p-2 text-sm wrap-anywhere ${feedback.kind === 'ok' ? 'border-active bg-active-tint text-fg' : 'border-danger bg-danger-tint text-fg'}`}>{feedback.text}</p> : null}
    </div>
  );
}

/** Roles and the model each is assigned, chosen before launch. */
export function ModelAssignmentsPanel(props: AssignProps) {
  const { model } = props;
  return (
    <div data-testid="model-assignments">
    <Panel title="Model assignments" labelId="team-assignments-title" aside={model.available ? APPLIES : null} className="mb-6">
      {model.codingWorkersNote ? <p className="mb-3 rounded-chip border border-line bg-panel-2 p-2.5 text-sm text-fg" data-testid="coding-workers-off">{model.codingWorkersNote}</p> : null}
      {!model.available ? (
        <p className="text-fg" data-testid="assignment-unavailable">{model.statusText}</p>
      ) : model.roles.length === 0 ? (
        <p className="text-muted">Roles appear here once a plan is accepted.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
          {model.roles.map((r) => <li key={r.key} className="min-w-0"><AssignmentRow {...props} target={r} /></li>)}
        </ul>
      )}
    </Panel>
    </div>
  );
}

/** H9: Claude Code workers are off in the hackathon build: their model controls are not shown. */
export const codingWorkersOff = (model: { readonly codingWorkersNote: string | null }): boolean => model.codingWorkersNote !== null;

/** One task's override, in the drawer. A benchmark trial shows its pin instead: there is nothing to change. */
export function TaskModelOverride({ target, ...props }: AssignProps & { target: AssignmentTarget }) {
  if (target.pinned) {
    return <p className="rounded-chip border border-line p-3 text-sm text-muted" data-testid="trial-pin">Benchmark trial: every attempt uses <span className="font-mono text-mono text-fg">{target.pinned.provider} / {target.pinned.model}</span>. Overrides are refused.</p>;
  }
  if (!props.model.available) return <p className="text-sm text-muted">{props.model.statusText}</p>;
  return (
    <section aria-label="Model for this task" className="rounded-chip border border-line p-3">
      <h3 className="mb-2 font-medium text-fg">Model override for this task</h3>
      <AssignmentRow {...props} target={target} />
    </section>
  );
}

/** One role's assignment, in the drawer: the same control as the Team view's panel, for the role this worker's task belongs to. */
export function RoleModelAssignment({ target, ...props }: AssignProps & { target: AssignmentTarget }) {
  if (!props.model.available) return null;
  return (
    <section aria-label={`Model for every ${roleName(target.label)} task`} className="rounded-chip border border-line p-3">
      <h3 className="mb-2 font-medium text-fg">Model for every {roleName(target.label)} task</h3>
      <AssignmentRow {...props} idScope="drawer-" target={target} />
    </section>
  );
}
