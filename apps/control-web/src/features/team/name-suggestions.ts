import { WORKER_NAME_MAX } from '@selarikru/domain';

/**
 * H11: a suggested name per role, offered at onboarding before any worker has joined. The owner can change each one there; what they pick is kept in this browser
 * and offered again (as the placeholder) in the drawer of a worker of that role, where saving it makes it the worker's name. Nothing here names a worker by itself.
 */
const SUGGESTED = ['Aisyah', 'Ravi', 'Mei Ling', 'Daniel', 'Siti', 'Arif', 'Kavitha', 'Hafiz'] as const;

const key = (projectId: string): string => `selarikru.names.${projectId}`;

function read(projectId: string): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(key(projectId));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The default suggestion for the role at this position in the plan's role list. */
export function defaultSuggestion(index: number): string {
  return SUGGESTED[index % SUGGESTED.length]!;
}

/** The name suggested for a role: the owner's pick, else the default for the role's position. */
export function suggestedName(projectId: string | null, role: string | null, roles: readonly string[] = []): string | null {
  if (!role) return null;
  const picked = projectId ? read(projectId)[role] : undefined;
  if (typeof picked === 'string' && picked.trim()) return picked.trim();
  const i = roles.indexOf(role);
  return i >= 0 ? defaultSuggestion(i) : null;
}

/** Keeps the owner's pick for a role (an empty one goes back to the default). Ignored if this browser keeps nothing. */
export function saveSuggestedName(projectId: string, role: string, name: string): void {
  try {
    const all = read(projectId);
    const v = [...name.trim()].slice(0, WORKER_NAME_MAX).join('');
    if (v) all[role] = v; else delete all[role];
    globalThis.localStorage?.setItem(key(projectId), JSON.stringify(all));
  } catch { /* nothing kept: the default stays */ }
}
