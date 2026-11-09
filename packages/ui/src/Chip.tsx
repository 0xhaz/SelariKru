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

/** Status chip: color is always paired with a glyph and text. */
export function Chip({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-sm ${TONE[tone]}`}>
      <span aria-hidden="true" className="text-[10px]">{GLYPH[tone]}</span>
      <span>{children}</span>
    </span>
  );
}
