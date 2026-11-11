import { useEffect, useId, useRef, useState } from 'react';
import { Chip, Panel, buttonDanger, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt } from '@selarikru/view-protocol';
import { CommandNotSent } from '../../shell/projection-store.ts';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';
import { NETWORK_MESSAGE, NOT_SENT_MESSAGE, rejectionView } from '../decisions/copy.ts';
import { roleLabel } from '@selarikru/domain';
import { suggestedName } from '../team/name-suggestions.ts';
import type { AutonomyModel, AutoDelegateModel, FieldStatus, PmNameModel, SettingAction, WorkerControlsModel } from './model.ts';

export interface SendProps {
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
}

/** What a receipt says, and never more: a save the server enforces is in force; anything a runner holds is saved and waiting for it. */
function savedText(action: SettingAction, receipt: CommandReceipt): string {
  if (action.intent.command === 'run.cancel') return receipt.execution === 'applied' ? 'Run cancelled: nothing was running.' : 'Cancel requested. The run is cancelled once its running attempts have ended.';
  return receipt.execution === 'applied' ? 'Saved. The server enforces it from now; the status below follows the server.' : 'Saved. Not in force until the runner confirms it; the status below says when.';
}

/** One sender per surface: an idempotency key per intended change, kept across a network failure so a retry cannot apply it twice. */
function useSender({ onExecute, onRefresh, onResync }: SendProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'refused'; text: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  async function send(action: SettingAction): Promise<void> {
    const keyId = `${action.id}:${JSON.stringify(action.intent)}`;
    const idempotencyKey = keys.current.get(keyId) ?? `setting-${crypto.randomUUID()}`;
    keys.current.set(keyId, idempotencyKey);
    setBusy(action.id);
    setFeedback(null);
    let receipt: CommandReceipt;
    try {
      receipt = await onExecute({ ...action.intent, idempotencyKey } as AuthorizedViewCommand);
    } catch (e) {
      setBusy(null);
      setFeedback({ kind: 'refused', text: e instanceof CommandNotSent ? NOT_SENT_MESSAGE : NETWORK_MESSAGE });
      return;
    }
    setBusy(null);
    keys.current.delete(keyId);
    if (receipt.accepted) {
      setFeedback({ kind: 'ok', text: savedText(action, receipt) });
      onRefresh();
      return;
    }
    setFeedback({ kind: 'refused', text: receipt.rejection === 'stale_revision' ? 'This setting changed in the meantime. Nothing was saved; look again.' : rejectionView(receipt.rejection).text });
    onResync();
  }
  return { busy, feedback, send };
}

export function StatusLine({ status, testId = 'setting-status' }: { status: FieldStatus | null; testId?: string }) {
  if (!status) return null;
  return (
    <div data-testid={testId} data-in-force={status.inForce ? 'true' : 'false'} className="space-y-1">
      <Chip tone={status.tone}>{status.label}</Chip>
      <p className="text-sm text-muted wrap-anywhere">{status.detail}</p>
    </div>
  );
}

function Feedback({ feedback }: { feedback: { kind: 'ok' | 'refused'; text: string } | null }) {
  if (!feedback) return null;
  return <p role={feedback.kind === 'ok' ? 'status' : 'alert'} data-testid="setting-feedback" className={`rounded-chip border p-2 text-sm wrap-anywhere ${feedback.kind === 'ok' ? 'border-active bg-active-tint text-fg' : 'border-danger bg-danger-tint text-fg'}`}>{feedback.text}</p>;
}

function ActionButton({ action, busy, style = buttonQuiet, onClick }: { action: SettingAction; busy: string | null; style?: string; onClick: () => void }) {
  const reasonId = useId();
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" data-action={action.id} className={`${style} ${busy !== null ? 'cursor-wait opacity-60' : ''}`} disabled={action.disabledReason !== null} aria-disabled={busy !== null ? true : undefined} aria-describedby={action.disabledReason !== null ? reasonId : undefined} onClick={() => { if (busy === null) onClick(); }}>
        {action.label}{busy === action.id ? <><span aria-hidden="true" className="ml-1.5">· Sending</span><span className="sr-only"> (sending)</span></> : null}
      </button>
      {action.disabledReason !== null ? <span id={reasonId} className="text-sm text-muted">{action.disabledReason}</span> : null}
    </span>
  );
}

/**
 * The run's effective policy, read from the server, and the controls that change it in place: pause and resume, cancel, the approved paths, cloud and the
 * budget. Every change is a save that says when it is in force; none is shown as applied until the snapshot says so.
 */
export function BoundedAutonomyPanel({ model, ...send }: SendProps & { model: AutonomyModel }) {
  const { busy, feedback, send: dispatch } = useSender(send);
  const [confirming, setConfirming] = useState<SettingAction | null>(null);
  const [limit, setLimit] = useState(model.budget.value === null ? '' : String(model.budget.value));
  useEffect(() => { setLimit(model.budget.value === null ? '' : String(model.budget.value)); }, [model.budget.value, model.budget.revision]);
  const budgetId = useId();
  const parsed = limit.trim() === '' ? null : Number(limit);
  const budgetValid = parsed !== null && Number.isFinite(parsed) && parsed >= 0;
  const budgetAction: SettingAction = {
    id: 'budget', label: 'Save budget', confirm: null, disabledReason: model.budget.disabledReason ?? (budgetValid ? null : 'Enter an amount in USD.'),
    intent: { command: 'setting.set', expectedRevision: model.budget.revision, args: { projectId: model.projectId, key: model.runId, change: { scope: 'run', field: 'budget_limit_usd', value: budgetValid ? parsed! : 0 } } },
  };
  return (
    <Panel title="Bounded autonomy" labelId="autonomy-title" aside={model.simulated ? 'Demo data: simulated policy' : 'From the server'}>
      <div className="space-y-5" data-testid="bounded-autonomy">
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
          {model.rows.map((r) => (
            <div key={r.key} className="contents" data-testid="policy-row" data-policy={r.key}>
              <dt className="text-sm text-muted">{r.label}</dt>
              <dd className="min-w-0 text-sm text-fg">
                <span className="wrap-anywhere">{r.value}</span> <Chip tone={r.tone}>{r.basis}</Chip>
                {r.note ? <span className="mt-0.5 block text-muted">{r.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>

        <Feedback feedback={feedback} />

        <section aria-label="Scheduling" className="space-y-2 rounded-chip border border-line p-3" data-testid="run-pause">
          <h3 className="font-medium text-fg">Scheduling</h3>
          <StatusLine status={model.pause.status} testId="pause-status" />
          {!model.pause.status ? <p className="text-sm text-muted">Work is assigned within the limits above. Pausing stops new assignments at once; attempts already running continue.</p> : null}
          <ActionButton action={model.pause.action} busy={busy} onClick={() => void dispatch(model.pause.action)} />
        </section>

        <section aria-label="Approved paths" className="space-y-2 rounded-chip border border-line p-3" data-testid="run-paths">
          <h3 className="font-medium text-fg">Approved paths</h3>
          <p className="text-sm text-muted">Removing a path blocks every task that needs it at once, and stops a running attempt that needs it. A path the plan does not list needs a plan revision.</p>
          <StatusLine status={model.paths.status} />
          <ul className="flex flex-wrap gap-2">
            {model.paths.items.map((i) => (
              <li key={i.path} className="flex items-center gap-2 rounded-chip border border-line px-2 py-1">
                <span className="font-mono text-mono text-sm">{i.path}</span><Chip tone={i.allowed ? 'neutral' : 'warning'}>{i.allowed ? 'Allowed' : 'Removed'}</Chip>
                <ActionButton action={i.action} busy={busy} onClick={() => void dispatch(i.action)} />
              </li>
            ))}
          </ul>
        </section>

        {model.affected.length > 0 ? (
          <section aria-label="Blocked by a revoke" className="space-y-2 rounded-chip border border-l-4 border-warning p-3" data-testid="revoke-affected">
            <h3 className="font-medium text-fg">Blocked by a revoke</h3>
            <ul className="space-y-1 text-sm">
              {model.affected.map((a) => <li key={a.taskId} data-task-id={a.taskId}><span className="font-medium text-fg">{a.title}</span>: <span className="text-muted">{a.label}</span></li>)}
            </ul>
          </section>
        ) : null}

        <section aria-label="Budget" className="space-y-2 rounded-chip border border-line p-3" data-testid="run-budget">
          <h3 className="font-medium text-fg">Budget</h3>
          <p className="text-sm text-muted">A lower limit applies at once; below what is already committed, running work is stopped. A higher one is held to the most recorded for this run.</p>
          <StatusLine status={model.budget.status} />
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={budgetId} className="mb-1 block text-sm text-muted">Limit in USD</label>
              <input id={budgetId} inputMode="decimal" className="w-32 rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </div>
            <ActionButton action={budgetAction} busy={busy} style={buttonPrimary} onClick={() => void dispatch(budgetAction)} />
          </div>
        </section>

        {model.cloud ? (
          <section aria-label="Cloud" className="space-y-2 rounded-chip border border-line p-3" data-testid="run-cloud">
            <h3 className="font-medium text-fg">Cloud</h3>
            <StatusLine status={model.cloud.status} />
            <ActionButton action={model.cloud.action} busy={busy} onClick={() => void dispatch(model.cloud!.action)} />
          </section>
        ) : null}

        <section aria-label="Cancel run" className="space-y-2 rounded-chip border border-line p-3" data-testid="run-cancel">
          <h3 className="font-medium text-fg">Cancel run</h3>
          <StatusLine status={model.cancel.status} testId="cancel-status" />
          {model.cancel.action ? <ActionButton action={model.cancel.action} busy={busy} style={buttonDanger} onClick={() => setConfirming(model.cancel.action)} /> : null}
        </section>
      </div>
      {confirming && confirming.confirm ? (
        <ConfirmDialog copy={confirming.confirm} confirmLabel={confirming.label} onKeep={() => setConfirming(null)} onConfirm={() => { const a = confirming; setConfirming(null); void dispatch(a); }} />
      ) : null}
    </Panel>
  );
}

/** A worker's own settings in its drawer: enabled and slots. Each is a save the runner confirms on its next heartbeat; the server enforces it from the save. */
export function WorkerSettingControls({ model, workerId, ...send }: SendProps & { model: WorkerControlsModel; workerId: string }) {
  const { busy, feedback, send: dispatch } = useSender(send);
  const slotsId = useId();
  const [slots, setSlots] = useState(String(model.slots.value ?? model.slots.options.at(-1) ?? 1));
  useEffect(() => { setSlots(String(model.slots.value ?? model.slots.options.at(-1) ?? 1)); }, [model.slots.value, model.slots.revision]);
  const nameId = useId();
  const roleId = useId();
  const [name, setName] = useState(model.name.value);
  useEffect(() => { setName(model.name.value); }, [model.name.value, model.name.revision]);
  const [role, setRole] = useState(model.role.value ?? '');
  useEffect(() => { setRole(model.role.value ?? ''); }, [model.role.value, model.role.revision]);
  const trimmed = name.trim();
  const nameAction: SettingAction = {
    id: 'name', label: 'Save name', confirm: null,
    disabledReason: model.name.disabledReason ?? (trimmed === '' ? 'Enter a name.' : [...trimmed].length > 24 ? 'At most 24 characters.' : trimmed === model.name.value ? 'Change the name to save it.' : null),
    intent: { command: 'setting.set', expectedRevision: model.name.revision, args: { projectId: model.name.projectId, key: workerId, change: { scope: 'runner', field: 'display_name', value: trimmed } } },
  };
  const roleAction: SettingAction = {
    id: 'role', label: 'Save role', confirm: null,
    disabledReason: model.role.disabledReason ?? (role === '' ? 'Choose a role.' : role === model.role.value ? 'Choose another role to save it.' : null),
    intent: { command: 'setting.set', expectedRevision: model.role.revision, args: { projectId: model.role.projectId, key: workerId, change: { scope: 'runner', field: 'role', value: role } } },
  };
  const slotAction: SettingAction = {
    id: 'slots', label: 'Save slots', confirm: null, disabledReason: model.slots.disabledReason,
    intent: { command: 'setting.set', expectedRevision: model.slots.revision, args: { projectId: model.slots.projectId, key: workerId, change: { scope: 'runner', field: 'slots', value: Number(slots) } } },
  };
  return (
    <div className="space-y-3" data-testid="worker-controls">
      <Feedback feedback={feedback} />
      <div className="space-y-2 rounded-chip border border-line p-3" data-testid="worker-name">
        <p className="text-sm text-fg">Name: how this worker is shown everywhere, as "Name · Role". 1 to 24 characters in any script, different from the other workers' names.</p>
        <StatusLine status={model.name.status} />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-sm text-muted">Name</label>
            <input id={nameId} data-testid="worker-name-input" maxLength={48} className="w-48 rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={name} placeholder={suggestedName(model.name.projectId, model.role.value) ?? roleLabel(model.role.value)} onChange={(e) => setName(e.target.value)} />
          </div>
          <ActionButton action={nameAction} busy={busy} onClick={() => void dispatch(nameAction)} />
        </div>
      </div>
      <div className="space-y-2 rounded-chip border border-line p-3" data-testid="worker-role">
        <p className="text-sm text-fg">Role: this worker takes only its role's tasks, from its next attempt. An attempt already running finishes under the role it started with.</p>
        <StatusLine status={model.role.status} />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={roleId} className="mb-1 block text-sm text-muted">Role</label>
            <select id={roleId} data-testid="worker-role-select" className="rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={role} onChange={(e) => setRole(e.target.value)}>
              {model.role.value === null ? <option value="">Not set (the task's role)</option> : null}
              {model.role.options.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>
          <ActionButton action={roleAction} busy={busy} onClick={() => void dispatch(roleAction)} />
        </div>
      </div>
      <div className="space-y-2 rounded-chip border border-line p-3" data-testid="worker-enabled">
        <p className="text-sm text-fg">{model.enabled.detail}</p>
        <StatusLine status={model.enabled.status} />
        <ActionButton action={model.enabled.action} busy={busy} onClick={() => void dispatch(model.enabled.action)} />
      </div>
      <div className="space-y-2 rounded-chip border border-line p-3" data-testid="worker-slots">
        <p className="text-sm text-fg">Slots: how many attempts this worker may hold at once. Fewer applies as current attempts finish; it never stops one.</p>
        <StatusLine status={model.slots.status} />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={slotsId} className="mb-1 block text-sm text-muted">Slots</label>
            <select id={slotsId} className="rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={slots} onChange={(e) => setSlots(e.target.value)}>
              {model.slots.options.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <ActionButton action={slotAction} busy={busy} onClick={() => void dispatch(slotAction)} />
        </div>
      </div>
    </div>
  );
}

/**
 * H11: Settings › Workflow. On, the Project Manager's assignments apply by themselves, only inside your accepted plan; off, each one waits for you. Fix round 1: the
 * Project Manager's name (before any worker holds the role) and the owner's grant for web research live here too.
 */
export function AutoDelegatePanel({ model, research, name, ...send }: SendProps & { model: AutoDelegateModel; research?: AutoDelegateModel | null; name?: PmNameModel | null }) {
  const { busy, feedback, send: dispatch } = useSender(send);
  const nameId = useId();
  const [pmName, setPmName] = useState(name?.value ?? '');
  useEffect(() => { setPmName(name?.value ?? ''); }, [name?.value, name?.revision]);
  const trimmed = pmName.trim();
  const nameAction: SettingAction | null = name ? {
    id: 'pm-name', label: 'Save name', confirm: null,
    disabledReason: name.disabledReason ?? ([...trimmed].length > 24 ? 'At most 24 characters.' : trimmed === name.value ? 'Change the name to save it.' : null),
    intent: { command: 'setting.set', expectedRevision: name.revision, args: { projectId: name.projectId, key: name.runId, change: { scope: 'run', field: 'pm_display_name', value: trimmed === '' ? null : trimmed } } },
  } : null;
  return (
    <Panel title="Project Manager" labelId="settings-auto-delegate-title" aside={model.on ? 'Auto-delegate on' : 'Auto-delegate off'}>
      <div className="space-y-3" data-testid="auto-delegate" data-on={model.on ? 'true' : 'false'}>
        {name && nameAction ? (
          <div className="flex flex-wrap items-end gap-3" data-testid="pm-name">
            <div>
              <label htmlFor={nameId} className="mb-1 block text-sm text-muted">Name (shown at the PLAN desk; empty: Project Manager)</label>
              <input id={nameId} data-testid="pm-name-input" maxLength={48} placeholder="Project Manager" className="w-48 rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={pmName} onChange={(e) => setPmName(e.target.value)} />
            </div>
            <ActionButton action={nameAction} busy={busy} onClick={() => void dispatch(nameAction)} />
          </div>
        ) : null}
        <p className="text-sm text-fg">{model.on
          ? 'Auto-delegate is on: the Project Manager assigns tasks to workers by itself, only among your accepted plan\'s tasks, to enabled workers of the task\'s role. It never changes a path, a budget or a task. Anything outside the plan waits for you.'
          : 'Auto-delegate is off: the Project Manager\'s assignments are proposals only. Nothing is assigned until you do it.'}</p>
        <Feedback feedback={feedback} />
        <StatusLine status={model.status} />
        <ActionButton action={model.action} busy={busy} onClick={() => void dispatch(model.action)} />
        {research ? (
          <section aria-label="Web research" className="space-y-2 rounded-chip border border-line p-3" data-testid="web-research" data-on={research.on ? 'true' : 'false'}>
            <h3 className="font-medium text-fg">Google Search (web research)</h3>
            <p className="text-sm text-fg">{research.on
              ? 'On: the Project Manager may send your question, and only your question, to Google Search through the cloud model. Never for restricted work or a task you set to device only.'
              : 'Off: the Project Manager does not search the web. Turning it on lets it send only your question to Google Search through the cloud model; never a task, its context or restricted work.'}</p>
            <StatusLine status={research.status} />
            <ActionButton action={research.action} busy={busy} onClick={() => void dispatch(research.action)} />
          </section>
        ) : null}
      </div>
    </Panel>
  );
}
