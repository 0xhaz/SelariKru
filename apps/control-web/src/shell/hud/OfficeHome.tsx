import type { ReactNode } from 'react';
import type { OfficeWorld } from '../../office/model.ts';

/**
 * The office screen's main region. The office canvas is the content, so the heading and the canvas summary are for assistive technology; the
 * team cards and the canvas carry the same facts visibly. Below the floating layout's width the activity feed and the demo controls sit here.
 */
export function OfficeHome({ world, activity, devPanel, wide }: { world: OfficeWorld | null; activity: ReactNode; devPanel?: ReactNode; wide: boolean }) {
  return (
    <main id="main" tabIndex={-1} className="pointer-events-none outline-none">
      <h1 className="sr-only">Office</h1>
      <p className="sr-only" data-testid="office-summary">{world?.summary ?? 'No project data is connected, so the office is empty.'}</p>
      {wide ? null : <div className="pointer-events-auto mt-3 space-y-3 px-3">{activity}</div>}
      {devPanel ? <div className="pointer-events-auto mx-3 mt-3 max-w-[22rem] bg-paper xl:fixed xl:right-4 xl:bottom-4 xl:z-10 xl:mx-0 xl:mt-0 xl:w-[300px]">{devPanel}</div> : null}
    </main>
  );
}
