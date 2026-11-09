const base = 'inline-flex items-center justify-center rounded-chip px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

export const buttonPrimary = `${base} bg-active text-bg hover:brightness-110`;
export const buttonQuiet = `${base} border border-line-strong bg-panel-2 text-fg hover:border-active`;
/** An outcome that blocks or stops work. Outlined, so it never competes with the primary action. */
export const buttonDanger = `${base} border border-danger text-danger hover:bg-danger-tint`;
/** The confirm step of a destructive outcome. */
export const buttonDangerSolid = `${base} bg-danger font-semibold text-bg hover:brightness-110`;
