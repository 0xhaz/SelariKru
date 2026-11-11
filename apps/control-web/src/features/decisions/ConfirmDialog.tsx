import { useEffect, useRef } from 'react';
import { buttonDangerSolid, buttonQuiet } from '@selarikru/ui';
import type { ConfirmCopy } from './model.ts';

/** Confirms a destructive or irreversible choice. Focus moves into the native modal dialog; Escape keeps the request as it was. The confirm button repeats the outcome. */
export function ConfirmDialog({ copy, confirmLabel, onConfirm, onKeep }: { copy: ConfirmCopy; confirmLabel: string; onConfirm: () => void; onKeep: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" aria-describedby="confirm-body" onCancel={(e) => { e.preventDefault(); onKeep(); }} className="motion-dialog m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-line-strong bg-panel p-5 text-fg backdrop:bg-backdrop">
      <h2 id="confirm-title" className="text-lg font-semibold text-fg">{copy.title}</h2>
      <p id="confirm-body" className="mt-2 text-fg">{copy.consequence}</p>
      <p className="mt-3 text-sm text-muted" data-testid="confirm-keys"><kbd className="rounded-chip border border-line-strong px-1 font-mono text-mono text-fg">Esc</kbd> keeps it as it was.</p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" autoFocus className={buttonQuiet} onClick={onKeep}>{copy.keepLabel}</button>
        <button type="button" className={buttonDangerSolid} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
