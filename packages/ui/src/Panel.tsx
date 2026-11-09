import type { ReactNode } from 'react';

/** A labelled region of a view. The heading names the landmark, and `aside` holds a counter or qualifier beside it. */
export function Panel({ title, labelId, aside, children, className = '' }: { title: string; labelId: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={labelId} className={`rounded-card border border-line bg-panel ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 id={labelId} className="text-base font-semibold text-fg">{title}</h2>
        {aside ? <div className="text-sm text-muted">{aside}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Says what is missing and what to do next. It never renders placeholders that could be read as data. */
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-lg font-semibold text-fg">{title}</p>
      <div className="mx-auto mt-2 max-w-prose text-muted">{children}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
