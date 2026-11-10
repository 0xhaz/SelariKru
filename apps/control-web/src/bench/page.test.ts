import { describe, expect, it } from 'vitest';
import { BENCH_GLOBAL, type AssistantSdk } from '@selarikru/inference-firebase-web/bench';
import { startBenchPage } from './page.ts';

const sdk: AssistantSdk = {
  availability: async () => 'available',
  initializeDeviceModel: async () => undefined,
  createModel: () => ({ generate: async () => ({ text: '{}', inferenceSource: 'in_cloud' }) }),
};

describe('benchmark bench page (T8.2)', () => {
  it('installs the bridge the runner drives and says so with both route labels, showing no output', async () => {
    const target = {};
    const status = { textContent: null as string | null };
    const bridge = startBenchPage(sdk, status, true, target)!;
    expect((target as Record<string, unknown>)[BENCH_GLOBAL]).toBe(bridge);
    expect(status.textContent).toMatch(/Device only \(ONLY_ON_DEVICE\) and Cloud only \(ONLY_IN_CLOUD\)/);
    expect(status.textContent).toMatch(/Output is not shown here/);
    expect((await bridge.generate({ route: 'ONLY_IN_CLOUD', systemInstruction: 's', prompt: 'p', responseSchema: {}, dataClassification: 'synthetic_cloud_permitted' })).inferenceSource).toBe('in_cloud');
  });

  it('M2: installs nothing until the owner is signed in, and the build includes the page only with VITE_BENCH_PAGE=1', async () => {
    const target = {};
    const status = { textContent: null as string | null };
    expect(startBenchPage(sdk, status, false, target)).toBeNull();
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
    expect(status.textContent).toMatch(/Sign in/);
    const { benchBuildInput } = await import('../../vite.config.ts');
    expect(Object.keys(benchBuildInput({}))).toEqual(['main']);
    expect(Object.keys(benchBuildInput({ VITE_BENCH_PAGE: '1' }))).toEqual(['main', 'bench']);
  });
});
