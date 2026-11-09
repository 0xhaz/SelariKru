import { Children, cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Chip, toneGlyph, TONE_TEXT, type Tone } from '@selarikru/ui';
import type { ExecutionChoice, ReadinessStatus } from '@selarikru/domain';
import type { InferenceChoice } from './api.ts';

export const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
export const inputClass = 'w-full rounded-chip border border-line-strong bg-bg px-3 py-2 text-fg placeholder:text-muted';

const NOTICE_TONE: Record<'neutral' | 'warning' | 'danger' | 'success', { surface: string; tone: Tone }> = {
  neutral: { surface: 'border-line bg-panel', tone: 'neutral' },
  warning: { surface: 'border-warning bg-warning-tint', tone: 'warning' },
  danger: { surface: 'border-danger bg-danger-tint', tone: 'danger' },
  success: { surface: 'border-success bg-success-tint', tone: 'success' },
};

/** Inline banner. A danger notice uses role=alert, the rest are ordinary text. */
export function Notice({ tone, title, children }: { tone: keyof typeof NOTICE_TONE; title: string; children: ReactNode }) {
  const n = NOTICE_TONE[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={`rounded-card border px-3 py-2 ${n.surface}`}>
      <p className={`flex items-center gap-1.5 text-sm font-semibold ${TONE_TEXT[n.tone]}`}><span aria-hidden="true" className="text-glyph">{toneGlyph(n.tone)}</span>{title}</p>
      <div className="mt-0.5 wrap-anywhere text-sm text-fg">{children}</div>
    </div>
  );
}

/** A labelled control. The hint and any error are tied to the control, so a screen reader announces them with it. */
export function Field({ id, label, hint, children, error }: { id: string; label: string; hint?: ReactNode; children: ReactNode; error?: string | undefined }) {
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const control = Children.only(children);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg">{label}</label>
      {hint ? <p id={`${id}-hint`} className="mt-0.5 text-sm text-muted">{hint}</p> : null}
      <div className="mt-1.5">{isValidElement(control) ? cloneElement(control as ReactElement<Record<string, unknown>>, { 'aria-describedby': described, 'aria-invalid': error ? true : undefined }) : control}</div>
      {error ? <p id={`${id}-error`} className="mt-1 text-sm text-danger">{error}</p> : null}
    </div>
  );
}

/** True once the project has started: every step can be read and none can be changed. */
export const ReadOnlyContext = createContext(false);

/** Server text uses backticks around commands. They become code here, so no literal backtick reaches the page. */
export function CodeText({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i} className="wrap-anywhere font-mono text-mono">{part}</code> : <span key={i}>{part}</span>))}</>;
}

/** A form step's frame: the question, its reason, then the fields. The heading takes focus when the step changes. */
export function StepFrame({ title, intro, heading, children, footer, keepFooter }: { title: string; intro?: ReactNode; heading: RefObject<HTMLHeadingElement>; children: ReactNode; footer?: ReactNode; keepFooter?: boolean }) {
  const readOnly = useContext(ReadOnlyContext);
  const showFooter = footer && (!readOnly || keepFooter);
  return (
    <section aria-labelledby="step-title">
      <h1 ref={heading} id="step-title" tabIndex={-1} data-focus-landing className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
      {intro ? <div className="mt-1.5 max-w-prose text-muted">{intro}</div> : null}
      {readOnly && !keepFooter ? <div className="mt-4"><Notice tone="neutral" title="Read-only">This project has started, so its setup can no longer change.</Notice></div> : null}
      <div className="mt-5 space-y-4">{children}</div>
      {showFooter ? <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">{footer}</div> : null}
    </section>
  );
}

export const CHECK_STATUS: Readonly<Record<ReadinessStatus, { label: string; tone: Tone }>> = {
  passed: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'warning' },
};

export function StatusChip({ status }: { status: ReadinessStatus }) {
  return <Chip tone={CHECK_STATUS[status].tone}>{CHECK_STATUS[status].label}</Chip>;
}

export const EXECUTION_TEXT: Readonly<Record<ExecutionChoice, { label: string; hint: string }>> = {
  local: { label: 'Local sandbox', hint: 'Workers run in a sandbox on a computer you connect. Your hardware does the work, and a local worker can still call a cloud model.' },
  cloud: { label: 'Cloud sandbox', hint: 'Workers run in a cloud sandbox. This needs a cloud runner and a policy grant for the destination.' },
  hybrid: { label: 'Local and cloud sandboxes', hint: 'Both are allowed. A local runner and a cloud runner must each be connected.' },
};

export const INFERENCE_TEXT: Readonly<Record<InferenceChoice, { label: string; hint: string }>> = {
  ONLY_ON_DEVICE: { label: 'Device only', hint: 'The assistant never leaves this device. Blocked if the model is not ready.' },
  PREFER_ON_DEVICE: { label: 'Device preferred', hint: 'Device first; cloud only when this source is approved for it.' },
  ONLY_IN_CLOUD: { label: 'Cloud only', hint: 'A cloud model only. Needs approval for the source.' },
  PREFER_IN_CLOUD: { label: 'Cloud preferred', hint: 'Cloud first; device if the cloud is unavailable and approved.' },
};
