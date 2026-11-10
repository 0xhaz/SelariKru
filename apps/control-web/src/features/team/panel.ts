import type { Tone } from '@selarikru/ui';
import type { PresenceState, TeamModel } from './model.ts';

export interface PanelRow {
  readonly workerId: string;
  readonly role: string;
  readonly state: PresenceState;
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string | null;
  readonly since: string;
  readonly sinceIso: string;
  /** The task held now, or `Last: …` for the one it last worked on. */
  readonly task: string;
  /** The model its attempt was recorded to run; never a guess. */
  readonly model: string;
}

export interface TeamPanelModel {
  readonly rows: readonly PanelRow[];
  readonly needsYou: number;
  readonly summary: string;
}

const roleName = (role: string | null): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Unassigned');

/** The always-on roster, read from the Team model so the panel and the Team view can never disagree. Rows keep the Team view's attention order. */
export function panelOf(team: TeamModel): TeamPanelModel {
  const rows = team.rows.map((r): PanelRow => ({
    workerId: r.workerId, role: roleName(r.role), state: r.presence.state, label: r.presence.label, tone: r.presence.tone, detail: r.presence.detail, since: r.presence.since, sinceIso: r.presence.sinceIso,
    task: r.task ? r.task.title : r.lastTask ? `Last: ${r.lastTask.title}` : 'No task',
    model: r.modelDetail ?? 'Model not recorded',
  }));
  const needsYou = rows.filter((r) => r.state === 'needs_you').length;
  const summary = `${rows.length} worker${rows.length === 1 ? '' : 's'}, ${needsYou === 0 ? 'nobody needs you' : `${needsYou} need${needsYou === 1 ? 's' : ''} you`}`;
  return { rows, needsYou, summary };
}
