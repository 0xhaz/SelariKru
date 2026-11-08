import type { ReactNode } from 'react';
import type { Tone } from './labels.ts';

const TONE: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  active: 'border-active text-active',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
};
const GLYPH: Record<Tone, string> = { neutral: '○', active: '◆', success: '●', warning: '▲', danger: '■' };

/** Status chip: color is always paired with a glyph and text. */
export function Chip({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-sm ${TONE[tone]}`}>
      <span aria-hidden="true" className="text-[10px]">{GLYPH[tone]}</span>
      <span>{children}</span>
    </span>
  );
}

export function Card({ title, labelId, hint, children, className = '' }: { title: string; labelId: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={labelId} className={`rounded-[8px] border border-line bg-panel p-4 ${className}`}>
      <h2 id={labelId} className="text-base font-semibold text-fg">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export const btn = 'rounded-[4px] px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
export const btnPrimary = `${btn} bg-active text-bg hover:brightness-110`;
export const btnQuiet = `${btn} border border-line bg-panel-2 text-fg hover:border-active`;
export const field = 'w-full rounded-[4px] border border-line bg-bg px-2 py-2 text-fg';
export const mono = 'font-mono text-[13px]';
