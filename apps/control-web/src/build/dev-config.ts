/** H9 fix round 1 (I3): in dev with the Firebase config missing, a visible notice instead of AI calls that fail with no word. Never in a production build. */
export function devConfigNotice(opts: { readonly dev: boolean; readonly configured: boolean }): string | null {
  return opts.dev && !opts.configured ? 'Firebase config missing: AI calls will fail. Add VITE_FIREBASE_* to apps/control-web/.env.local' : null;
}
