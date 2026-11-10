import { createBenchBridge, installBenchBridge, type AssistantSdk, type BenchBridge } from '@selarikru/inference-firebase-web/bench';

/**
 * The benchmark bench page (Track A). The owner opens it in Chrome desktop; the benchmark runner drives it over CDP
 * through `globalThis.selarikruBench`. It renders no model output and keeps nothing: no prompt, output or credential
 * is written to the page, storage or logs. It uses the same Firebase AI Logic client and App Check setup as the
 * assistant (`createFirebaseSdk`). It is built only when `VITE_BENCH_PAGE=1` (never in a default production build),
 * the bridge is installed only once the owner is signed in, and the bridge refuses any input that is not synthetic and
 * cloud-permitted.
 */

export function benchStatusText(bridge: BenchBridge): string {
  const env = bridge.environment();
  return `Ready for the benchmark runner. Firebase JS SDK ${env.sdkVersion}, cloud model ${env.cloudModel}. Routes: Device only (ONLY_ON_DEVICE) and Cloud only (ONLY_IN_CLOUD). Output is not shown here.`;
}

export const SIGN_IN_FIRST = 'Sign in to the control web as the owner first. The benchmark bridge is not installed until you do.';

/** Installs the bridge only for a signed-in owner. Returns null, and installs nothing, otherwise. */
export function startBenchPage(sdk: AssistantSdk, status: { textContent: string | null }, signedIn: boolean, target: object = globalThis): BenchBridge | null {
  if (!signedIn) {
    status.textContent = SIGN_IN_FIRST;
    return null;
  }
  const bridge = createBenchBridge({ sdk, userAgent: globalThis.navigator?.userAgent ?? null, origin: globalThis.location?.origin ?? null });
  installBenchBridge(bridge, target);
  status.textContent = benchStatusText(bridge);
  return bridge;
}
