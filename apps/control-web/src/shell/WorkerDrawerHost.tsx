import { useMemo } from 'react';
import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, ProjectViewSnapshot, TerminalChannel, TerminalControlChannel } from '@selarikru/view-protocol';
import type { DecisionsModel } from '../features/decisions/model.ts';
import { ASSIGNMENTS_OFF } from '../features/team/ModelAssignments.tsx';
import type { TeamModel } from '../features/team/model.ts';
import { workerSettings } from '../features/team/settings.ts';
import { WorkerDrawer, type DrawerIdentity, type TabId } from '../features/team/WorkerDrawer.tsx';
import { roleName } from '../features/team/TeamSignals.tsx';
import { chipStyle, stateStyle, type RobotState } from '../theme/tokens.ts';
import { Portrait } from './hud/Portrait.tsx';
import { decisionHref } from './route.ts';
import { WorkerSettings } from '../features/team/WorkerSettings.tsx';
import { workerControls } from '../features/settings/model.ts';
import type { BrainPort, ConnectionState, HandoverPort, SkillsPort } from './projection-store.ts';
import { DrawerHandover } from '../features/handover/ContinueInCloud.tsx';
import { AttemptSkillsPanel } from '../features/skills/AttemptSkillsPanel.tsx';
import { ContextPanel } from '../features/brain/ContextPanel.tsx';
import { PANEL_WIDE, useMediaQuery } from './media.ts';

/** The worker's robot and state, from the office world, so the drawer header matches its card. */
export interface DrawerLook {
  readonly color: string;
  readonly name: string;
  readonly state: RobotState;
}

export interface WorkerDrawerHostProps {
  readonly look?: DrawerLook | null;
  readonly workerId: string;
  readonly tab: TabId | undefined;
  readonly team: TeamModel;
  readonly snapshot: ProjectViewSnapshot;
  readonly decisions: DecisionsModel | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onTab: (tab: TabId) => void;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
  readonly onOpenTerminal: (request: AuthorizedTerminalRequest) => Promise<TerminalChannel>;
  readonly onOpenTerminalControl: ((request: AuthorizedTerminalRequest) => TerminalControlChannel) | undefined;
  readonly brain?: BrainPort | null;
  readonly skills?: SkillsPort | null;
  readonly handover?: HandoverPort | null;
}

/** One worker's drawer, opened over whichever view is showing. Its Settings tab sends through the same commands and rules as the Team and Decisions screens. */
export function WorkerDrawerHost({ look = null, workerId, tab, team, snapshot, decisions, connection, mode, nowMs, onClose, onTab, onExecute, onRefresh, onResync, onOpenTerminal, onOpenTerminalControl, brain = null, skills = null, handover = null }: WorkerDrawerHostProps) {
  const wide = useMediaQuery('(min-width: 1024px)');
  // Beside the team panel the drawer is not modal, so another worker can be chosen with it open. Narrower, it covers the page and is.
  const panelBeside = useMediaQuery(PANEL_WIDE);
  const row = team.rows.find((r) => r.workerId === workerId);
  const settings = useMemo(() => (row ? workerSettings(snapshot, decisions, row) : null), [snapshot, decisions, row]);
  const live = connection === 'live';
  // A worker is a runner: the drawer shows its runner settings only for a real runner id, never for a placeholder made from an attempt.
  const controls = useMemo(() => (row && !row.workerId.startsWith('attempt:') ? workerControls(snapshot, row.workerId, live) : null), [snapshot, row, live]);
  // The header line and session bar: read from the worker, its attempt and the harness catalog the runners report. Nothing here is chosen.
  const identity = useMemo((): DrawerIdentity | null => {
    if (!row) return null;
    const w = snapshot.workers[row.workerId];
    const attempt = w?.attemptId ? snapshot.attempts[w.attemptId] : undefined;
    const rec = row.assignment;
    const harness = rec ? snapshot.modelCatalog.providers.find((p) => p.provider === rec.provider) : undefined;
    const agent = rec ? `${harness?.label ?? rec.provider}${harness?.harnessVersion ? ` ${harness.harnessVersion}` : ''} ${rec.model}` : 'Coding agent not recorded';
    const runtime = row.execution === 'local' ? 'Local sandbox' : row.execution === 'cloud' ? 'Cloud sandbox' : 'Runtime unknown';
    const running = attempt !== undefined && attempt.endedAt === null && attempt.outcome === 'running';
    const session = running
      ? { state: 'running' as const, label: 'Session running' }
      : attempt !== undefined ? { state: 'stopped' as const, label: 'Stopped' } : { state: 'idle' as const, label: 'Idle' };
    const name = look?.name ?? roleName(row.role);
    const chip = look ? { label: stateStyle[look.state].label, ...chipStyle[look.state] } : { label: row.presence.label, bg: '#f0dfc2', fg: '#241a2e' };
    return {
      portrait: look ? <Portrait color={look.color} size={48} /> : null,
      name,
      chip,
      line: `${roleName(row.role)} · ${agent} · ${runtime}`,
      // The snapshot names no workspace path; the attempt is what identifies the sandbox's work.
      session: { ...session, workspace: attempt ? `Attempt ${attempt.number} · ${attempt.attemptId}` : 'No attempt yet' },
      activity: row.presence.detail ?? row.activity.label,
    };
  }, [row, snapshot, look]);
  if (!row || !settings) return null;
  const messages = settings.cards.length > 0 ? (
    <ul className="space-y-2" data-testid="drawer-messages">
      {settings.cards.map(({ card }) => (
        <li key={card.id} className="panel flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="chip" style={{ background: '#f0dfc2' }}>{card.chip}</span>
          <span className="min-w-0 flex-1 truncate font-semibold text-fg" title={card.title}>{card.title}</span>
          <a className="text-sm font-medium text-active underline underline-offset-2" href={decisionHref(card.id)}>Open in Action items</a>
        </li>
      ))}
    </ul>
  ) : null;
  const assign = { model: team.assignments, disabledReason: live ? null : ASSIGNMENTS_OFF, onExecute, onRefresh, onResync };
  return (
    <WorkerDrawer
      key={row.workerId}
      row={row}
      mode={mode}
      simulated={team.simulated}
      wide={wide}
      modal={!panelBeside}
      nowMs={nowMs}
      onClose={onClose}
      {...(tab ? { initialTab: tab } : {})}
      onTab={onTab}
      settings={(openTerminal) => <WorkerSettings row={row} settings={settings} assign={assign} live={live} onExecute={onExecute} onRefresh={onRefresh} onResync={onResync} onTerminal={openTerminal} controls={controls} />}
      onOpenTerminal={onOpenTerminal}
      onOpenTerminalControl={onOpenTerminalControl}
      handover={<DrawerHandover port={handover} taskId={row.terminalTarget?.taskId ?? null} title={row.terminalTarget ? snapshot.tasks[row.terminalTarget.taskId]?.title ?? null : null} refreshKey={snapshot.meta.cursor} live={live} />}
      identity={identity}
      messages={messages}
      context={<div className="space-y-4"><AttemptSkillsPanel attemptId={row.terminalTarget?.attemptId ?? null} port={skills} /><ContextPanel attemptId={row.terminalTarget?.attemptId ?? null} port={brain} /></div>}
    />
  );
}
