/**
 * One theme: the reference's cream and ink (owner decision, T5.12 round 2). The light/dark toggle is gone; a stale `selarikru.theme`
 * preference is ignored. `data-theme="light"` stays on the root so anything that reads it sees the theme in use.
 */
export function applyTheme(): void {
  document.documentElement.dataset['theme'] = 'light';
}
