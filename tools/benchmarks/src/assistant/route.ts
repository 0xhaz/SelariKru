import type { BenchEnvironment, BenchGenerateRequest, BenchGenerateResult, BenchRoute, BenchSetupResult } from '@selarikru/inference-firebase-web/bench';

/**
 * The route adapter the Track A runner talks to. In a live run it is the control web's bench page, opened by the
 * owner in Chrome and driven over CDP through Playwright; in tests it is a fake page. Either way the runner sees only
 * this interface.
 */
export interface RouteAdapter {
  environment(): Promise<BenchEnvironment>;
  setup(route: BenchRoute): Promise<BenchSetupResult>;
  generate(req: BenchGenerateRequest): Promise<BenchGenerateResult>;
  close?(): Promise<void>;
}

/** The one Playwright `Page` method used. */
export interface PageLike {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  url(): string;
}

interface BenchGlobal {
  selarikruBench?: {
    environment(): BenchEnvironment;
    setup(route: BenchRoute): Promise<BenchSetupResult>;
    generate(req: BenchGenerateRequest): Promise<BenchGenerateResult>;
  };
}

export class BenchPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchPageError';
  }
}

/**
 * Calls the bench page's bridge. The functions passed to `evaluate` run in the page; they reach only
 * `globalThis.selarikruBench`, which the bench page installs, and they carry no credential.
 */
export function benchPageAdapter(page: PageLike): RouteAdapter {
  const call = async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
    const ready = await page.evaluate(() => typeof (globalThis as BenchGlobal).selarikruBench === 'object', null);
    if (!ready) throw new BenchPageError('the bench page bridge is not installed (open the control web bench page)');
    return page.evaluate(fn, arg);
  };
  return {
    environment: () => call(() => (globalThis as BenchGlobal).selarikruBench!.environment(), null),
    setup: (route) => call((r: BenchRoute) => (globalThis as BenchGlobal).selarikruBench!.setup(r), route),
    generate: (req) => call((r: BenchGenerateRequest) => (globalThis as BenchGlobal).selarikruBench!.generate(r), req),
  };
}

/** The slice of Playwright's `Browser` used to find the bench page among the owner's open tabs. */
export interface BrowserLike {
  contexts(): { pages(): PageLike[] }[];
  close(): Promise<void>;
}

export type CdpConnect = (endpoint: string) => Promise<BrowserLike>;

/** Playwright's own CDP connection. Loaded only for a live run, so tests and dry runs never import it. */
export const playwrightConnect: CdpConnect = async (endpoint) => {
  const { chromium } = await import('playwright-core');
  return (await chromium.connectOverCDP(endpoint)) as unknown as BrowserLike;
};

/**
 * Attaches to a Chrome the owner started with remote debugging, finds the tab already showing the bench page (the
 * owner opened and signed it in; this never opens or navigates one), and returns its adapter. Closing it disconnects
 * from Chrome without closing the owner's browser.
 */
export async function connectBenchPage(o: { readonly endpoint: string; readonly benchUrl: string; readonly connect?: CdpConnect }): Promise<RouteAdapter> {
  const endpoint = new URL(o.endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new BenchPageError('the CDP endpoint must be on this machine (loopback)');
  const browser = await (o.connect ?? playwrightConnect)(o.endpoint);
  const want = new URL(o.benchUrl);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => {
    try {
      const u = new URL(p.url());
      return u.origin === want.origin && u.pathname === want.pathname;
    } catch {
      return false;
    }
  });
  if (page === undefined) {
    await browser.close();
    throw new BenchPageError('no open tab shows the bench page; open it in Chrome first');
  }
  return { ...benchPageAdapter(page), close: () => browser.close() };
}
