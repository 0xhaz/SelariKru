import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIREBASE_ENV_NAMES } from './hosted.ts';
import { devConfigNotice } from './dev-config.ts';

describe('H9 fix round 1 (I3): a dev setup without the Firebase config says so', () => {
  it('in dev with no config: a visible notice; otherwise none', () => {
    expect(devConfigNotice({ dev: true, configured: false })).toBe('Firebase config missing: AI calls will fail. Add VITE_FIREBASE_* to apps/control-web/.env.local');
    expect(devConfigNotice({ dev: true, configured: true })).toBeNull();
    expect(devConfigNotice({ dev: false, configured: false })).toBeNull();
  });

  it('the app\'s .env.example comments name every required variable', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const comments = example.split('\n').filter((l) => l.startsWith('#')).join('\n');
    for (const name of [...FIREBASE_ENV_NAMES, 'VITE_RECAPTCHA_SITE_KEY']) expect(comments).toContain(name);
  });
});
