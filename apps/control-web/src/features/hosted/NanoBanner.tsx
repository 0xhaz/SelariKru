import { useEffect, useState } from 'react';
import type { DeviceReadiness } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import { nanoBanner } from './nano.ts';

/**
 * H9 item 3: on first load, whether Gemini Nano is available in this browser is checked once. If it is not, one calm banner says what each route will do. An
 * expected state, so no error styling and no alert; it can be put away for this visit.
 */
export function NanoBanner({ check, snapshot }: { check: () => Promise<DeviceReadiness>; snapshot: ProjectViewSnapshot | null }) {
  const [availability, setAvailability] = useState<DeviceReadiness | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    void check().then((a) => { if (live) setAvailability(a); }, () => { if (live) setAvailability('unknown'); });
    return () => { live = false; };
    // Checked once, on first load.
  }, []);
  const banner = availability ? nanoBanner(availability, snapshot) : null;
  if (!banner || hidden) return null;
  return (
    <section aria-labelledby="nano-banner-title" data-testid="nano-banner" data-availability={availability}
      className="pointer-events-auto z-30 mx-3 mt-3 border-2 border-ink bg-paper px-4 py-3 text-[14px] text-fg rounded-[4px] shadow-[2px_3px_0_rgba(43,29,20,0.22)] xl:fixed xl:bottom-4 xl:left-1/2 xl:mx-0 xl:mt-0 xl:w-[min(600px,calc(100vw-660px))] xl:min-w-[420px] xl:-translate-x-1/2">
      <div className="flex items-start gap-3">
        <h2 id="nano-banner-title" className="min-w-0 flex-1 text-[15px] font-semibold">{banner.title}</h2>
        <button type="button" className="btn shrink-0 px-2 text-[13px]" onClick={() => setHidden(true)}>Got it</button>
      </div>
      <p className="mt-1 text-muted">Nothing is wrong: AI steps follow each task&apos;s route, without the model on this device.</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)]">
        {banner.lines.map((l) => (
          <div key={l.route} className="contents">
            <dt className="font-semibold">{l.route}</dt>
            <dd className="m-0 wrap-anywhere" data-testid="nano-banner-line">{l.text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2"><a className="text-active underline underline-offset-2" href={banner.href} target="_blank" rel="noreferrer">How to get Gemini Nano in Chrome<span className="sr-only"> (opens in a new tab)</span></a></p>
    </section>
  );
}
