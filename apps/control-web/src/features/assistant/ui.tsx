import type { ReactNode } from 'react';
import { Chip } from '@selarikru/ui';

export { Chip };

export function Card({ title, labelId, hint, children, className = '' }: { title: string; labelId: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={labelId} className={`rounded-card border border-line bg-panel p-4 ${className}`}>
      <h2 id={labelId} className="text-base font-semibold text-fg">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export const btn = 'rounded-chip px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
export const btnPrimary = `${btn} bg-active text-bg hover:brightness-110`;
export const btnQuiet = `${btn} border border-line bg-panel-2 text-fg hover:border-active`;
export const field = 'w-full rounded-chip border border-line bg-bg px-2 py-2 text-fg';
export const mono = 'font-mono text-mono';
