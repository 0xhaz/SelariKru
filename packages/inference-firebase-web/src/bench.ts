import { errorCodeOf } from './adapter.ts';
import { CLOUD_MODEL, SDK_VERSION } from './models.ts';
import type { AssistantSdk, DeviceAvailability } from './sdk.ts';

export type { AssistantSdk, DeviceAvailability, ModelSpec, SdkGenerateResult } from './sdk.ts';

/**
 * The benchmark bench page's bridge (Track A). The owner opens the control web's bench page in Chrome; the benchmark
 * runner, a Node process, drives it over CDP by calling the functions installed on `globalThis.selarikruBench`. The
 * page owns nothing about the experiment: the runner sends the exact system instruction, prompt and response schema,
 * and gets back the raw observed source, the monotonic timings measured here, and the output text.
 *
 * Every request builds a new model instance, so no conversation history can carry from one request to the next. The
 * requested route is explicit (`ONLY_ON_DEVICE` or `ONLY_IN_CLOUD`) and a device-only model is built with no cloud
 * parameters, so the SDK has nothing to fall back to. Errors come back as the SDK's code only, never a message.
 */

export const BENCH_ROUTES = ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'] as const;
export type BenchRoute = (typeof BENCH_ROUTES)[number];
export const BENCH_GLOBAL = 'selarikruBench';
/** Durations measured in the page with `performance.now()`. */
export const BENCH_CLOCK = 'browser-monotonic';

export interface BenchGenerateRequest {
  readonly route: BenchRoute;
  readonly systemInstruction: string;
  readonly prompt: string;
  /** The schema sent with the request (already narrowed to the fixture's requirement IDs). */
  readonly responseSchema: Readonly<Record<string, unknown>>;
  /** The fixture file's classification. Anything but synthetic, cloud-permitted input is refused before a model is built. */
  readonly dataClassification: string;
}

/** The only input the bench page ever sends: synthetic fixtures that may go to the cloud route. */
export const BENCH_CLASSIFICATION = 'synthetic_cloud_permitted';

export interface BenchGenerateResult {
  readonly outcome: 'ok' | 'error';
  readonly text: string | null;
  /** The SDK's raw `inferenceSource`, unmapped. Null when it gave none. */
  readonly inferenceSource: string | null;
  /** Null: the SDK call used here does not stream, so there is no first output to time. Never the total. */
  readonly firstOutputMs: number | null;
  readonly generationCompleteMs: number;
  readonly streaming: boolean;
  /** Provider-reported token counts, only where the SDK supplied them. */
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null } | null;
  readonly errorCode: string | null;
  readonly clockDomain: typeof BENCH_CLOCK;
}

export interface BenchSetupResult {
  readonly route: BenchRoute;
  readonly availability: DeviceAvailability | 'not_applicable';
  readonly outcome: 'ready' | 'unavailable' | 'failed';
  /** Model download and readiness, timed apart from any generation. Null when nothing was downloaded. */
  readonly downloadMs: number | null;
  readonly errorCode: string | null;
  readonly clockDomain: typeof BENCH_CLOCK;
}

export interface BenchEnvironment {
  readonly sdkVersion: string;
  readonly cloudModel: string;
  readonly userAgent: string | null;
  readonly origin: string | null;
}

export interface BenchBridge {
  environment(): BenchEnvironment;
  setup(route: BenchRoute): Promise<BenchSetupResult>;
  generate(req: BenchGenerateRequest): Promise<BenchGenerateResult>;
}

export interface BenchBridgeOptions {
  readonly sdk: AssistantSdk;
  readonly now?: () => number;
  readonly userAgent?: string | null;
  readonly origin?: string | null;
}

const isRoute = (r: unknown): r is BenchRoute => (BENCH_ROUTES as readonly unknown[]).includes(r);

export function createBenchBridge(o: BenchBridgeOptions): BenchBridge {
  const now = o.now ?? (() => performance.now());
  return {
    environment: () => ({ sdkVersion: SDK_VERSION, cloudModel: CLOUD_MODEL, userAgent: o.userAgent ?? null, origin: o.origin ?? null }),
    async setup(route) {
      if (!isRoute(route)) throw new Error('unknown route');
      if (route === 'ONLY_IN_CLOUD') return { route, availability: 'not_applicable', outcome: 'ready', downloadMs: null, errorCode: null, clockDomain: BENCH_CLOCK };
      let availability = await o.sdk.availability();
      let downloadMs: number | null = null;
      if (availability === 'downloadable' || availability === 'downloading') {
        const t0 = now();
        try {
          await o.sdk.initializeDeviceModel(() => undefined);
        } catch (e) {
          return { route, availability, outcome: 'failed', downloadMs: now() - t0, errorCode: errorCodeOf(e), clockDomain: BENCH_CLOCK };
        }
        downloadMs = now() - t0;
        availability = await o.sdk.availability();
      }
      return { route, availability, outcome: availability === 'available' ? 'ready' : 'unavailable', downloadMs, errorCode: null, clockDomain: BENCH_CLOCK };
    },
    async generate(req) {
      if (!isRoute(req.route)) throw new Error('unknown route');
      if (req.dataClassification !== BENCH_CLASSIFICATION) throw new Error('the bench page sends only synthetic, cloud-permitted fixtures');
      // A new model per request: single-turn, no history.
      const model = o.sdk.createModel({ mode: req.route, allowCloud: req.route === 'ONLY_IN_CLOUD', systemInstruction: req.systemInstruction, schema: req.responseSchema });
      const t0 = now();
      try {
        const res = await model.generate(req.prompt);
        const u = res.usage;
        return {
          outcome: 'ok', text: res.text, inferenceSource: res.inferenceSource ?? null, firstOutputMs: null, generationCompleteMs: now() - t0, streaming: false,
          usage: u && (u.inputTokens !== undefined || u.outputTokens !== undefined) ? { inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null } : null,
          errorCode: null, clockDomain: BENCH_CLOCK,
        };
      } catch (e) {
        return { outcome: 'error', text: null, inferenceSource: null, firstOutputMs: null, generationCompleteMs: now() - t0, streaming: false, usage: null, errorCode: errorCodeOf(e), clockDomain: BENCH_CLOCK };
      }
    },
  };
}

/** Puts the bridge where the runner's `page.evaluate` calls find it. */
export function installBenchBridge(bridge: BenchBridge, target: object = globalThis): void {
  Object.defineProperty(target, BENCH_GLOBAL, { value: bridge, configurable: true, enumerable: false, writable: false });
}
