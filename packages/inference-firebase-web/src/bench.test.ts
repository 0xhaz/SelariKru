import { describe, expect, it } from 'vitest';
import { BENCH_GLOBAL, createBenchBridge, installBenchBridge } from './bench.ts';
import { SDK_VERSION } from './models.ts';
import type { AssistantSdk, DeviceAvailability, ModelSpec, SdkGenerateResult } from './sdk.ts';

function fake(o: { availability?: DeviceAvailability; downloadMs?: number; afterDownload?: DeviceAvailability; result?: SdkGenerateResult | Error } = {}) {
  const clock = { t: 0 };
  let availability = o.availability ?? 'available';
  const specs: ModelSpec[] = [];
  const prompts: string[] = [];
  const sdk: AssistantSdk = {
    availability: async () => availability,
    initializeDeviceModel: async () => { clock.t += o.downloadMs ?? 0; availability = o.afterDownload ?? 'available'; },
    createModel: (spec) => {
      specs.push(spec);
      return {
        generate: async (prompt) => {
          prompts.push(prompt);
          clock.t += 250;
          if (o.result instanceof Error) throw o.result;
          return o.result ?? { text: '{}', inferenceSource: spec.mode === 'ONLY_ON_DEVICE' ? 'on_device' : 'in_cloud' };
        },
      };
    },
  };
  return { bridge: createBenchBridge({ sdk, now: () => clock.t }), specs, prompts };
}

const req = (route: 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD') => ({ route, systemInstruction: 'sys', prompt: 'p', responseSchema: { type: 'object' } });

describe('bench bridge (T8.2)', () => {
  it('times a device model download in setup, apart from generation, and needs none for the cloud', async () => {
    const { bridge } = fake({ availability: 'downloadable', downloadMs: 90_000 });
    expect(await bridge.setup('ONLY_IN_CLOUD')).toMatchObject({ outcome: 'ready', availability: 'not_applicable', downloadMs: null });
    expect(await bridge.setup('ONLY_ON_DEVICE')).toMatchObject({ outcome: 'ready', availability: 'available', downloadMs: 90_000, clockDomain: 'browser-monotonic' });
    expect(await fake({ availability: 'unavailable' }).bridge.setup('ONLY_ON_DEVICE')).toMatchObject({ outcome: 'unavailable', downloadMs: null });
    expect(await fake({ availability: 'downloadable', afterDownload: 'unavailable' }).bridge.setup('ONLY_ON_DEVICE')).toMatchObject({ outcome: 'unavailable' });
  });

  it('builds a new model per request, device-only with no cloud parameters, and returns the raw source with no first-output time', async () => {
    const { bridge, specs, prompts } = fake();
    const a = await bridge.generate(req('ONLY_ON_DEVICE'));
    const b = await bridge.generate(req('ONLY_IN_CLOUD'));
    expect(specs.map((s) => [s.mode, s.allowCloud])).toEqual([['ONLY_ON_DEVICE', false], ['ONLY_IN_CLOUD', true]]);
    expect(prompts).toEqual(['p', 'p']);
    expect(a).toMatchObject({ outcome: 'ok', inferenceSource: 'on_device', firstOutputMs: null, streaming: false, generationCompleteMs: 250, usage: null });
    expect(b.inferenceSource).toBe('in_cloud');
    expect(bridge.environment().sdkVersion).toBe(SDK_VERSION);
  });

  it('returns only the error code, never the message', async () => {
    const { bridge } = fake({ result: Object.assign(new Error('your key AIza-secret failed for prompt "p"'), { code: 'AI/fetch-error' }) });
    const r = await bridge.generate(req('ONLY_IN_CLOUD'));
    expect(r).toMatchObject({ outcome: 'error', errorCode: 'AI/fetch-error', text: null });
    expect(JSON.stringify(r)).not.toContain('AIza');
    await expect(bridge.generate({ ...req('ONLY_IN_CLOUD'), route: 'PREFER_IN_CLOUD' as never })).rejects.toThrow(/unknown route/);
  });

  it('installs on the page global the runner calls', () => {
    const target = {};
    const { bridge } = fake();
    installBenchBridge(bridge, target);
    expect((target as Record<string, unknown>)[BENCH_GLOBAL]).toBe(bridge);
  });
});
