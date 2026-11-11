import type { Tone } from '@selarikru/ui';
import type { PresenceState, TeamModel } from './model.ts';

export interface PanelRow {
  readonly workerId: string;
  readonly role: string;
  /** H11: the owner-given name, shown first; null when none is set (the role shows alone). */
  readonly name: string | null;
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
  /** Null while the session is stale: every state is then the last confirmed, and a stale count could hide someone who needs you, so none is given as current. */
  readonly needsYou: number | null;
  /** Workers the server itself reports as unknown while the session is live. Only they are uncounted; the count covers the rest. */
  readonly unknown: number;
  /** Of the unknown rows, how many were last confirmed as needing you. They are not counted in `needsYou`, and they are never to be read as nobody. */
  readonly unknownLastNeedsYou: number;
  /** How many needed you at the last confirmation. Shown, labelled as such, only when `needsYou` is null. */
  readonly confirmedNeedsYou: number;
  readonly summary: string;
}

/** "1 unknown (last: needs you)": the unknown rows, and how many of them needed you when last confirmed. */
export function unknownText(unknown: number, lastNeedsYou: number): string {
  if (lastNeedsYou === 0) return `${unknown} unknown`;
  return unknown === 1 ? '1 unknown (last: needs you)' : `${unknown} unknown (${lastNeedsYou} last: needs you)`;
}

const roleName = (role: string | null): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Unassigned');

/** The always-on roster, read from the Team model so the panel and the Team view can never disagree. Rows keep the Team view's attention order. */
export function panelOf(team: TeamModel, sessionStale: boolean): TeamPanelModel {
  const rows = team.rows.map((r): PanelRow => ({
    workerId: r.workerId, role: roleName(r.role), name: r.name ?? null, state: r.presence.state, label: r.presence.label, tone: r.presence.tone, detail: r.presence.detail, since: r.presence.since, sinceIso: r.presence.sinceIso,
    task: r.task ? r.task.title : r.lastTask ? `Last: ${r.lastTask.title}` : 'No task',
    model: r.modelDetail ?? 'Model not recorded',
  }));
  const confirmedNeedsYou = team.rows.filter((r) => r.presence.confirmedState === 'needs_you').length;
  const unknown = sessionStale ? 0 : rows.filter((r) => r.state === 'unknown').length;
  const unknownLastNeedsYou = sessionStale ? 0 : rows.filter((r, i) => r.state === 'unknown' && team.rows[i]!.presence.confirmedState === 'needs_you').length;
  const needsYou = sessionStale ? null : rows.filter((r) => r.state === 'needs_you').length;
  const workers = `${rows.length} worker${rows.length === 1 ? '' : 's'}`;
  const others = unknown > 0 ? unknownText(unknown, unknownLastNeedsYou) : null;
  // Zero is only "nobody" when no row is unknown: an unknown row could be the one that needs you.
  const counted = needsYou === null ? null : needsYou === 0 ? (others === null ? 'nobody needs you' : null) : `${needsYou} need${needsYou === 1 ? 's' : ''} you`;
  const summary = needsYou === null
    ? `${workers}, who needs you is unknown (${confirmedNeedsYou} when last confirmed)`
    : [workers, counted, others].filter((x) => x !== null).join(', ');
  return { rows, needsYou, unknown, unknownLastNeedsYou, confirmedNeedsYou, summary };
}
