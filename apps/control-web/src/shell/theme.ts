/**
 * One theme: the kedai paper and kopi ink (H7; one theme since T5.12 round 2). The light/dark toggle is gone; a stale `selarikru.theme`
 * preference is ignored. `data-theme="light"` stays on the root so anything that reads it sees the theme in use.
 */
export function applyTheme(): void {
  document.documentElement.dataset['theme'] = 'light';
}
