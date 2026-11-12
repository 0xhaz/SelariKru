import { describe, expect, it } from 'vitest';
import { integrationsOff } from './integrations.ts';

describe('H9 fix round 1 (I4): one check for "integrations are off"', () => {
  it('is true only when the snapshot says coding workers are off', () => {
    expect(integrationsOff({ modelCatalog: { codingWorkers: 'off' } })).toBe(true);
    expect(integrationsOff({ modelCatalog: { codingWorkers: 'claude_code' } })).toBe(false);
  });
  it('with no snapshot it hides nothing', () => {
    expect(integrationsOff(null)).toBe(false);
    expect(integrationsOff(undefined)).toBe(false);
  });
});
