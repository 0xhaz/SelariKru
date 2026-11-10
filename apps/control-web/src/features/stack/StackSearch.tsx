import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { STACK_FILTER_LABELS, STACK_FILTERS, type StackComponent, type StackFilter, type StackSection } from '@selarikru/domain';
import { inputClass } from '../onboarding/ui.tsx';
import { searchOptions, type SearchOption } from './model.ts';

export interface StackSearchProps {
  readonly section: StackSection;
  readonly label: string;
  readonly component: StackComponent | null;
  readonly disabled: boolean;
  /** Adds the option to the component, or removes it when it is already selected. */
  readonly onToggle: (option: SearchOption) => void;
}

/**
 * A multi-select combobox over the catalog (the ARIA combobox pattern with a listbox popup): typing filters, the arrow keys move through grouped results, Enter adds or
 * removes the active one and keeps the list open for the next, and Escape closes it. Results are grouped, so the catalog is searched rather than laid out as chips.
 */
export function StackSearch({ section, label, component, disabled, onToggle }: StackSearchProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<StackFilter | null>(null);
  const [active, setActive] = useState(0);
  const groups = useMemo(() => searchOptions(query, section, filter, component), [query, section, filter, component]);
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const optionId = (o: SearchOption): string => `${id}-opt-${o.entryId}`;
  const activeOption = open ? flat[index] : undefined;
  const activeId = activeOption ? optionId(activeOption) : null;
  // The active result stays in view as the keys move through a long list.
  useEffect(() => {
    if (activeId !== null) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (flat.length === 0) return;
      setActive((index + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (e.key === 'Enter') {
      if (open && activeOption && !disabled) {
        e.preventDefault();
        onToggle(activeOption);
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); }
      else if (query !== '') { e.preventDefault(); setQuery(''); }
    }
  };

  // Shown visibly and as a 1-to-1 description, so the keys are known before they are needed.
  const filters = (
    <div role="group" aria-label={`Filter ${label.toLowerCase()}`} className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={filter === null} className={`rounded-chip border px-2 py-1 text-sm ${filter === null ? 'border-active text-fg' : 'border-line text-muted'}`} onClick={() => setFilter(null)}>All</button>
      {STACK_FILTERS.map((f) => (
        <button key={f} type="button" aria-pressed={filter === f} className={`rounded-chip border px-2 py-1 text-sm ${filter === f ? 'border-active text-fg' : 'border-line text-muted'}`} onClick={() => { setFilter(filter === f ? null : f); setActive(0); }}>{STACK_FILTER_LABELS[f]}</button>
      ))}
    </div>
  );

  return (
    <div data-testid={`stack-search-${section}`} className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-fg">{label}</label>
      {filters}
      <input
        id={inputId} type="text" role="combobox" autoComplete="off" spellCheck={false} className={inputClass} value={query}
        aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={hintId} aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
        placeholder="Type to search the catalog"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      />
      <p id={hintId} className="text-sm text-muted">Arrow keys move through results, Enter adds or removes one, Escape closes. Choose as many as the component uses.</p>
      {open ? (
        <div id={listId} role="listbox" aria-multiselectable="true" aria-label={`${label} results`} data-testid="stack-results" className="max-h-80 overflow-y-auto rounded-chip border border-line-strong bg-bg p-1">
          {flat.length === 0 ? (
            <div role="option" aria-selected={false} aria-disabled="true" id={`${id}-none`} className="px-2 py-2 text-sm text-muted">No catalog entry matches. Add it as Other/custom below.</div>
          ) : groups.map((g, gi) => (
            <div key={g.group} role="group" aria-labelledby={`${id}-g${gi}`}>
              <div id={`${id}-g${gi}`} role="presentation" className="px-2 pt-2 pb-1 text-sm font-semibold text-muted">{g.group}</div>
              {g.options.map((o) => {
                const isActive = activeOption?.entryId === o.entryId;
                return (
                  <div
                    key={o.entryId} id={optionId(o)} role="option" aria-selected={o.selected} data-entry={o.entryId}
                    className={`flex cursor-pointer flex-wrap items-baseline justify-between gap-x-2 rounded-chip px-2 py-1.5 text-fg ${isActive ? 'bg-panel-2 outline-2 outline-active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { if (!disabled) onToggle(o); }}
                  >
                    <span className="min-w-0 wrap-anywhere">
                      <span aria-hidden="true" className="mr-1.5 inline-block w-4 text-glyph">{o.selected ? '✓' : ''}</span>
                      {o.label}
                      {o.selected ? <span className="ml-1.5 text-sm text-muted">Selected</span> : null}
                    </span>
                    <span className="text-sm text-muted">{o.categoryLabel}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
