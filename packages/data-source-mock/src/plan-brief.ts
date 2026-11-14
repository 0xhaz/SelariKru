import type { FixtureId } from './builder.ts';

/**
 * H13: sample plan brief notes for the demo, so "Format on this device" works straight away in `?demo`. Demo data: synthetic, never evidence, and they name no
 * person, client, host or credential.
 */
const NOTES: Partial<Record<FixtureId, { readonly points: string; readonly unsure: string }>> = {
  'feature-delivery': {
    points: [
      'Anyone can post feedback without an account.',
      'The list shows the newest posts first.',
      'Each person gets one vote per post.',
      'We store posts in PostgreSQL.',
      'Most public feedback boards let people sort posts by votes.',
    ].join('\n'),
    unsure: [
      'Do public feedback boards usually need moderation before a post appears?',
      'Is rate limiting by IP address enough to stop spam votes?',
    ].join('\n'),
  },
};

/** The sample notes for a demo project (`demo-<fixture>`), or null when it has none. */
export function demoPlanBriefNotes(projectId: string): { readonly points: string; readonly unsure: string } | null {
  const fixture = projectId.startsWith('demo-') ? (projectId.slice('demo-'.length) as FixtureId) : null;
  return (fixture && NOTES[fixture]) ?? null;
}
