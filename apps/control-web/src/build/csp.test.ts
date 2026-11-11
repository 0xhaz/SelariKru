import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, cspMeta } from './csp.ts';

/** H11 fix round 2: the built page carries a Content-Security-Policy with no inline script; the dev server (React refresh preamble) is left without it. */
describe('the Content-Security-Policy meta tag', () => {
  it('allows scripts from this origin and App Check\'s reCAPTCHA only, never inline, and no plugins or base rewrite', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
  });

  it('is put first in the head of the built page only', () => {
    const plugin = cspMeta();
    expect(plugin.apply).toBe('build');
    const out = (plugin.transformIndexHtml as (html: string) => string)('<html><head><meta charset="UTF-8" /></head><body></body></html>');
    expect(out).toMatch(/^<html><head><meta charset="UTF-8" \/>\s*<meta http-equiv="Content-Security-Policy" content="[^"]+" \/>/);
  });
});
