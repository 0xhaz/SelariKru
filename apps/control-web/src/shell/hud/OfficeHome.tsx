import type { ReactNode } from 'react';
import type { OfficeWorld } from '../../office/model.ts';
import { ROBOT_STATES, stateStyle } from '../../theme/tokens.ts';
import { hrefFor } from '../route.ts';

/**
 * The office screen's own words: a heading, the canvas summary in text, and a key to the robots' colours, each with its word. The canvas
 * behind it is a picture of the same facts; the team panel is the way in to each worker.
 */
export function OfficeHome({ world, banner, activity, devPanel }: { world: OfficeWorld | null; banner: ReactNode; activity: ReactNode; devPanel?: ReactNode }) {
  const shown = world ? ROBOT_STATES.filter((s) => world.agents.some((a) => a.state === s)) : [];
  return (
    <div className="pointer-events-none flex min-h-[calc(100dvh-var(--header-h,6rem))] flex-col gap-3 p-3 sm:p-4">
      <section aria-labelledby="office-title" data-testid="office-home" className="panel pointer-events-auto w-full max-w-[19rem] px-3 py-2">
        <h1 id="office-title" className="text-xl font-bold text-fg">Office</h1>
        <p className="text-sm text-fg" data-testid="office-summary">{world?.summary ?? 'No project data is connected, so the office is empty.'}</p>
        {shown.length > 0 ? (
          <ul aria-label="Robot colours" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid="office-legend">
            {shown.map((s) => (
              <li key={s} className="inline-flex items-center gap-1.5 text-fg">
                <span aria-hidden="true" className="swatch" style={{ background: stateStyle[s].color }} />
                <span aria-hidden="true">{stateStyle[s].glyph}</span>
                {stateStyle[s].label}
              </li>
            ))}
          </ul>
        ) : null}
        <details className="mt-2 text-sm text-muted" data-testid="office-help">
          <summary className="cursor-pointer font-semibold text-fg">How to use the office</summary>
          <p className="mt-1">Click a robot, or pick a worker in the team panel, to open it. Keys: <kbd className="kbd">1</kbd>–<kbd className="kbd">9</kbd> open a worker, <kbd className="kbd">+</kbd> and <kbd className="kbd">−</kbd> zoom. The plan wall opens <a className="text-active underline underline-offset-2" href={hrefFor('pipeline')}>Pipeline</a>; the gate and the PR board open <a className="text-active underline underline-offset-2" href={hrefFor('evidence')}>Evidence and PR</a>.</p>
        </details>
      </section>
      {banner ? <div className="pointer-events-none w-full max-w-[19rem]">{banner}</div> : null}
      <div className="flex-1" />
      {activity}
      {devPanel ? <div className="pointer-events-auto w-full max-w-[19rem] bg-bg">{devPanel}</div> : null}
    </div>
  );
}
