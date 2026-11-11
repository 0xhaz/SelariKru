import type { Plugin } from 'vite';

/**
 * H11 fix round 2: the built page's Content-Security-Policy. Scripts come from this origin only (the theme script is an external file for this reason), plus the
 * reCAPTCHA Enterprise script Firebase App Check loads. No inline script, no eval, no plugins, no <base> rewrite. Network calls (Firebase, the control API) are
 * connect-src, which this policy leaves open.
 *
 * Build only: the Vite dev server (and so the Playwright harness) injects an inline React refresh preamble, which this policy would block.
 */
export const CONTENT_SECURITY_POLICY = "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; object-src 'none'; base-uri 'self'";

export function cspMeta(): Plugin {
  return {
    name: 'selarikru-csp-meta',
    apply: 'build',
    transformIndexHtml(html: string): string {
      // Fix round 3: a page without the injection point fails the build rather than ship with no policy.
      const at = /<meta charset="UTF-8"\s*\/?>/i;
      if (!at.test(html)) throw new Error('selarikru-csp-meta: no <meta charset="UTF-8"> to put the Content-Security-Policy after; the build would ship without one');
      return html.replace(at, (m) => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`);
    },
  };
}
