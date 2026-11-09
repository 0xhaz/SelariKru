/** What the entry screen says the flow involves, in order. */
export const ENTRY_STEPS: readonly { readonly label: string; readonly hint: string }[] = [
  { label: 'Goal', hint: 'What you want to build, and who it is for.' },
  { label: 'Starting point', hint: 'A new project or an existing repository.' },
  { label: 'Focus', hint: 'What kind of product, and which of it can run today.' },
  { label: 'Blueprint', hint: 'Review and edit the scope agents will be given.' },
  { label: 'Cost plan', hint: 'Build effort, running costs and agent usage, kept apart.' },
  { label: 'Execution', hint: 'Where workers run and where the assistant runs.' },
  { label: 'Connections', hint: 'The repository. No tokens or passwords are asked for.' },
  { label: 'Readiness', hint: 'Real checks of your checkout, runner and policy.' },
  { label: 'Start', hint: 'Confirm one bounded first run.' },
];
