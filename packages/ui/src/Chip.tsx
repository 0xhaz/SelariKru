import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  active: 'border-active text-active',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
};
const GLYPH: Record<Tone, string> = { neutral: '○', active: '◆', success: '●', warning: '▲', danger: '■' };

export const toneGlyph = (tone: Tone): string => GLYPH[tone];

export const TONE_TEXT: Readonly<Record<Tone, string>> = { neutral: 'text-muted', active: 'text-active', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };
/** Attention rails. Only a warning or failure earns one; ordinary work stays quiet. */
export const RAIL_SHADOW: Readonly<Record<Tone, string>> = {
  neutral: '', active: '', success: '',
  warning: 'shadow-[inset_3px_0_0_var(--color-warning)]',
  danger: 'shadow-[inset_3px_0_0_var(--color-danger)]',
};
export const RAIL_BORDER: Readonly<Record<Tone, string>> = { neutral: 'border-l-line', active: 'border-l-line', success: 'border-l-line', warning: 'border-l-warning', danger: 'border-l-danger' };

/** Status chip: color is always paired with a glyph and text. */
export function Chip({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex max-w-full items-center gap-1.5 rounded-chip border px-2 py-0.5 text-sm ${TONE[tone]}`}>
      <span aria-hidden="true" className="text-glyph">{GLYPH[tone]}</span>
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </span>
  );
}
