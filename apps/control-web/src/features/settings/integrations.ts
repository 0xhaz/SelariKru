/**
 * H9 fix round 1 (I4): the one check for "worker integrations are off" (Claude Code workers, MCP). True only when the snapshot says coding workers are off;
 * with no snapshot nothing is known, so nothing is hidden and no line is shown.
 */
export const integrationsOff = (snapshot: { readonly modelCatalog: { readonly codingWorkers: string } } | null | undefined): boolean => snapshot?.modelCatalog.codingWorkers === 'off';
