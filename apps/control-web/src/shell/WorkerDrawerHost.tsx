import { useMemo } from 'react';
import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, ProjectViewSnapshot, TerminalChannel, TerminalControlChannel } from '@selarikru/view-protocol';
import type { DecisionsModel } from '../features/decisions/model.ts';
import { ASSIGNMENTS_OFF } from '../features/team/ModelAssignments.tsx';
import type { TeamModel } from '../features/team/model.ts';
import { workerSettings } from '../features/team/settings.ts';
import { WorkerDrawer, type TabId } from '../features/team/WorkerDrawer.tsx';
import { WorkerSettings } from '../features/team/WorkerSettings.tsx';
import type { ConnectionState } from './projection-store.ts';
import { PANEL_WIDE, useMediaQuery } from './media.ts';

export interface WorkerDrawerHostProps {
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
}

/** One worker's drawer, opened over whichever view is showing. Its Settings tab sends through the same commands and rules as the Team and Decisions screens. */
export function WorkerDrawerHost({ workerId, tab, team, snapshot, decisions, connection, mode, nowMs, onClose, onTab, onExecute, onRefresh, onResync, onOpenTerminal, onOpenTerminalControl }: WorkerDrawerHostProps) {
  const wide = useMediaQuery('(min-width: 1024px)');
  // Beside the team panel the drawer is not modal, so another worker can be chosen with it open. Narrower, it covers the page and is.
  const panelBeside = useMediaQuery(PANEL_WIDE);
  const row = team.rows.find((r) => r.workerId === workerId);
  const settings = useMemo(() => (row ? workerSettings(snapshot, decisions, row) : null), [snapshot, decisions, row]);
  if (!row || !settings) return null;
  const live = connection === 'live';
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
      settings={(openTerminal) => <WorkerSettings row={row} settings={settings} assign={assign} live={live} onExecute={onExecute} onRefresh={onRefresh} onResync={onResync} onTerminal={openTerminal} />}
      onOpenTerminal={onOpenTerminal}
      onOpenTerminalControl={onOpenTerminalControl}
    />
  );
}
